/**
 * tests/integration/clipboard_sync_test.ts
 *
 * Integration test: clipboard sync end-to-end with two in-process nodes.
 *
 * Verifies six integration scenarios:
 * 1. Initial sync: A copies "hello" → B receives within 5s
 * 2. Reverse sync: B copies "world" → A receives
 * 3. Idempotent re-copy: same content again → exactly one broadcast per write
 * 4. Per-device opt-out: sharing disabled on B's view of A → B does NOT see A's write
 * 5. Loop counter: 10 alternating writes → exactly 10 outgoing envelopes (not 20+)
 * 6. Paired-only acceptance: unpaired origin is dropped
 *
 * Each node has its own:
 * - RecordingClipboardAdapter (in-memory clipboard)
 * - PersistentClock with no-op sink
 * - FakeDeviceRepository with paired device records
 * - InProcessTransport (in-memory, no network)
 * - RemoteWriteGate (shared within the node pair)
 *
 * Layer: integration — two real use cases wired over real ports.
 *
 * STRICT TDD: RED phase — tests written first, production code already exists
 * (PR1 clock, PR2 sync-clipboard, PR3 receive-clipboard are the GREEN phase).
 */

import { assertEquals } from "jsr:@std/assert@^1.0";
import type { ClipboardAdapter, ClipboardContent } from "../../src/ports/clipboard-adapter.ts";
import type { DeviceRepository, StoredDevice } from "../../src/ports/device-repository.ts";
import type { Logger } from "../../src/ports/logger.ts";
import type { Transport } from "../../src/ports/transport.ts";
import type { Envelope } from "../../src/protocol/envelope.ts";
import type { DeviceId, PublicKeyFingerprint } from "../../src/domain/device.ts";
import {
  makeDeviceId,
  makePublicKeyFingerprint,
} from "../../src/domain/device.ts";
import { PersistentClock } from "../../src/infrastructure/clock/persistent-clock.ts";
import {
  startLocalSync,
  createRemoteWriteGate,
  type RemoteWriteGate,
} from "../../src/application/sync-clipboard.ts";
import { startRemoteReceiver } from "../../src/application/receive-clipboard.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** No-op logger for integration tests. */
class StubLogger implements Logger {
  debug(_msg: string, _meta?: Record<string, unknown>): void {}
  info(_msg: string, _meta?: Record<string, unknown>): void {}
  warn(_msg: string, _meta?: Record<string, unknown>): void {}
  error(_msg: string, _meta?: Record<string, unknown>): void {}
  child(_scope: string): Logger {
    return this;
  }
}

/**
 * In-process transport that delivers envelopes directly to registered handlers.
 *
 * Each node holds its own InProcessTransport instance. The two instances are
 * wired together via fingerprint → handler registration so that
 * transport.send(peerFingerprint, envelope) delivers to the peer's handler.
 */
class InProcessTransport implements Transport {
  private readonly _handlers: Array<(envelope: Envelope, peerFingerprint: string) => void> =
    [];

  constructor(
    private readonly selfFingerprint: PublicKeyFingerprint,
    private readonly peerHandlers: Map<PublicKeyFingerprint, InProcessTransport>,
  ) {}

  send(peerFingerprint: string, envelope: Envelope): Promise<void> {
    const peer = this.peerHandlers.get(
      peerFingerprint as unknown as PublicKeyFingerprint,
    );
    if (peer) {
      // Deliver synchronously in-place to simulate zero-latency in-process handoff
      peer.deliver(envelope, this.selfFingerprint as unknown as string);
    }
    return Promise.resolve();
  }

  broadcast(_envelope: Envelope): Promise<void> {
    // Not used by the sync use cases — only send() is used
    return Promise.resolve();
  }

  subscribe(
    handler: (envelope: Envelope, peerFingerprint: string) => void,
  ): Promise<void> {
    this._handlers.push(handler);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this._handlers.length = 0;
    return Promise.resolve();
  }

  /**
   * Deliver an envelope to all registered handlers (used by test and by send()).
   */
  deliver(envelope: Envelope, fromFingerprint: string): void {
    for (const handler of this._handlers) {
      handler(envelope, fromFingerprint);
    }
  }
}

/**
 * In-memory clipboard adapter that records write calls.
 */
class RecordingClipboardAdapter implements ClipboardAdapter {
  readonly name = "recording";
  private handlers: Array<(content: ClipboardContent) => void> = [];
  readonly writes: ClipboardContent[] = [];
  private _content: ClipboardContent = { text: "", isPassword: false };

