/**
 * Unit tests for ports/index.ts — barrel purity smoke tests.
 * Verifies the barrel re-exports all port interfaces and compilation succeeds.
 * Layer: unit.
 */
import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0";
import type {
  DeviceRepository,
  KeyStore,
  Logger,
  LogicalClock,
  LogicalCounter,
  LogLevel,
  PrivateKeyMaterial,
  StoredDevice,
  Transport,
} from "../../../src/ports/index.ts";
import type { Envelope } from "../../../src/protocol/envelope.ts";
import type { DeviceId, PublicKeyFingerprint } from "../../../src/domain/device.ts";
import { makeDeviceId, makePublicKeyFingerprint } from "../../../src/domain/device.ts";

/**
 * Scenario: all type re-exports are valid types (compilation proves reachability).
 * We verify by creating a minimal mock that satisfies each interface.
 */
Deno.test("Logger and LogLevel are reachable via barrel", () => {
  const _logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child(_s: string): Logger {
      return this;
    },
  };
  const _level: LogLevel = "debug";
  assertNotEquals(_logger, undefined);
  assertNotEquals(_level, undefined);
});

Deno.test("KeyStore and PrivateKeyMaterial are reachable via barrel", () => {
  const _store: KeyStore = {
    getOrCreateLocal() {
      return Promise.resolve({
        format: "pkcs8-spki" as const,
        algorithm: "Ed25519" as const,
        privateKeyBase64: "",
        publicKeyBase64: "",
      });
    },
    storePeerPublicKey(_fp: string, _key: string): Promise<void> {
      return Promise.resolve();
    },
    getPeerPublicKey(_fp: string): Promise<string | null> {
      return Promise.resolve(null);
    },
    deletePeerPublicKey(_fp: string): Promise<void> {
      return Promise.resolve();
    },
  };
  const _mat: PrivateKeyMaterial = {
    format: "pkcs8-spki",
    algorithm: "Ed25519",
    privateKeyBase64: "test",
    publicKeyBase64: "test",
  };
  assertNotEquals(_store, undefined);
  assertNotEquals(_mat, undefined);
});

Deno.test("DeviceRepository and StoredDevice are reachable via barrel", () => {
  const _repo: DeviceRepository = {
    list(): Promise<readonly StoredDevice[]> {
      return Promise.resolve([]);
    },
    get(_id: DeviceId): Promise<StoredDevice | null> {
      return Promise.resolve(null);
    },
    getByFingerprint(_fp: PublicKeyFingerprint): Promise<StoredDevice | null> {
      return Promise.resolve(null);
    },
    upsert(_d: StoredDevice): Promise<void> {
      return Promise.resolve();
    },
    remove(_id: DeviceId): Promise<void> {
      return Promise.resolve();
    },
    setSharingEnabled(_id: DeviceId, _e: boolean): Promise<void> {
      return Promise.resolve();
    },
  };
  const _stored: StoredDevice = {
    deviceId: makeDeviceId("test"),
    fingerprint: makePublicKeyFingerprint(
      "0000000000000000000000000000000000000000000000000000000000000000",
    ),
    name: "Test",
    lastEndpoint: null,
    lastSeenAt: null,
    clipboardSharingEnabled: false,
    equals(): boolean {
      return false;
    },
  };
  assertNotEquals(_repo, undefined);
  assertNotEquals(_stored, undefined);
});

Deno.test("LogicalClock and LogicalCounter are reachable via barrel", () => {
  const _clock: LogicalClock = {
    tick(): Promise<LogicalCounter> {
      return Promise.resolve(1);
    },
    observe(_n: LogicalCounter): Promise<void> {
      return Promise.resolve();
    },
    deviceId: makeDeviceId("test"),
  };
  const _counter: LogicalCounter = 42;
  assertNotEquals(_clock, undefined);
  assertEquals(_counter, 42);
});

Deno.test("Transport is reachable via barrel", () => {
  const _transport: Transport = {
    async send(_fp: string, _env: Envelope): Promise<void> {/* noop */},
    async broadcast(_env: Envelope): Promise<void> {/* noop */},
    async subscribe(_handler: (env: Envelope, fp: string) => void): Promise<void> {/* noop */},
    async close(): Promise<void> {/* noop */},
  };
  assertNotEquals(_transport, undefined);
});
