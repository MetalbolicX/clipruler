/**
 * Unit tests for ports/device-repository.ts — interface-shape smoke tests.
 * Verifies the DeviceRepository interface contract surface is reachable.
 * Layer: unit.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type { DeviceRepository, StoredDevice } from "../../../src/ports/device-repository.ts";
import type { Device, DeviceId, PublicKeyFingerprint } from "../../../src/domain/device.ts";
import { makeDeviceId, makePublicKeyFingerprint } from "../../../src/domain/device.ts";

/**
 * Scenario: DeviceRepository interface has all six required method signatures.
 */
Deno.test("DeviceRepository interface: all six methods are callable", () => {
  const mock: DeviceRepository = {
    list(): Promise<readonly StoredDevice[]> {
      return Promise.resolve([]);
    },
    get(_id: DeviceId): Promise<StoredDevice | null> {
      return Promise.resolve(null);
    },
    getByFingerprint(_fp: PublicKeyFingerprint): Promise<StoredDevice | null> {
      return Promise.resolve(null);
    },
    upsert(_device: StoredDevice): Promise<void> {
      return Promise.resolve();
    },
    remove(_id: DeviceId): Promise<void> {
      return Promise.resolve();
    },
    setSharingEnabled(_id: DeviceId, _enabled: boolean): Promise<void> {
      return Promise.resolve();
    },
  };
  assertEquals(typeof mock.list, "function");
  assertEquals(typeof mock.get, "function");
  assertEquals(typeof mock.getByFingerprint, "function");
  assertEquals(typeof mock.upsert, "function");
  assertEquals(typeof mock.remove, "function");
  assertEquals(typeof mock.setSharingEnabled, "function");
});

/**
 * Scenario: StoredDevice extends Device with additional persistence fields.
 */
Deno.test("StoredDevice has Device fields plus lastEndpoint, lastSeenAt, clipboardSharingEnabled, fingerprint", () => {
  const dev: StoredDevice = {
    deviceId: makeDeviceId("dev-001"),
    name: "My Device",
    lastEndpoint: "192.168.1.10:7341",
    lastSeenAt: "2026-01-01T00:00:00Z",
    clipboardSharingEnabled: true,
    fingerprint: makePublicKeyFingerprint(
      "a".repeat(64),
    ),
    equals(other: Device): boolean {
      return this.deviceId === other.deviceId;
    },
  };
  assertEquals(dev.lastEndpoint, "192.168.1.10:7341");
  assertEquals(dev.lastSeenAt, "2026-01-01T00:00:00Z");
  assertEquals(dev.clipboardSharingEnabled, true);
  assertEquals(dev.fingerprint, "a".repeat(64));
});

/**
 * Scenario: list() returns an empty array when no devices are stored.
 */
Deno.test("list() returns empty array when no devices stored", async () => {
  const mock: DeviceRepository = {
    list(): Promise<readonly StoredDevice[]> {
      return Promise.resolve([]);
    },
    get(_id: DeviceId) {
      return Promise.resolve(null);
    },
    getByFingerprint(_fp: PublicKeyFingerprint) {
      return Promise.resolve(null);
    },
    upsert(_device: StoredDevice) {
      return Promise.resolve();
    },
    remove(_id: DeviceId) {
      return Promise.resolve();
    },
    setSharingEnabled(_id: DeviceId, _enabled: boolean) {
      return Promise.resolve();
    },
  };
  const devices = await mock.list();
  assertEquals(devices.length, 0);
});

/**
 * Scenario: get() resolves null for an absent device.
 */
Deno.test("get() resolves null for absent device", async () => {
  const mock: DeviceRepository = {
    list() {
      return Promise.resolve([]);
    },
    get(_id: DeviceId): Promise<StoredDevice | null> {
      return Promise.resolve(null);
    },
    getByFingerprint(_fp: PublicKeyFingerprint): Promise<StoredDevice | null> {
      return Promise.resolve(null);
    },
    upsert(_device: StoredDevice) {
      return Promise.resolve();
    },
    remove(_id: DeviceId) {
      return Promise.resolve();
    },
    setSharingEnabled(_id: DeviceId, _enabled: boolean) {
      return Promise.resolve();
    },
  };
  const result = await mock.get(makeDeviceId("absent-id"));
  assertEquals(result, null);
});

/**
 * Scenario: StoredDevice optional fields can be null.
 */
Deno.test("StoredDevice optional fields are nullable", () => {
  const dev: StoredDevice = {
    deviceId: makeDeviceId("dev-002"),
    name: "No-Endpoint Device",
    lastEndpoint: null,
    lastSeenAt: null,
    clipboardSharingEnabled: false,
    fingerprint: makePublicKeyFingerprint("b".repeat(64)),
    equals(other: Device): boolean {
      return this.deviceId === other.deviceId;
    },
  };
  assertEquals(dev.lastEndpoint, null);
  assertEquals(dev.lastSeenAt, null);
});
