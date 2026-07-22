/**
 * tests/unit/application/test_doubles.ts
 *
 * Test doubles for application-layer unit tests.
 * All doubles implement the real port interfaces for integration-style
 * unit testing without network or real crypto.
 *
 * Pattern: non-async methods returning Promise.resolve(...) to satisfy
 * port interfaces without triggering deno-lint require-await.
 */

import type { DeviceRepository, StoredDevice } from "../../../src/ports/device-repository.ts";
import type { Discovery, PeerSighting } from "../../../src/ports/discovery.ts";
import type { KeyStore, PrivateKeyMaterial } from "../../../src/ports/key-store.ts";
import type { Transport } from "../../../src/ports/transport.ts";
import type { UiPort } from "../../../src/ports/ui.ts";
import type { Logger } from "../../../src/ports/logger.ts";
import type { Envelope } from "../../../src/protocol/envelope.ts";
import type { DeviceId, PublicKeyFingerprint } from "../../../src/domain/device.ts";

// ---------------------------------------------------------------------------
// RecordingUi — records all UiPort calls for assertion
// ---------------------------------------------------------------------------

export interface RecordingUiCalls {
  presentPairingCode: Array<{ code: string }>;
  confirmPairing: Array<{ remoteName: string; code: string }>;
  notifyPaired: Array<{ deviceName: string }>;
  notifyPairingFailed: Array<{ reason: "mismatch" | "rejected" | "timeout" }>;
}

export class RecordingUi implements UiPort {
  readonly calls: RecordingUiCalls = {
    presentPairingCode: [],
    confirmPairing: [],
    notifyPaired: [],
    notifyPairingFailed: [],
  };

  presentPairingCode(code: string): Promise<void> {
    this.calls.presentPairingCode.push({ code });
    return Promise.resolve();
  }

  confirmPairing(remoteName: string, code: string): Promise<boolean> {
    this.calls.confirmPairing.push({ remoteName, code });
    return Promise.resolve(false);
  }

  notifyPaired(deviceName: string): Promise<void> {
    this.calls.notifyPaired.push({ deviceName });
    return Promise.resolve();
  }

  notifyPairingFailed(
    reason: "mismatch" | "rejected" | "timeout",
  ): Promise<void> {
    this.calls.notifyPairingFailed.push({ reason });
    return Promise.resolve();
  }

  reset(): void {
    this.calls.presentPairingCode.length = 0;
    this.calls.confirmPairing.length = 0;
    this.calls.notifyPaired.length = 0;
    this.calls.notifyPairingFailed.length = 0;
  }
}

// ---------------------------------------------------------------------------
// SpyTransport — records all sent envelopes without network
// ---------------------------------------------------------------------------

export interface SpyTransportCalls {
  send: Array<{ peerFingerprint: string; envelope: Envelope }>;
  broadcast: Array<{ envelope: Envelope }>;
  subscribe: Array<{
    handler: (envelope: Envelope, peerFingerprint: string) => void;
  }>;
  close: Array<() => void>;
}

export class SpyTransport implements Transport {
  readonly calls: SpyTransportCalls = {
    send: [],
    broadcast: [],
    subscribe: [],
    close: [],
  };

  send(peerFingerprint: string, envelope: Envelope): Promise<void> {
    this.calls.send.push({ peerFingerprint, envelope });
    return Promise.resolve();
  }

  broadcast(envelope: Envelope): Promise<void> {
    this.calls.broadcast.push({ envelope });
    return Promise.resolve();
  }

  subscribe(
    handler: (envelope: Envelope, peerFingerprint: string) => void,
  ): Promise<void> {
    this.calls.subscribe.push({ handler });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.calls.close.push(() => {});
    return Promise.resolve();
  }

  reset(): void {
    this.calls.send.length = 0;
    this.calls.broadcast.length = 0;
    this.calls.subscribe.length = 0;
    this.calls.close.length = 0;
  }
}

// ---------------------------------------------------------------------------
// FakeDeviceRepository — in-memory map of StoredDevices
// ---------------------------------------------------------------------------

