/**
 * Unit tests for application/sync-clipboard.ts (outgoing sync).
 *
 * Verifies:
 * - Empty text change is ignored: no tick, no send
 * - Flat clipboard payload: {version: 1, counter, content} — no isPassword field
 * - Paired+sharing recipient filtering: only peers with clipboardSharingEnabled=true receive send()
 * - One-shot remote-write gate: when suppressed, no broadcast occurs
 *
 * Layer: unit — uses SpyTransport, FakeDeviceRepository, FakeClipboardAdapter, FakeGate.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type { ClipboardAdapter, ClipboardContent } from "../../../src/ports/clipboard-adapter.ts";
import type { DeviceRepository, StoredDevice } from "../../../src/ports/device-repository.ts";
import type { Logger } from "../../../src/ports/logger.ts";
import type { LogicalClock } from "../../../src/ports/logical-clock.ts";
import type { DeviceId, PublicKeyFingerprint } from "../../../src/domain/device.ts";
import {
  makeDeviceId,
  makeMessageId,
  makePublicKeyFingerprint,
} from "../../../src/domain/device.ts";
import type { Envelope } from "../../../src/protocol/envelope.ts";
import { makeEnvelope } from "../../../src/protocol/envelope.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Minimal ClipboardAdapter stub that records subscribe calls. */
class FakeClipboardAdapter implements ClipboardAdapter {
  readonly name = "fake";
  private handlers: Array<(content: ClipboardContent) => void> = [];

