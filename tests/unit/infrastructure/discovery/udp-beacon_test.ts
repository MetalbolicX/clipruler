/**
 * Unit tests for infrastructure/discovery/udp-beacon.ts — UdpBeacon adapter.
 *
 * Layer: unit.
 * All tests use injected fakes — NO network, NO --allow-net.
 *
 * Strict TDD: RED phase — tests written before implementation.
 */

import { assertEquals } from "jsr:@std/assert@^1.0";
import type { Logger } from "../../../../src/ports/logger.ts";
import type { PeerAdvertisement } from "../../../../src/ports/discovery.ts";
import { makePublicKeyFingerprint } from "../../../../src/domain/device.ts";
import { PROTOCOL_VERSION } from "../../../../src/protocol/envelope.ts";

// ---------------------------------------------------------------------------
// Fake logger
// ---------------------------------------------------------------------------

const fakeLogs: { debug: string[]; warn: string[]; error: string[] } = {
  debug: [],
  warn: [],
  error: [],
};

const FAKE_LOGGER: Logger = {
  debug: (msg) => {
    fakeLogs.debug.push(msg);
  },
  info: (_msg) => {},
  warn: (msg) => {
    fakeLogs.warn.push(msg);
  },
  error: (msg) => {
    fakeLogs.error.push(msg);
  },
  child: (_scope) => FAKE_LOGGER,
};

// ---------------------------------------------------------------------------
// Fake DatagramConn and listenDatagram factory
// ---------------------------------------------------------------------------

interface SentPacket {
  data: Uint8Array;
  addr: { hostname: string; port: number; transport: string };
}

/** A minimal fake DatagramConn for testing — does NOT implement Deno.DatagramConn. */
interface FakeDatagramConn {
  readonly sent: SentPacket[];
  injectDatagrams(
    datagrams: Array<[Uint8Array, { hostname: string; port: number; transport: string }]>,
  ): void;
  reset(): void;
  close(): void;
  joinMulticastV4(address: string, iface: string): void;
  get addr(): { transport: string; hostname: string; port: number };
  [Symbol.asyncIterator](): AsyncIterator<
    [Uint8Array, { hostname: string; port: number; transport: string }]
  >;
}