export class FakeDeviceRepository implements DeviceRepository {
  private readonly devices = new Map<DeviceId, StoredDevice>();
  private readonly fingerprints = new Map<PublicKeyFingerprint, StoredDevice>();

  list(): Promise<readonly StoredDevice[]> {
    return Promise.resolve(Array.from(this.devices.values()));
  }

  get(id: DeviceId): Promise<StoredDevice | null> {
    return Promise.resolve(this.devices.get(id) ?? null);
  }

  getByFingerprint(fp: PublicKeyFingerprint): Promise<StoredDevice | null> {
    return Promise.resolve(this.fingerprints.get(fp) ?? null);
  }

  upsert(device: StoredDevice): Promise<void> {
    this.devices.set(device.deviceId, device);
    this.fingerprints.set(device.fingerprint, device);
    return Promise.resolve();
  }

  remove(id: DeviceId): Promise<void> {
    const device = this.devices.get(id);
    if (device) {
      this.devices.delete(id);
      this.fingerprints.delete(device.fingerprint);
    }
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

  // Test helper to pre-populate
  seed(devices: StoredDevice[]): void {
    for (const d of devices) {
      this.devices.set(d.deviceId, d);
      this.fingerprints.set(d.fingerprint, d);
    }
  }

  clear(): void {
    this.devices.clear();
    this.fingerprints.clear();
  }
}

// ---------------------------------------------------------------------------
// FakeDiscovery — configurable visible peer map
// ---------------------------------------------------------------------------

export class FakeDiscovery implements Discovery {
  private readonly peers = new Map<PublicKeyFingerprint, PeerSighting>();

  start(): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.peers.clear();
    return Promise.resolve();
  }

  subscribe(
    listener: (peers: ReadonlyMap<PublicKeyFingerprint, PeerSighting>) => void,
  ): () => void {
    // Immediately emit current state
    listener(new Map(this.peers));
    return () => {};
  }

  visible(): ReadonlyMap<PublicKeyFingerprint, PeerSighting> {
    return new Map(this.peers);
  }

  // Test helper to pre-populate
  seed(sightings: Array<[PublicKeyFingerprint, PeerSighting]>): void {
    for (const [fp, sighting] of sightings) {
      this.peers.set(fp, sighting);
    }
  }

  clear(): void {
    this.peers.clear();
  }
}

// ---------------------------------------------------------------------------
// StubKeyStore — returns canned PrivateKeyMaterial
// ---------------------------------------------------------------------------

export class StubKeyStore implements KeyStore {
  private readonly material: PrivateKeyMaterial;

  constructor(material?: Partial<PrivateKeyMaterial>) {
    this.material = {
      format: "jwk-spki",
      algorithm: "Ed25519",
      privateKeyBase64: material?.privateKeyBase64 ??
        "dGVzdC1wcml2YXRlLWtleS1iYXNlNjQ=",
      publicKeyBase64: material?.publicKeyBase64 ??
        "dGVzdC1wdWJsaWMta2V5LWJhc2U2NA==",
    };
  }

  getOrCreateLocal(): Promise<PrivateKeyMaterial> {
    return Promise.resolve(this.material);
  }

  storePeerPublicKey(
    _fingerprint: string,
    _publicKeyBase64: string,
  ): Promise<void> {
    return Promise.resolve();
  }

  getPeerPublicKey(_fingerprint: string): Promise<string | null> {
    return Promise.resolve(null);
  }

  deletePeerPublicKey(_fingerprint: string): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// StubLogger — no-op logger for tests
// ---------------------------------------------------------------------------

export class StubLogger implements Logger {
  debug(_msg: string, _meta?: Record<string, unknown>): void {}
  info(_msg: string, _meta?: Record<string, unknown>): void {}
  warn(_msg: string, _meta?: Record<string, unknown>): void {}
  error(_msg: string, _meta?: Record<string, unknown>): void {}
  child(_scope: string): Logger {
    return this;
  }
}
