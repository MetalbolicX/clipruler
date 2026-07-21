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
import { makeDeviceId, makePublicKeyFingerprint } from "../../../src/domain/device.ts";

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
  const fpRaw = name.split("").map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").padEnd(64, "0").slice(0, 64);
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
  const _stop = startLocalSync({ clipboard, clock, devices, transport, logger, remoteWriteGate: gate });

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
  const _stop = startLocalSync({ clipboard, clock, devices, transport, logger, remoteWriteGate: gate });

  await clipboard.emit({ text: "hello world", isPassword: false });

  assertEquals(clock.ticks, 1, "clock.tick must be called exactly once");
  assertEquals(transport.calls.send.length, 1, "transport.send must be called for the one sharing peer");

  const { peerFingerprint, envelope } = transport.calls.send[0]!;
  assertEquals(peerFingerprint, peer.fingerprint, "send must be to the correct peer fingerprint");
  assertEquals(envelope.kind, "clipboard", "envelope kind must be 'clipboard'");
  assertEquals(envelope.originDeviceId, clock.deviceId, "originDeviceId must match local device");

  const payload = envelope.payload as Record<string, unknown>;
  assertEquals(payload.version, 1, "payload version must be 1");
  assertEquals(payload.counter, 6, "payload counter must be clock tick result (5 + 1)");
  assertEquals(payload.content, "hello world", "payload content must match emitted text");
  assertEquals(Object.prototype.hasOwnProperty.call(payload, "isPassword"), false, "payload must NOT contain isPassword");
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
  const _stop = startLocalSync({ clipboard, clock, devices, transport, logger, remoteWriteGate: gate });

  await clipboard.emit({ text: "test", isPassword: false });

  assertEquals(transport.calls.send.length, 1, "exactly one send must occur");
  const { peerFingerprint } = transport.calls.send[0]!;
  assertEquals(peerFingerprint, sharingPeer.fingerprint, "only the sharing-enabled peer must receive the send");
  assertEquals(peerFingerprint !== mutedPeer.fingerprint, true, "muted peer must not receive the send");
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
  const _stop = startLocalSync({ clipboard, clock, devices, transport, logger, remoteWriteGate: gate });

  // Simulate a remote write just occurred — gate is now suppressed
  gate.suppressNext();

  await clipboard.emit({ text: "should be suppressed", isPassword: false });

  assertEquals(clock.ticks, 0, "clock.tick must NOT be called when gate is suppressed");
  assertEquals(transport.calls.send.length, 0, "transport.send must NOT be called when gate is suppressed");

  // Next event (gate now reset) should go through normally
  await clipboard.emit({ text: "normal event", isPassword: false });

  assertEquals(clock.ticks, 1, "clock.tick must be called after gate resets");
  assertEquals(transport.calls.send.length, 1, "transport.send must occur after gate resets");
  const { envelope } = transport.calls.send[0]!;
  const payload = envelope.payload as Record<string, unknown>;
  assertEquals(payload.content, "normal event");
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