  subscribe(handler: (content: ClipboardContent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  read(): Promise<ClipboardContent> {
    return Promise.resolve({ text: "", isPassword: false });
  }

  write(_content: ClipboardContent): Promise<void> {
    return Promise.resolve();
  }

  /** Simulate a clipboard change event to all subscribed handlers. */
  async emit(content: ClipboardContent): Promise<void> {
    await Promise.all(this.handlers.map((h) => h(content)));
  }
}

/** Shared remote-write gate stub for testing. */
class FakeRemoteWriteGate {
  private suppressed = false;

  suppressNext(): void {
    this.suppressed = true;
  }

  wasArmed(): boolean {
    return this.suppressed;
  }

  isSuppressed(): boolean {
    const result = this.suppressed;
    this.suppressed = false; // one-shot
    return result;
  }
}

/** Minimal DeviceRepository stub that returns a canned device list. */
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
  setSharingEnabled(_id: DeviceId, _enabled: boolean): Promise<void> {
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
// Helpers
// ---------------------------------------------------------------------------

function makeStoredDevice(
  name: string,
  sharingEnabled: boolean,
): StoredDevice {
  const fpRaw = name.split("").map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")
    .padEnd(64, "0").slice(0, 64);
  const fp = makePublicKeyFingerprint(fpRaw);
  return {
    deviceId: makeDeviceId(`device-${name}`),
    name,
    lastEndpoint: null,
    lastSeenAt: null,
    clipboardSharingEnabled: sharingEnabled,
    fingerprint: fp,
    equals(other: { deviceId: DeviceId }): boolean {
      return this.deviceId === other.deviceId;
    },
  };
}

// ---------------------------------------------------------------------------
// Outgoing tests
// ---------------------------------------------------------------------------

Deno.test("outgoing: empty text change is ignored — no tick, no send", async () => {
  const clipboard = new FakeClipboardAdapter();
  const transport = new SpyTransport();
  const devices = new FakeDeviceRepository();
  const clock = new StubClock(0);
  const gate = new FakeRemoteWriteGate();
  const logger = new StubLogger();

  // Pre-seed a paired+sharing peer so send() would be called if not filtered
  const peer = makeStoredDevice("PeerB", true);
  await devices.upsert(peer);

  const { startLocalSync } = await import("../../../src/application/sync-clipboard.ts");
  const _stop = startLocalSync({
    clipboard,
    clock,
    devices,
    transport,
    logger,
    remoteWriteGate: gate,
  });

  // Emit empty text — must be ignored
  await clipboard.emit({ text: "", isPassword: false });

  assertEquals(clock.ticks, 0, "clock.tick must NOT be called for empty text");
  assertEquals(transport.calls.send.length, 0, "transport.send must NOT be called for empty text");
  assertEquals(gate.isSuppressed(), false, "gate must not be activated for empty text");

  _stop();
});

Deno.test("outgoing: non-empty change sends flat clipboard payload with no isPassword", async () => {
  const clipboard = new FakeClipboardAdapter();
  const transport = new SpyTransport();
  const devices = new FakeDeviceRepository();
  const clock = new StubClock(5);
  const gate = new FakeRemoteWriteGate();
  const logger = new StubLogger();

  const peer = makeStoredDevice("PeerB", true);
  await devices.upsert(peer);

  const { startLocalSync } = await import("../../../src/application/sync-clipboard.ts");
  const _stop = startLocalSync({
    clipboard,
    clock,
    devices,
    transport,
    logger,
    remoteWriteGate: gate,
  });

  await clipboard.emit({ text: "hello world", isPassword: false });

  assertEquals(clock.ticks, 1, "clock.tick must be called exactly once");
  assertEquals(
    transport.calls.send.length,
    1,
    "transport.send must be called for the one sharing peer",
  );

  const { peerFingerprint, envelope } = transport.calls.send[0]!;
  assertEquals(peerFingerprint, peer.fingerprint, "send must be to the correct peer fingerprint");
  assertEquals(envelope.kind, "clipboard", "envelope kind must be 'clipboard'");
  assertEquals(envelope.originDeviceId, clock.deviceId, "originDeviceId must match local device");

  const payload = envelope.payload as Record<string, unknown>;
  assertEquals(payload.version, 1, "payload version must be 1");
  assertEquals(payload.counter, 6, "payload counter must be clock tick result (5 + 1)");
  assertEquals(payload.content, "hello world", "payload content must match emitted text");
  assertEquals(
    Object.prototype.hasOwnProperty.call(payload, "isPassword"),
    false,
    "payload must NOT contain isPassword",
  );
});

Deno.test("outgoing: paired peer with clipboardSharingEnabled=false is skipped", async () => {
  const clipboard = new FakeClipboardAdapter();
  const transport = new SpyTransport();
  const devices = new FakeDeviceRepository();
  const clock = new StubClock(0);
  const gate = new FakeRemoteWriteGate();
  const logger = new StubLogger();

  // Two peers: one sharing, one not
  const sharingPeer = makeStoredDevice("SharingPeer", true);
  const mutedPeer = makeStoredDevice("MutedPeer", false);
  await devices.upsert(sharingPeer);
  await devices.upsert(mutedPeer);

  const { startLocalSync } = await import("../../../src/application/sync-clipboard.ts");
  const _stop = startLocalSync({
    clipboard,
    clock,
    devices,
    transport,
    logger,
    remoteWriteGate: gate,
  });

  await clipboard.emit({ text: "test", isPassword: false });

  assertEquals(transport.calls.send.length, 1, "exactly one send must occur");
  const { peerFingerprint } = transport.calls.send[0]!;
  assertEquals(
    peerFingerprint,
    sharingPeer.fingerprint,
    "only the sharing-enabled peer must receive the send",
  );
  assertEquals(
    peerFingerprint !== mutedPeer.fingerprint,
    true,
    "muted peer must not receive the send",
  );
});

Deno.test("outgoing: one-shot gate suppresses the next broadcast when suppressed", async () => {
  const clipboard = new FakeClipboardAdapter();
  const transport = new SpyTransport();
  const devices = new FakeDeviceRepository();
  const clock = new StubClock(0);
  const gate = new FakeRemoteWriteGate();
  const logger = new StubLogger();

  const peer = makeStoredDevice("PeerB", true);
  await devices.upsert(peer);

  const { startLocalSync } = await import("../../../src/application/sync-clipboard.ts");
  const _stop = startLocalSync({
    clipboard,
    clock,
    devices,
    transport,
    logger,
    remoteWriteGate: gate,
  });

  // Simulate a remote write just occurred — gate is now suppressed
  gate.suppressNext();

  await clipboard.emit({ text: "should be suppressed", isPassword: false });

  assertEquals(clock.ticks, 0, "clock.tick must NOT be called when gate is suppressed");
  assertEquals(
    transport.calls.send.length,
    0,
    "transport.send must NOT be called when gate is suppressed",
  );

  // Next event (gate now reset) should go through normally
  await clipboard.emit({ text: "normal event", isPassword: false });

  assertEquals(clock.ticks, 1, "clock.tick must be called after gate resets");
  assertEquals(transport.calls.send.length, 1, "transport.send must occur after gate resets");
  const { envelope } = transport.calls.send[0]!;
  const payload = envelope.payload as Record<string, unknown>;
  assertEquals(payload.content, "normal event");
});

// ---------------------------------------------------------------------------
// Incoming tests — receive-clipboard.ts
// ---------------------------------------------------------------------------

/**
 * Extended SpyTransport that can invoke registered subscribe handlers.
 * Used to simulate incoming transport events in tests.
 */
class TestableSpyTransport extends SpyTransport {
  /**
   * Invoke all registered subscribe handlers with the given envelope and peer fingerprint.
   */
  async invokeHandlers(envelope: Envelope, peerFingerprint = "test-peer"): Promise<void> {
    for (const { handler } of this.calls.subscribe) {
      await handler(envelope, peerFingerprint);
    }
  }
}

/**
 * ClipboardAdapter stub that records write calls.
 */
class RecordingClipboardAdapter implements ClipboardAdapter {
  readonly name = "recording";
  private handlers: Array<(content: ClipboardContent) => void> = [];
  readonly writes: Array<ClipboardContent> = [];

  subscribe(handler: (content: ClipboardContent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  read(): Promise<ClipboardContent> {
    return Promise.resolve({ text: "", isPassword: false });
  }

  write(content: ClipboardContent): Promise<void> {
    this.writes.push({ ...content });
    return Promise.resolve();
  }

  async emit(content: ClipboardContent): Promise<void> {
    await Promise.all(this.handlers.map((h) => h(content)));
  }
}

/**
 * Clock stub that records observe calls and tracks a counter.
 */
class RecordingClock implements LogicalClock {
  private _ticks = 0;
  private _counter: number;
  constructor(private _deviceId: DeviceId, initialCounter = 0) {
    this._counter = initialCounter;
  }

  get ticks(): number {
    return this._ticks;
  }

  get counter(): number {
    return this._counter;
  }

  get deviceId(): DeviceId {
    return this._deviceId;
  }

  tick(): Promise<number> {
    this._ticks++;
    this._counter++;
    return Promise.resolve(this._counter);
  }

  observe(remote: number): Promise<void> {
    if (remote > this._counter) {
      this._counter = remote;
    }
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Incoming tests
// ---------------------------------------------------------------------------

Deno.test("incoming: non-clipboard envelope kind is dropped — no write, no observe", async () => {
  const clipboard = new RecordingClipboardAdapter();
  const transport = new TestableSpyTransport();
  const devices = new FakeDeviceRepository();
  const clock = new RecordingClock(makeDeviceId("local-device"), 0);
  const gate = new FakeRemoteWriteGate();
  const logger = new StubLogger();

  // Seed one paired peer so trust check passes
  const peer = makeStoredDevice("PeerB", true);
  await devices.upsert(peer);

  const { startRemoteReceiver } = await import(
    "../../../src/application/receive-clipboard.ts"
  );
  startRemoteReceiver({
    logger,
    clock,
    devices,
    transport,
    clipboard,
    localDeviceId: makeDeviceId("local-device"),
    remoteWriteGate: gate,
  });

  // Send a "hello" kind envelope — should be filtered before any processing
  const helloEnvelope = makeEnvelope(
    peer.deviceId as unknown as string,
    "hello",
    { deviceName: "PeerB", protocolVersion: 1 },
  );
  await transport.invokeHandlers(helloEnvelope, peer.fingerprint as unknown as string);

  assertEquals(
    clipboard.writes.length,
    0,
    "clipboard.write must NOT be called for non-clipboard kind",
  );
  assertEquals(clock.ticks, 0, "clock.observe must NOT be called for non-clipboard kind");
});

Deno.test("incoming: unpaired origin is dropped — not in devices.list()", async () => {
  const clipboard = new RecordingClipboardAdapter();
  const transport = new TestableSpyTransport();
  const devices = new FakeDeviceRepository(); // empty — no paired devices
  const clock = new RecordingClock(makeDeviceId("local-device"), 0);
  const gate = new FakeRemoteWriteGate();
  const logger = new StubLogger();

  const { startRemoteReceiver } = await import(
    "../../../src/application/receive-clipboard.ts"
  );
  startRemoteReceiver({
    logger,
    clock,
    devices,
    transport,
    clipboard,
    localDeviceId: makeDeviceId("local-device"),
    remoteWriteGate: gate,
  });

  // Send from an unpaired device
  const unpairedEnvelope = makeEnvelope(
    "unpaired-device-id",
    "clipboard",
    { version: 1, counter: 1, content: "hello" },
  );
  await transport.invokeHandlers(unpairedEnvelope, "unpaired-fp");

  assertEquals(
    clipboard.writes.length,
    0,
    "clipboard.write must NOT be called for unpaired origin",
  );
  assertEquals(clock.ticks, 0, "clock.observe must NOT be called for unpaired origin");
});

Deno.test("incoming: paired device with clipboardSharingEnabled=false is dropped", async () => {
  const clipboard = new RecordingClipboardAdapter();
  const transport = new TestableSpyTransport();
  const devices = new FakeDeviceRepository();
  const clock = new RecordingClock(makeDeviceId("local-device"), 0);
  const gate = new FakeRemoteWriteGate();
  const logger = new StubLogger();

  // Paired but sharing disabled
  const mutedPeer = makeStoredDevice("MutedPeer", false);
  await devices.upsert(mutedPeer);

  const { startRemoteReceiver } = await import(
    "../../../src/application/receive-clipboard.ts"
  );
  startRemoteReceiver({
    logger,
    clock,
    devices,
    transport,
    clipboard,
    localDeviceId: makeDeviceId("local-device"),
    remoteWriteGate: gate,
  });

  const envelope = makeEnvelope(
    mutedPeer.deviceId as unknown as string,
    "clipboard",
    { version: 1, counter: 1, content: "secret" },
  );
  await transport.invokeHandlers(envelope, mutedPeer.fingerprint as unknown as string);

  assertEquals(
    clipboard.writes.length,
    0,
    "clipboard.write must NOT be called when sharing is disabled",
  );
  assertEquals(clock.ticks, 0, "clock.observe must NOT be called when sharing is disabled");
});

Deno.test("incoming: originDeviceId === localDeviceId is rejected BEFORE observe", async () => {
  const clipboard = new RecordingClipboardAdapter();
  const transport = new TestableSpyTransport();
  const devices = new FakeDeviceRepository();
  const clock = new RecordingClock(makeDeviceId("local-device"), 0);
  const gate = new FakeRemoteWriteGate();
  const logger = new StubLogger();

  // Paired + sharing-enabled local device (echo)
  const localDevice = makeStoredDevice("local-device", true);
  await devices.upsert(localDevice);

  const { startRemoteReceiver } = await import(
    "../../../src/application/receive-clipboard.ts"
  );
  startRemoteReceiver({
    logger,
    clock,
    devices,
    transport,
    clipboard,
    localDeviceId: makeDeviceId("local-device"),
    remoteWriteGate: gate,
  });

  // Simulate our own broadcast echoing back
  const echoEnvelope = makeEnvelope(
    "local-device",
    "clipboard",
    { version: 1, counter: 5, content: "echo" },
  );
  await transport.invokeHandlers(echoEnvelope, localDevice.fingerprint as unknown as string);

  assertEquals(clipboard.writes.length, 0, "clipboard.write must NOT be called for origin-echo");
  assertEquals(clock.ticks, 0, "clock.observe must NOT be called for origin-echo");
});

Deno.test("incoming: duplicate messageId is deduplicated — second event dropped", async () => {
  const clipboard = new RecordingClipboardAdapter();
  const transport = new TestableSpyTransport();
  const devices = new FakeDeviceRepository();
  const clock = new RecordingClock(makeDeviceId("local-device"), 0);
  const gate = new FakeRemoteWriteGate();
  const logger = new StubLogger();

  const peer = makeStoredDevice("PeerB", true);
  await devices.upsert(peer);

  const { startRemoteReceiver } = await import(
    "../../../src/application/receive-clipboard.ts"
  );
  startRemoteReceiver({
    logger,
    clock,
    devices,
    transport,
    clipboard,
    localDeviceId: makeDeviceId("local-device"),
    remoteWriteGate: gate,
  });

  // Use a fixed messageId for deduplication testing
  const fixedMessageId = makeMessageId("dedup-test-message-id-123");
  const envelope1 = makeEnvelope(peer.deviceId as unknown as string, "clipboard", {
    version: 1,
    counter: 1,
    content: "first",
  });
  // Override messageId to be the same
  Object.defineProperty(envelope1, "messageId", { value: fixedMessageId });

  const envelope2 = makeEnvelope(peer.deviceId as unknown as string, "clipboard", {
    version: 1,
    counter: 2,
    content: "second",
  });
  Object.defineProperty(envelope2, "messageId", { value: fixedMessageId });

  await transport.invokeHandlers(envelope1, peer.fingerprint as unknown as string);
  assertEquals(clipboard.writes.length, 1, "first event must be accepted");

  await transport.invokeHandlers(envelope2, peer.fingerprint as unknown as string);
  assertEquals(
    clipboard.writes.length,
    1,
    "second event with duplicate messageId must be deduplicated",
  );
});

Deno.test("incoming: accepted clipboard event maps payload correctly to clipboard.write", async () => {
  const clipboard = new RecordingClipboardAdapter();
  const transport = new TestableSpyTransport();
  const devices = new FakeDeviceRepository();
  const clock = new RecordingClock(makeDeviceId("local-device"), 0);
  const gate = new FakeRemoteWriteGate();
  const logger = new StubLogger();

  const peer = makeStoredDevice("PeerB", true);
  await devices.upsert(peer);

  const { startRemoteReceiver } = await import(
    "../../../src/application/receive-clipboard.ts"
  );
  const stop = startRemoteReceiver({
    logger,
    clock,
    devices,
    transport,
    clipboard,
    localDeviceId: makeDeviceId("local-device"),
    remoteWriteGate: gate,
  });

  // Valid clipboard event from paired+sharing peer
  const envelope = makeEnvelope(peer.deviceId as unknown as string, "clipboard", {
    version: 1,
    counter: 42,
    content: "hello from remote",
  });

  await transport.invokeHandlers(envelope, peer.fingerprint as unknown as string);

  assertEquals(
    clipboard.writes.length,
    1,
    "clipboard.write must be called exactly once for accepted event",
  );
  const written = clipboard.writes[0]!;
  assertEquals(written.text, "hello from remote", "write text must match envelope content");
  assertEquals(
    written.isPassword,
    false,
    "write isPassword must be false (no isPassword in flat payload)",
  );
  assertEquals(clock.ticks, 0, "startRemoteReceiver does not tick — only observes");
  assertEquals(
    gate.wasArmed(),
    true,
    "gate.suppressNext must be called before clipboard.write",
  );

  stop();
});

Deno.test("incoming: cleanup stops processing subsequent events", async () => {
  const clipboard = new RecordingClipboardAdapter();
  const transport = new TestableSpyTransport();
  const devices = new FakeDeviceRepository();
  const clock = new RecordingClock(makeDeviceId("local-device"), 0);
  const gate = new FakeRemoteWriteGate();
  const logger = new StubLogger();

  const peer = makeStoredDevice("PeerB", true);
  await devices.upsert(peer);

  const { startRemoteReceiver } = await import(
    "../../../src/application/receive-clipboard.ts"
  );
  const stop = startRemoteReceiver({
    logger,
    clock,
    devices,
    transport,
    clipboard,
    localDeviceId: makeDeviceId("local-device"),
    remoteWriteGate: gate,
  });

  // Stop the receiver
  stop();

  // Send event after cleanup — should be ignored
  const envelope = makeEnvelope(peer.deviceId as unknown as string, "clipboard", {
    version: 1,
    counter: 99,
    content: "should be ignored",
  });
  await transport.invokeHandlers(envelope, peer.fingerprint as unknown as string);

  assertEquals(clipboard.writes.length, 0, "no writes after cleanup");
});

// ---------------------------------------------------------------------------
// Additional stubs for clock and logger
// ---------------------------------------------------------------------------

class StubClock implements LogicalClock {
  private _ticks = 0;
  constructor(private _counter: number) {}

  get ticks(): number {
    return this._ticks;
  }

  get deviceId(): DeviceId {
    return makeDeviceId("local-device");
  }

  tick(): Promise<number> {
    this._ticks++;
    this._counter++;
    return Promise.resolve(this._counter);
  }

  observe(_remote: number): Promise<void> {
    return Promise.resolve();
  }
}

class StubLogger implements Logger {
  debug(_msg: string, _meta?: Record<string, unknown>): void {}
  info(_msg: string, _meta?: Record<string, unknown>): void {}
  warn(_msg: string, _meta?: Record<string, unknown>): void {}
  error(_msg: string, _meta?: Record<string, unknown>): void {}
  child(_scope: string): Logger {
    return this;
  }
}

// Re-export SpyTransport from test doubles for use in these tests
import { SpyTransport } from "./test_doubles.ts";
