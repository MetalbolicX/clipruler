/**
 * Unit tests for application/toggle-device.ts.
 *
 * Verifies:
 * - enable: toggleSharing(deps, fp, true) calls setSharingEnabled(id, true)
 * - disable: toggleSharing(deps, fp, false) calls setSharingEnabled(id, false)
 * - idempotent: repeat call with same flag completes without error
 *
 * Layer: unit — uses FakeDeviceRepository.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import { makeDeviceId, makePublicKeyFingerprint } from "../../../src/domain/device.ts";
import { toggleSharing } from "../../../src/application/toggle-device.ts";
import { FakeDeviceRepository } from "./test_doubles.ts";

const FP1 = makePublicKeyFingerprint("a".repeat(64));

Deno.test("enable: toggleSharing(deps, fp, true) calls setSharingEnabled(id, true)", async () => {
  const devices = new FakeDeviceRepository();
  const deviceId = makeDeviceId("dev-enable");
  await devices.upsert({
    deviceId,
    name: "Test Device",
    lastEndpoint: null,
    lastSeenAt: null,
    clipboardSharingEnabled: false,
    fingerprint: FP1,
    equals(other) {
      return this.deviceId === other.deviceId;
    },
  });

  await toggleSharing({ devices }, FP1, true);

  const updated = await devices.get(deviceId);
  assertEquals(updated?.clipboardSharingEnabled, true);
});

Deno.test("disable: toggleSharing(deps, fp, false) calls setSharingEnabled(id, false)", async () => {
  const devices = new FakeDeviceRepository();
  const deviceId = makeDeviceId("dev-disable");
  await devices.upsert({
    deviceId,
    name: "Test Device",
    lastEndpoint: null,
    lastSeenAt: null,
    clipboardSharingEnabled: true,
    fingerprint: FP1,
    equals(other) {
      return this.deviceId === other.deviceId;
    },
  });

  await toggleSharing({ devices }, FP1, false);

  const updated = await devices.get(deviceId);
  assertEquals(updated?.clipboardSharingEnabled, false);
});

Deno.test("idempotent: repeat call with same flag completes without error", async () => {
  const devices = new FakeDeviceRepository();
  const deviceId = makeDeviceId("dev-idempotent");
  await devices.upsert({
    deviceId,
    name: "Test Device",
    lastEndpoint: null,
    lastSeenAt: null,
    clipboardSharingEnabled: false,
    fingerprint: FP1,
    equals(other) {
      return this.deviceId === other.deviceId;
    },
  });

  // First call — enable
  await toggleSharing({ devices }, FP1, true);
  // Second call — enable again (idempotent)
  await toggleSharing({ devices }, FP1, true);

  const updated = await devices.get(deviceId);
  assertEquals(updated?.clipboardSharingEnabled, true);
});