/** Create a fake listenDatagram for network-free testing. */
function makeFakeListenDatagram(
  cannedDatagrams: Array<[Uint8Array, { hostname: string; port: number; transport: string }]> = [],
): {
  listenDatagram: (
    options: { port: number; hostname: string; transport: string },
  ) => FakeDatagramConn;
  fakeConn: FakeDatagramConn;
} {
  class FakeDatagramConnImpl implements FakeDatagramConn {
    readonly sent: SentPacket[] = [];
    #injected: Array<[Uint8Array, { hostname: string; port: number; transport: string }]> = [
      ...cannedDatagrams,
    ];
    #yieldIndex = 0;
    #closed = false;

    injectDatagrams(
      datagrams: Array<[Uint8Array, { hostname: string; port: number; transport: string }]>,
    ): void {
      this.#injected = [...datagrams];
      this.#yieldIndex = 0;
    }

    reset(): void {
      this.sent.length = 0;
      this.#injected = [];
      this.#yieldIndex = 0;
      this.#closed = false;
    }

    send(
      data: Uint8Array,
      addr: { hostname: string; port: number; transport?: string },
    ): Promise<number> {
      this.sent.push({
        data: data.slice(),
        addr: { hostname: addr.hostname, port: addr.port, transport: addr.transport ?? "udp" },
      });
      return Promise.resolve(data.byteLength);
    }

    close(): void {
      this.#closed = true;
    }

    get addr(): { transport: string; hostname: string; port: number } {
      return { transport: "udp", hostname: "0.0.0.0", port: 42731 };
    }

    joinMulticastV4(_address: string, _iface: string): void {
      // no-op for fake
    }

    /** Bound next — arrow property ensures correct `this` binding without aliasing. */
    readonly #iterNext = (): Promise<
      IteratorResult<[Uint8Array, { hostname: string; port: number; transport: string }]>
    > => {
      if (this.#closed) {
        return Promise.resolve({ done: true, value: undefined } as IteratorResult<
          [Uint8Array, { hostname: string; port: number; transport: string }]
        >);
      }
      if (this.#yieldIndex < this.#injected.length) {
        const item = this.#injected[this.#yieldIndex]!;
        this.#yieldIndex++;
        return Promise.resolve({ done: false, value: item });
      }
      return Promise.resolve({ done: true, value: undefined } as IteratorResult<
        [Uint8Array, { hostname: string; port: number; transport: string }]
      >);
    };

    /**
     * Non-blocking async iterator.
     * Yields the next queued datagram, or undefined if the queue is empty.
     * This prevents the iterator from "draining" and closing between inject batches.
     */
    [Symbol.asyncIterator](): AsyncIterator<
      [Uint8Array, { hostname: string; port: number; transport: string }]
    > {
      return { next: this.#iterNext };
    }
  }

  const fakeConn: FakeDatagramConn = new FakeDatagramConnImpl();

  // The real Deno.listenDatagram is sync, so our fake is too
  const listenDatagram = (
    _options: { port: number; hostname: string; transport: string },
  ): FakeDatagramConn => {
    return fakeConn;
  };

  return { listenDatagram, fakeConn };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SELF_AD: PeerAdvertisement = Object.freeze({
  name: "SelfDevice",
  publicKeyFingerprint: makePublicKeyFingerprint("self-fingerprint-0000"),
  tlsPort: 19201,
  protocolVersion: PROTOCOL_VERSION,
});

const PEER_AD: PeerAdvertisement = Object.freeze({
  name: "PeerDevice",
  publicKeyFingerprint: makePublicKeyFingerprint("peer-fingerprint-0000"),
  tlsPort: 19202,
  protocolVersion: PROTOCOL_VERSION,
});

function encodeAd(ad: PeerAdvertisement): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    name: ad.name,
    publicKeyFingerprint: ad.publicKeyFingerprint,
    tlsPort: ad.tlsPort,
    protocolVersion: ad.protocolVersion,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("UdpBeacon: start() calls listenDatagram", async () => {
  const { listenDatagram, fakeConn } = makeFakeListenDatagram([]);
  fakeLogs.debug = [];
  fakeLogs.warn = [];

  const { UdpBeacon } = await import("../../../../src/infrastructure/discovery/udp-beacon.ts");

  let callCount = 0;
  const countingListenDatagram = (opts: { port: number; hostname: string; transport: string }) => {
    callCount++;
    return listenDatagram(opts);
  };

  const beacon = new UdpBeacon({
    self: SELF_AD,
    logger: FAKE_LOGGER,
    __testing: {
      listenDatagram: countingListenDatagram as unknown as typeof Deno.listenDatagram,
      now: () => 0,
    },
  });

  await beacon.start();

  assertEquals(callCount, 1, "listenDatagram should be called exactly once");
  assertEquals(fakeConn.sent.length >= 1, true, "a beacon should have been sent on start()");

  await beacon.stop();
});

Deno.test("UdpBeacon: start() sends one immediate beacon before returning", async () => {
  const { listenDatagram, fakeConn } = makeFakeListenDatagram([]);
  fakeLogs.debug = [];

  const { UdpBeacon } = await import("../../../../src/infrastructure/discovery/udp-beacon.ts");

  const beacon = new UdpBeacon({
    self: SELF_AD,
    logger: FAKE_LOGGER,
    __testing: {
      listenDatagram: listenDatagram as unknown as typeof Deno.listenDatagram,
      now: () => 0,
    },
  });

  await beacon.start();

  assertEquals(fakeConn.sent.length, 1, "start() should send exactly one beacon immediately");

  const decoded = JSON.parse(new TextDecoder().decode(fakeConn.sent[0]!.data));
  assertEquals(decoded.name, SELF_AD.name);
  assertEquals(decoded.publicKeyFingerprint, SELF_AD.publicKeyFingerprint);
  assertEquals(decoded.tlsPort, SELF_AD.tlsPort);
  assertEquals(decoded.protocolVersion, PROTOCOL_VERSION);

  await beacon.stop();
});

Deno.test("UdpBeacon: valid JSON beacon decoded and peer added to visible()", async () => {
  const { listenDatagram, fakeConn } = makeFakeListenDatagram([]);
  fakeLogs.debug = [];
  fakeConn.injectDatagrams([
    [encodeAd(PEER_AD), { hostname: "192.168.1.10", port: 49201, transport: "udp" }],
  ]);

  const { UdpBeacon } = await import("../../../../src/infrastructure/discovery/udp-beacon.ts");

  const beacon = new UdpBeacon({
    self: SELF_AD,
    logger: FAKE_LOGGER,
    __testing: {
      listenDatagram: listenDatagram as unknown as typeof Deno.listenDatagram,
      now: () => 1000,
    },
  });

  await beacon.start();

  // Allow recvLoop to process the injected datagram
  await new Promise<void>((resolve) => setTimeout(resolve, 30));

  const visible = beacon.visible();
  assertEquals(visible.size, 1, "visible() should contain one peer");
  const sighting = visible.get(PEER_AD.publicKeyFingerprint)!;
  assertEquals(sighting.advertisement.name, PEER_AD.name);
  assertEquals(sighting.advertisement.tlsPort, PEER_AD.tlsPort);

  await beacon.stop();
});

Deno.test("UdpBeacon: malformed JSON is tolerated — no crash, no peer added, debug logged", async () => {
  const { listenDatagram, fakeConn } = makeFakeListenDatagram([]);
  fakeLogs.debug = [];
  fakeConn.injectDatagrams([
    [new TextEncoder().encode("not valid json {{{"), {
      hostname: "192.168.1.10",
      port: 49201,
      transport: "udp",
    }],
    [new TextEncoder().encode(""), { hostname: "192.168.1.10", port: 49201, transport: "udp" }],
    [new TextEncoder().encode('{"name":"x","publicKeyFingerprint":"fp","tlsPort":9000}'), {
      hostname: "192.168.1.10",
      port: 49201,
      transport: "udp",
    }], // wrong protocol version
  ]);

  const { UdpBeacon } = await import("../../../../src/infrastructure/discovery/udp-beacon.ts");

  const beacon = new UdpBeacon({
    self: SELF_AD,
    logger: FAKE_LOGGER,
    __testing: {
      listenDatagram: listenDatagram as unknown as typeof Deno.listenDatagram,
      now: () => 1000,
    },
  });

  await beacon.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 60));

  assertEquals(beacon.visible().size, 0, "malformed JSON should not add any peer");
  assertEquals(
    fakeLogs.debug.length >= 1,
    true,
    "debug should be called for each malformed packet",
  );

  await beacon.stop();
});