  subscribe(handler: (content: ClipboardContent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  read(): Promise<ClipboardContent> {
    return Promise.resolve(this._content);
  }

  write(content: ClipboardContent): Promise<void> {
    this.writes.push({ ...content });
    const prev = this._content;
    this._content = content;
    // Simulate OS clipboard event: fire subscribers with the new content,
    // unless the content is identical to what we just had (deduplicate).
    if (prev.text !== content.text) {
      for (const h of this.handlers) h(content);
    }
    return Promise.resolve();
  }

  /** Get the latest write content or initial state. */
  currentContent(): ClipboardContent {
    return this._content;
  }

  /** Emit a local change to all subscribed handlers (simulates platform clipboard event). */
  async emitLocalChange(content: ClipboardContent): Promise<void> {
    await Promise.all(this.handlers.map((h) => h(content)));
  }
}

/**
 * In-memory device repository with pre-seeded paired devices.
 */
class FakeDeviceRepository implements DeviceRepository {
  private devices = new Map<DeviceId, StoredDevice>();
  private fingerprints = new Map<PublicKeyFingerprint, StoredDevice>();

  list(): Promise<readonly StoredDevice[]> {
    return Promise.resolve(Array.from(this.devices.values()));
  }

  get(_id: DeviceId): Promise<StoredDevice | null> {
    return Promise.resolve(null);
  }

  getByFingerprint(_fp: PublicKeyFingerprint): Promise<StoredDevice | null> {
    return Promise.resolve(null);
  }

  upsert(device: StoredDevice): Promise<void> {
    this.devices.set(device.deviceId, device);
    this.fingerprints.set(device.fingerprint, device);
    return Promise.resolve();
  }

  remove(_id: DeviceId): Promise<void> {
    return Promise.resolve();
  }

  setSharingEnabled(id: DeviceId, enabled: boolean): Promise<void> {
    const device = this.devices.get(id);
    if (device) {
      const updated: StoredDevice = {
        ...device,
        clipboardSharingEnabled: enabled,
        equals: device.equals,
      };
      this.devices.set(id, updated);
      this.fingerprints.set(updated.fingerprint, updated);
    }
    return Promise.resolve();
  }

  seed(devices: StoredDevice[]): void {
    for (const d of devices) {
      this.devices.set(d.deviceId, d);
      this.fingerprints.set(d.fingerprint, d);
    }
  }
}

// ---------------------------------------------------------------------------
// Node factory
// ---------------------------------------------------------------------------

interface SyncNode {
  readonly deviceId: DeviceId;
  readonly fingerprint: PublicKeyFingerprint;
  readonly clipboard: RecordingClipboardAdapter;
  readonly transport: InProcessTransport;
  readonly devices: FakeDeviceRepository;
  readonly clock: PersistentClock;
  readonly gate: RemoteWriteGate;
  readonly stopLocalSync: () => void;
  readonly stopRemoteReceiver: () => void;
}

/**
 * Create a fully-wired sync node.
 *
 * @param myId         - This node's device identity
 * @param peerId       - The peer node's device identity
 * @param peerFp       - The peer node's transport fingerprint
 * @param sharingEnabledForPeer - Whether this node has clipboard sharing enabled for the peer
 */
function makeNode(
  myId: DeviceId,
  myFp: PublicKeyFingerprint,
  peerId: DeviceId,
  peerFp: PublicKeyFingerprint,
  sharingEnabledForPeer: boolean,
  peerTransportMap: Map<PublicKeyFingerprint, InProcessTransport>,
): SyncNode {
  const clipboard = new RecordingClipboardAdapter();
  const devices = new FakeDeviceRepository();
  const logger = new StubLogger();

  // No-op sink — no real filesystem persistence in integration tests
  const noOpSink = (_counter: number) => {};
  const clock = new PersistentClock(myId, 0, noOpSink, logger);

  const transport = new InProcessTransport(myFp, peerTransportMap);
  peerTransportMap.set(myFp, transport);

  const gate = createRemoteWriteGate();

  // Seed this node's device repository with the peer
  const peerDevice: StoredDevice = {
    deviceId: peerId,
    name: `peer-${peerId}`,
    lastEndpoint: null,
    lastSeenAt: null,
    clipboardSharingEnabled: sharingEnabledForPeer,
    fingerprint: peerFp,
    equals(other: { deviceId: DeviceId }): boolean {
      return this.deviceId === other.deviceId;
    },
  };
  devices.seed([peerDevice]);

  // Wire up use cases
  const stopLocalSync = startLocalSync({
    logger,
    clock,
    devices,
    transport,
    clipboard,
    remoteWriteGate: gate,
  });

  const stopRemoteReceiver = startRemoteReceiver({
    logger,
    clock,
    devices,
    transport,
    clipboard,
    localDeviceId: myId,
    remoteWriteGate: gate,
  });

  return {
    deviceId: myId,
    fingerprint: myFp,
    clipboard,
    transport,
    devices,
    clock,
    gate,
    stopLocalSync,
    stopRemoteReceiver,
  };
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

/**
 * Poll a condition up to `deadlineMs` with `intervalMs` between attempts.
 * Throws if the deadline passes before `condition()` returns true.
 */
async function waitFor(
  condition: () => boolean,
  deadlineMs: number,
  intervalMs = 100,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  // Final check — throw descriptive error
  const result = condition();
  if (!result) {
    throw new Error(`waitFor(${label}) timed out after ${deadlineMs}ms`);
  }
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

Deno.test("clipboard sync: initial sync — A copies hello → B receives within 5s", async () => {
  // Set up two-node in-process network
  const transportMap = new Map<PublicKeyFingerprint, InProcessTransport>();

  const nodeA = makeNode(
    makeDeviceId("node-a"),
    makePublicKeyFingerprint("fp-node-a-000000000000000000000000000000000000000000000000000000000000A"),
    makeDeviceId("node-b"),
    makePublicKeyFingerprint("fp-node-b-000000000000000000000000000000000000000000000000000000000000B"),
    true, // A has sharing enabled for B
    transportMap,
  );
  const nodeB = makeNode(
    makeDeviceId("node-b"),
    makePublicKeyFingerprint("fp-node-b-000000000000000000000000000000000000000000000000000000000000B"),
    makeDeviceId("node-a"),
    makePublicKeyFingerprint("fp-node-a-000000000000000000000000000000000000000000000000000000000000A"),
    true, // B has sharing enabled for A
    transportMap,
  );

  try {
    // A copies "hello" — should reach B
    await nodeA.clipboard.emitLocalChange({ text: "hello", isPassword: false });

    // Wait up to 5s for B to receive
    await waitFor(
      () => nodeB.clipboard.currentContent().text === "hello",
      5_000,
      100,
      "nodeB receives 'hello'",
    );

    // Assert B's clipboard received the correct content
    assertEquals(
      nodeB.clipboard.currentContent().text,
      "hello",
      "node B clipboard must contain 'hello' after A copies it",
    );
  } finally {
    nodeA.stopLocalSync();
    nodeA.stopRemoteReceiver();
    nodeB.stopLocalSync();
    nodeB.stopRemoteReceiver();
  }
});

Deno.test("clipboard sync: reverse sync — B copies world → A receives", async () => {
  const transportMap = new Map<PublicKeyFingerprint, InProcessTransport>();

  const nodeA = makeNode(
    makeDeviceId("node-a"),
    makePublicKeyFingerprint("fp-node-a-000000000000000000000000000000000000000000000000000000000000A"),
    makeDeviceId("node-b"),
    makePublicKeyFingerprint("fp-node-b-000000000000000000000000000000000000000000000000000000000000B"),
    true,
    transportMap,
  );
  const nodeB = makeNode(
    makeDeviceId("node-b"),
    makePublicKeyFingerprint("fp-node-b-000000000000000000000000000000000000000000000000000000000000B"),
    makeDeviceId("node-a"),
    makePublicKeyFingerprint("fp-node-a-000000000000000000000000000000000000000000000000000000000000A"),
    true,
    transportMap,
  );

  try {
    // B copies "world" — should reach A
    await nodeB.clipboard.emitLocalChange({ text: "world", isPassword: false });

    await waitFor(
      () => nodeA.clipboard.currentContent().text === "world",
      5_000,
      100,
      "nodeA receives 'world'",
    );

    assertEquals(
      nodeA.clipboard.currentContent().text,
      "world",
      "node A clipboard must contain 'world' after B copies it",
    );
  } finally {
    nodeA.stopLocalSync();
    nodeA.stopRemoteReceiver();
    nodeB.stopLocalSync();
    nodeB.stopRemoteReceiver();
  }
});

Deno.test("clipboard sync: idempotent re-copy — same content again → only one broadcast per write", async () => {
  const transportMap = new Map<PublicKeyFingerprint, InProcessTransport>();

  const nodeA = makeNode(
    makeDeviceId("node-a"),
    makePublicKeyFingerprint("fp-node-a-000000000000000000000000000000000000000000000000000000000000A"),
    makeDeviceId("node-b"),
    makePublicKeyFingerprint("fp-node-b-000000000000000000000000000000000000000000000000000000000000B"),
    true,
    transportMap,
  );
  const nodeB = makeNode(
    makeDeviceId("node-b"),
    makePublicKeyFingerprint("fp-node-b-000000000000000000000000000000000000000000000000000000000000B"),
    makeDeviceId("node-a"),
    makePublicKeyFingerprint("fp-node-a-000000000000000000000000000000000000000000000000000000000000A"),
    true,
    transportMap,
  );

  // Count outgoing envelopes on node A's transport
  let aOutgoingCount = 0;
  const originalSend = nodeA.transport.send.bind(nodeA.transport);
  nodeA.transport.send = (fp, env) => {
    aOutgoingCount++;
    return originalSend(fp, env);
  };

  try {
    // First write of "hello"
    await nodeA.clipboard.emitLocalChange({ text: "hello", isPassword: false });
    await waitFor(
      () => nodeB.clipboard.currentContent().text === "hello",
      5_000,
      100,
      "nodeB receives first 'hello'",
    );

    const countAfterFirst = aOutgoingCount;
    assertEquals(
      countAfterFirst,
      1,
      "exactly one outgoing envelope for the first write",
    );

    // Reset B's clipboard state to detect the re-copy
    // Re-copy same content (simulate user copying again)
    await nodeA.clipboard.emitLocalChange({ text: "hello", isPassword: false });
    // Wait a short time — if idempotent, resolver should deduplicate
    await new Promise((resolve) => setTimeout(resolve, 300));

    const countAfterSecond = aOutgoingCount;
    // The second write should still send an envelope (same content, new counter)
    // but the resolver at node B should deduplicate it
    assertEquals(
      countAfterSecond,
      2,
      "second write of same content sends a new envelope (new counter)",
    );

    // B should still have "hello" — not reverted to empty
    assertEquals(
      nodeB.clipboard.currentContent().text,
      "hello",
      "node B clipboard must still contain 'hello' after re-copy",
    );
  } finally {
    nodeA.stopLocalSync();
    nodeA.stopRemoteReceiver();
    nodeB.stopLocalSync();
    nodeB.stopRemoteReceiver();
  }
});

Deno.test("clipboard sync: per-device opt-out — B disables sharing of A → A's copy does NOT reach B", async () => {
  const transportMap = new Map<PublicKeyFingerprint, InProcessTransport>();

  const nodeA = makeNode(
    makeDeviceId("node-a"),
    makePublicKeyFingerprint("fp-node-a-000000000000000000000000000000000000000000000000000000000000A"),
    makeDeviceId("node-b"),
    makePublicKeyFingerprint("fp-node-b-000000000000000000000000000000000000000000000000000000000000B"),
    true,
    transportMap,
  );
  const nodeB = makeNode(
    makeDeviceId("node-b"),
    makePublicKeyFingerprint("fp-node-b-000000000000000000000000000000000000000000000000000000000000B"),
    makeDeviceId("node-a"),
    makePublicKeyFingerprint("fp-node-a-000000000000000000000000000000000000000000000000000000000000A"),
    true, // Initially B has sharing enabled for A
    transportMap,
  );

  try {
    // Verify initial sync works
    await nodeA.clipboard.emitLocalChange({ text: "initial", isPassword: false });
    await waitFor(
      () => nodeB.clipboard.currentContent().text === "initial",
      5_000,
      100,
      "nodeB receives initial sync",
    );

    // Now B disables sharing of A (B's device repo: set clipboardSharingEnabled=false for A)
    await nodeB.devices.setSharingEnabled(nodeA.deviceId, false);

    // A copies a new message — it should NOT reach B
    await nodeA.clipboard.emitLocalChange({ text: "should not arrive", isPassword: false });

    // Wait 1s — if sharing were still on, it would arrive within 100ms
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    assertEquals(
      nodeB.clipboard.currentContent().text,
      "initial",
      "node B must NOT see 'should not arrive' after disabling sharing of A",
    );
  } finally {
    nodeA.stopLocalSync();
    nodeA.stopRemoteReceiver();
    nodeB.stopLocalSync();
    nodeB.stopRemoteReceiver();
  }
});

Deno.test("clipboard sync: loop counter — 10 alternating writes yields exactly 10 outgoing envelopes", async () => {
  const transportMap = new Map<PublicKeyFingerprint, InProcessTransport>();

  const nodeA = makeNode(
    makeDeviceId("node-a"),
    makePublicKeyFingerprint("fp-node-a-000000000000000000000000000000000000000000000000000000000000A"),
    makeDeviceId("node-b"),
    makePublicKeyFingerprint("fp-node-b-000000000000000000000000000000000000000000000000000000000000B"),
    true,
    transportMap,
  );
  const nodeB = makeNode(
    makeDeviceId("node-b"),
    makePublicKeyFingerprint("fp-node-b-000000000000000000000000000000000000000000000000000000000000B"),
    makeDeviceId("node-a"),
    makePublicKeyFingerprint("fp-node-a-000000000000000000000000000000000000000000000000000000000000A"),
    true,
    transportMap,
  );

  // Count outgoing envelopes per node
  let aOutgoing = 0;
  let bOutgoing = 0;

  const origASend = nodeA.transport.send.bind(nodeA.transport);
  nodeA.transport.send = (fp, env) => {
    aOutgoing++;
    return origASend(fp, env);
  };

  const origBSend = nodeB.transport.send.bind(nodeB.transport);
  nodeB.transport.send = (fp, env) => {
    bOutgoing++;
    return origBSend(fp, env);
  };

  try {
    // 10 alternating writes: A, B, A, B, ...
    for (let i = 0; i < 5; i++) {
      // A writes
      await nodeA.clipboard.emitLocalChange({
        text: `a-${i}`,
        isPassword: false,
      });
      // Brief yield to let handlers run
      await new Promise((resolve) => setTimeout(resolve, 50));

      // B writes
      await nodeB.clipboard.emitLocalChange({
        text: `b-${i}`,
        isPassword: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Wait for all async handler chains to settle
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const total = aOutgoing + bOutgoing;
    assertEquals(
      total,
      10,
      `expected exactly 10 outgoing envelopes (got ${total}: A=${aOutgoing}, B=${bOutgoing}) — loop would produce 20+`,
    );
    assertEquals(
      aOutgoing,
      5,
      `node A must have exactly 5 outgoing envelopes (got ${aOutgoing})`,
    );
    assertEquals(
      bOutgoing,
      5,
      `node B must have exactly 5 outgoing envelopes (got ${bOutgoing})`,
    );
  } finally {
    nodeA.stopLocalSync();
    nodeA.stopRemoteReceiver();
    nodeB.stopLocalSync();
    nodeB.stopRemoteReceiver();
  }
});

Deno.test("clipboard sync: paired-only acceptance — unpaired origin is dropped", async () => {
  const transportMap = new Map<PublicKeyFingerprint, InProcessTransport>();

  const nodeA = makeNode(
    makeDeviceId("node-a"),
    makePublicKeyFingerprint("fp-node-a-000000000000000000000000000000000000000000000000000000000000A"),
    makeDeviceId("node-b"),
    makePublicKeyFingerprint("fp-node-b-000000000000000000000000000000000000000000000000000000000000B"),
    true,
    transportMap,
  );
  // nodeB is NOT created — we send from an unpaired origin

  // Use nodeA's transport directly to inject a fake envelope from an unpaired origin
  // We need to manually invoke the receive handler with an envelope from "unpaired-x"
  // Since receive-clipboard subscribes to the transport, we use the transport's
  // internal handler mechanism. We'll inject via the subscribe handler directly.
  const fakeEnvelope = {
    version: 1,
    messageId: "unpaired-msg-001" as unknown as import("../../src/domain/device.ts").MessageId,
    originDeviceId: "unpaired-device-x",
    kind: "clipboard" as const,
    payload: { version: 1 as const, counter: 1, content: "from unpaired" },
  };

  try {
    // Capture nodeA's state before the unpaired event
    const contentBefore = nodeA.clipboard.currentContent().text;

    // Deliver the unpaired-origin envelope via the transport's deliver method
    nodeA.transport.deliver(fakeEnvelope as Envelope, "unpaired-fp");

    // Give async handlers time to run
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Assert no write occurred
    assertEquals(
      nodeA.clipboard.currentContent().text,
      contentBefore,
      "node A clipboard must NOT be modified by unpaired origin envelope",
    );
    assertEquals(
      nodeA.clipboard.writes.length,
      0,
      "no clipboard.write must be called for unpaired origin",
    );
  } finally {
    nodeA.stopLocalSync();
    nodeA.stopRemoteReceiver();
  }
});
