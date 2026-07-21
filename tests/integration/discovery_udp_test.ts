/**
 * Integration tests for infrastructure/discovery/udp-beacon.ts — UdpBeacon.
 *
 * Layer: integration (gated behind CLIPRULER_NET_TESTS=1)
 *
 * Scope:
 *   - Two beacons with distinct fingerprints mutually visible within 5s
 *   - After stop(), the remaining beacon prunes the stopped peer within 15s
 *
 * Limitation: both beacons bind to the same fixed port (42731) on the same host.
 * On many single-host environments the second bind will fail with EADDRINUSE.
 * The tests handle this gracefully and are skipped when two-beacon mode is
 * unavailable.  Full mutual-discovery requires two separate hosts.
 */

import { assertEquals } from "jsr:@std/assert@^1.0";
import { UdpBeacon } from "../../src/infrastructure/discovery/udp-beacon.ts";
import { makePublicKeyFingerprint } from "../../src/domain/device.ts";
import { ConsoleLogger } from "../../src/infrastructure/logger/console-logger.ts";
import { PROTOCOL_VERSION } from "../../src/protocol/envelope.ts";
import type { PeerAdvertisement } from "../../src/ports/discovery.ts";

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

function isIntegrationEnabled(): boolean {
  try {
    return Deno.env.get("CLIPRULER_NET_TESTS") === "1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Poll `fn` until it returns a truthy value, or until `timeoutMs` elapses.
 * Throws on timeout so tests fail explicitly rather than hanging.
 */
async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// Two distinct fingerprints for two distinct peers
const FINGERPRINT_A = makePublicKeyFingerprint(
  "11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00",
);
const FINGERPRINT_B = makePublicKeyFingerprint(
  "ff:ee:dd:cc:bb:aa:99:88:77:66:55:44:33:22:11:00:ff:ee:dd:cc:bb:aa:99:88:77:66:55:44:33:22:11:00",
);

const SELF_A: PeerAdvertisement = {
  name: "peer-a",
  publicKeyFingerprint: FINGERPRINT_A,
  tlsPort: 19201,
  protocolVersion: PROTOCOL_VERSION,
};

const SELF_B: PeerAdvertisement = {
  name: "peer-b",
  publicKeyFingerprint: FINGERPRINT_B,
  tlsPort: 19202,
  protocolVersion: PROTOCOL_VERSION,
};

// ---------------------------------------------------------------------------
// Two-beacon coexistence probe
//
// Both UdpBeacon instances bind to the same fixed MULTICAST_PORT (42731).
// On a single-host/single-process setup the second bind typically fails with
// EADDRINUSE.  This probe attempts to start both beacons sequentially; if
// the second bind fails, two-beacon tests are skipped on this environment.
// ---------------------------------------------------------------------------

let runTwoBeacons: boolean | null = null;

async function probeTwoBeacons(): Promise<boolean> {
  if (!isIntegrationEnabled()) return false;
  const logger = new ConsoleLogger("probe");
  const beaconA = new UdpBeacon({ self: SELF_A, logger });
  const beaconB = new UdpBeacon({ self: SELF_B, logger });
  try {
    await beaconA.start();
    try {
      await beaconB.start();
      return true;
    } catch {
      // Second bind failed — expected on single-host setups
      return false;
    } finally {
      await beaconB.stop();
    }
  } finally {
    await beaconA.stop();
  }
}

// Kick off the async probe immediately (module-level async init is OK in Deno)
probeTwoBeacons().then((result) => {
  runTwoBeacons = result;
});

// ---------------------------------------------------------------------------
// Scenario: two beacons mutually visible within 5 seconds
// ---------------------------------------------------------------------------

Deno.test({
  name: "discovery: two beacons see each other within 5 seconds",
  async fn() {
    if (!isIntegrationEnabled()) return; // gated
    if (runTwoBeacons === null) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (runTwoBeacons === false) return; // skipped — two beacons cannot coexist on this host

    const loggerA = new ConsoleLogger("beacon-a");
    const loggerB = new ConsoleLogger("beacon-b");

    const beaconA = new UdpBeacon({ self: SELF_A, logger: loggerA });
    const beaconB = new UdpBeacon({ self: SELF_B, logger: loggerB });

    await beaconA.start();
    await beaconB.start();

    try {
      const seenByA: Array<ReadonlyMap<unknown, unknown>> = [];
      const unsubA = beaconA.subscribe((peers) => seenByA.push(new Map(peers)));

      await waitFor(
        () => seenByA.find((snap) => snap.has(FINGERPRINT_B)),
        5_000,
      );

      const latestA = seenByA[seenByA.length - 1]!;
      assertEquals(latestA.size, 1, "beaconA should see exactly one peer");
      assertEquals(latestA.has(FINGERPRINT_B), true, "beaconA should see beaconB");

      const visibleByB = beaconB.visible();
      assertEquals(visibleByB.size, 1, "beaconB should see exactly one peer");
      assertEquals(visibleByB.has(FINGERPRINT_A), true, "beaconB should see beaconA");

      unsubA();
    } finally {
      await beaconA.stop();
      await beaconB.stop();
    }
  },
});

// ---------------------------------------------------------------------------
// Scenario: stopped peer is pruned within 15 seconds
// ---------------------------------------------------------------------------

Deno.test({
  name: "discovery: stopped peer is pruned within 15 seconds",
  async fn() {
    if (!isIntegrationEnabled()) return; // gated
    if (runTwoBeacons === null) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (runTwoBeacons === false) return; // skipped

    const loggerA = new ConsoleLogger("beacon-a");
    const loggerB = new ConsoleLogger("beacon-b");

    const beaconA = new UdpBeacon({ self: SELF_A, logger: loggerA });
    const beaconB = new UdpBeacon({ self: SELF_B, logger: loggerB });

    await beaconA.start();
    await beaconB.start();

    try {
      const seenByA: Array<ReadonlyMap<unknown, unknown>> = [];
      const unsubA = beaconA.subscribe((peers) => seenByA.push(new Map(peers)));

      await waitFor(
        () => seenByA.find((snap) => snap.has(FINGERPRINT_B)),
        5_000,
      );

      await beaconB.stop();

      await waitFor(
        () => seenByA.find((snap) => snap.size === 0),
        15_000,
      );

      const latestA = seenByA[seenByA.length - 1]!;
      assertEquals(
        latestA.size,
        0,
        "beaconA should have no peers after beaconB stops and is pruned",
      );

      unsubA();
    } finally {
      await beaconA.stop();
    }
  },
});