Deno.test("UdpBeacon: self-beacon is suppressed — does not appear in visible()", async () => {
  const { listenDatagram, fakeConn } = makeFakeListenDatagram([]);
  fakeLogs.debug = [];
  fakeConn.injectDatagrams([
    [encodeAd(SELF_AD), { hostname: "127.0.0.1", port: 42731, transport: "udp" }],
  ]);

  const { UdpBeacon } = await import("../../../../src/infrastructure/discovery/udp-beacon.ts");

  const beacon = new UdpBeacon({
    self: SELF_AD,
    logger: FAKE_LOGGER,
    __testing: {
      listenDatagram: listenDatagram as unknown as typeof Deno.listenDatagram,
      now: () => 1000,
    },
  });

  await beacon.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 30));

  assertEquals(beacon.visible().size, 0, "self-beacon should not appear in visible()");

  await beacon.stop();
});

Deno.test("UdpBeacon: firstSeenAt is preserved on update, lastSeenAt is refreshed", async () => {
  const { listenDatagram, fakeConn } = makeFakeListenDatagram([]);
  fakeLogs.debug = [];

  const { UdpBeacon } = await import("../../../../src/infrastructure/discovery/udp-beacon.ts");

  let injectedTime = 1000;
  const injectedNow = () => injectedTime;

  const beacon = new UdpBeacon({
    self: SELF_AD,
    logger: FAKE_LOGGER,
    __testing: {
      listenDatagram: listenDatagram as unknown as typeof Deno.listenDatagram,
      now: injectedNow,
    },
  });

  // First sighting at t=1000
  fakeConn.injectDatagrams([
    [encodeAd(PEER_AD), { hostname: "192.168.1.10", port: 49201, transport: "udp" }],
  ]);
  await beacon.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  const first = beacon.visible().get(PEER_AD.publicKeyFingerprint)!;
  assertEquals(first.firstSeenAt, 1000);
  assertEquals(first.lastSeenAt, 1000);

  // Second sighting at t=2000
  injectedTime = 2000;
  fakeConn.injectDatagrams([
    [encodeAd(PEER_AD), { hostname: "192.168.1.10", port: 49201, transport: "udp" }],
  ]);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  const second = beacon.visible().get(PEER_AD.publicKeyFingerprint)!;
  assertEquals(second.firstSeenAt, 1000, "firstSeenAt should be preserved");
  assertEquals(second.lastSeenAt, 2000, "lastSeenAt should be updated");

  await beacon.stop();
});

Deno.test("UdpBeacon: visible() returns a defensive copy — mutating it does not affect internal state", async () => {
  const { listenDatagram, fakeConn } = makeFakeListenDatagram([]);
  fakeLogs.debug = [];
  fakeConn.injectDatagrams([
    [encodeAd(PEER_AD), { hostname: "192.168.1.10", port: 49201, transport: "udp" }],
  ]);

  const { UdpBeacon } = await import("../../../../src/infrastructure/discovery/udp-beacon.ts");

  const beacon = new UdpBeacon({
    self: SELF_AD,
    logger: FAKE_LOGGER,
    __testing: {
      listenDatagram: listenDatagram as unknown as typeof Deno.listenDatagram,
      now: () => 1000,
    },
  });

  await beacon.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  const snap1 = beacon.visible();
  assertEquals(snap1.size, 1);

  // Mutate the returned map
  (snap1 as Map<unknown, unknown>).set(makePublicKeyFingerprint("malicious"), {
    advertisement: SELF_AD,
    remoteAddress: "0.0.0.1:0",
    firstSeenAt: 0,
    lastSeenAt: 0,
  } as never);

  assertEquals(
    beacon.visible().size,
    1,
    "internal state should be unchanged after mutating snapshot",
  );

  await beacon.stop();
});

Deno.test("UdpBeacon: subscribe() listener is called on add", async () => {
  const { listenDatagram, fakeConn } = makeFakeListenDatagram([]);
  fakeLogs.debug = [];
  fakeConn.injectDatagrams([
    [encodeAd(PEER_AD), { hostname: "192.168.1.10", port: 49201, transport: "udp" }],
  ]);

  const { UdpBeacon } = await import("../../../../src/infrastructure/discovery/udp-beacon.ts");

  const beacon = new UdpBeacon({
    self: SELF_AD,
    logger: FAKE_LOGGER,
    __testing: {
      listenDatagram: listenDatagram as unknown as typeof Deno.listenDatagram,
      now: () => 1000,
    },
  });

  const snapshots: ReadonlyMap<unknown, unknown>[] = [];
  beacon.subscribe((peers) => snapshots.push(new Map(peers)));

  await beacon.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assertEquals(snapshots.length >= 1, true, "listener should be called at least once after start");

  await beacon.stop();
});

Deno.test("UdpBeacon: subscribe() listener is called on remove (prune)", async () => {
  const { listenDatagram, fakeConn } = makeFakeListenDatagram([]);
  fakeLogs.debug = [];

  fakeConn.injectDatagrams([
    [encodeAd(PEER_AD), { hostname: "192.168.1.10", port: 49201, transport: "udp" }],
  ]);

  const { UdpBeacon } = await import("../../../../src/infrastructure/discovery/udp-beacon.ts");

  let injectedTime = 1000;
  const injectedNow = () => injectedTime;

  const beacon = new UdpBeacon({
    self: SELF_AD,
    logger: FAKE_LOGGER,
    __testing: {
      listenDatagram: listenDatagram as unknown as typeof Deno.listenDatagram,
      now: injectedNow,
    },
  });

  const snapshots: ReadonlyMap<unknown, unknown>[] = [];
  beacon.subscribe((peers) => snapshots.push(new Map(peers)));

  await beacon.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assertEquals(beacon.visible().size, 1);

  // Advance clock past PEER_TIMEOUT_MS (10000ms) then call prune directly
  injectedTime = 20000;
  beacon.prune(); // Call directly for deterministic testing

  const hasEmptySnap = snapshots.some((s) => (s as Map<unknown, unknown>).size === 0);
  assertEquals(hasEmptySnap, true, "listener should be called with empty map after prune");

  await beacon.stop();
});

Deno.test("UdpBeacon: prune() removes peers older than PEER_TIMEOUT_MS", async () => {
  const { listenDatagram, fakeConn } = makeFakeListenDatagram([]);
  fakeLogs.debug = [];

  fakeConn.injectDatagrams([
    [encodeAd(PEER_AD), { hostname: "192.168.1.10", port: 49201, transport: "udp" }],
  ]);

  const { UdpBeacon } = await import("../../../../src/infrastructure/discovery/udp-beacon.ts");

  let injectedTime = 1000;
  const injectedNow = () => injectedTime;

  const beacon = new UdpBeacon({
    self: SELF_AD,
    logger: FAKE_LOGGER,
    __testing: {
      listenDatagram: listenDatagram as unknown as typeof Deno.listenDatagram,
      now: injectedNow,
    },
  });

  await beacon.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  assertEquals(beacon.visible().size, 1);

  // Advance time past PEER_TIMEOUT_MS then call prune directly
  injectedTime = 12000;
  beacon.prune();

  assertEquals(beacon.visible().size, 0, "peer should be pruned after PEER_TIMEOUT_MS");

  await beacon.stop();
});

Deno.test("UdpBeacon: stop() is idempotent — calling twice does not throw", async () => {
  const { listenDatagram } = makeFakeListenDatagram([]);

  const { UdpBeacon } = await import("../../../../src/infrastructure/discovery/udp-beacon.ts");

  const beacon = new UdpBeacon({
    self: SELF_AD,
    logger: FAKE_LOGGER,
    __testing: {
      listenDatagram: listenDatagram as unknown as typeof Deno.listenDatagram,
      now: () => 0,
    },
  });

  await beacon.start();
  await beacon.stop(); // First stop
  await beacon.stop(); // Second stop — should not throw
});

Deno.test("UdpBeacon: stop() clears timers and emits empty snapshot", async () => {
  const { listenDatagram } = makeFakeListenDatagram([]);

  const { UdpBeacon } = await import("../../../../src/infrastructure/discovery/udp-beacon.ts");

  const beacon = new UdpBeacon({
    self: SELF_AD,
    logger: FAKE_LOGGER,
    __testing: {
      listenDatagram: listenDatagram as unknown as typeof Deno.listenDatagram,
      now: () => 0,
    },
  });

  const snapshots: ReadonlyMap<unknown, unknown>[] = [];
  beacon.subscribe((peers) => snapshots.push(new Map(peers)));

  await beacon.start();
  await beacon.stop();

  // Verify stop emitted an empty snapshot
  const hasEmptySnap = snapshots.some((s) => (s as Map<unknown, unknown>).size === 0);
  assertEquals(hasEmptySnap, true, "stop() should emit an empty snapshot");
});
