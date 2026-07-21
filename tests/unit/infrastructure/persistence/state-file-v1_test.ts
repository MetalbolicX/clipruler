/**
 * Unit tests for infrastructure/persistence/state-file-v1.ts.
 *
 * Verifies:
 * - TrustedDeviceEntry shape (all required fields)
 * - StateFileV1 shape (schemaVersion 1, ownDeviceId, trustedDevices, clockCounter)
 * - isStateFileV1 runtime type guard: accepts valid objects, rejects invalid ones
 *
 * Layer: unit.
 */
import { assertStrictEquals } from "jsr:@std/assert@^1.0";
import { makeDeviceId } from "../../../../src/domain/device.ts";
import type {
  StateFileV1,
  TrustedDeviceEntry,
} from "../../../../src/infrastructure/persistence/state-file-v1.ts";
import { isStateFileV1 } from "../../../../src/infrastructure/persistence/state-file-v1.ts";

Deno.test("StateFileV1: valid object passes type guard", () => {
  const ownId = makeDeviceId("device-local-1");
  const entry: TrustedDeviceEntry = {
    deviceId: makeDeviceId("device-remote-1"),
    deviceName: "Pixel 8",
    publicKeyBase64: "Zm9vYmFyYmF6", // base64 of "foobarbaz"
    publicKeyAlgorithm: "Ed25519",
    pairedAtEpochMs: 1_700_000_000_000,
    lastSeenEpochMs: 1_701_000_000_000,
    enabled: true,
  };
  const state: StateFileV1 = {
    schemaVersion: 1,
    ownDeviceId: ownId,
    trustedDevices: [entry],
    clockCounter: 42,
  };

  const result = isStateFileV1(state);
  assertStrictEquals(result, true);
});

Deno.test("StateFileV1: rejects number schemaVersion", () => {
  const result = isStateFileV1({
    schemaVersion: 2, // not 1
    ownDeviceId: makeDeviceId("dev"),
    trustedDevices: [],
    clockCounter: 0,
  });
  assertStrictEquals(result, false);
});

Deno.test("StateFileV1: rejects string schemaVersion", () => {
  const result = isStateFileV1({
    schemaVersion: "1",
    ownDeviceId: makeDeviceId("dev"),
    trustedDevices: [],
    clockCounter: 0,
  });
  assertStrictEquals(result, false);
});

Deno.test("StateFileV1: rejects absent ownDeviceId", () => {
  const result = isStateFileV1({
    schemaVersion: 1,
    // ownDeviceId missing
    trustedDevices: [],
    clockCounter: 0,
  });
  assertStrictEquals(result, false);
});

Deno.test("StateFileV1: rejects non-array trustedDevices", () => {
  const result = isStateFileV1({
    schemaVersion: 1,
    ownDeviceId: makeDeviceId("dev"),
    trustedDevices: "not-an-array",
    clockCounter: 0,
  });
  assertStrictEquals(result, false);
});

Deno.test("StateFileV1: rejects absent clockCounter", () => {
  const result = isStateFileV1({
    schemaVersion: 1,
    ownDeviceId: makeDeviceId("dev"),
    trustedDevices: [],
    // clockCounter missing
  });
  assertStrictEquals(result, false);
});

Deno.test("StateFileV1: rejects non-integer clockCounter", () => {
  const result = isStateFileV1({
    schemaVersion: 1,
    ownDeviceId: makeDeviceId("dev"),
    trustedDevices: [],
    clockCounter: 1.5,
  });
  assertStrictEquals(result, false);
});

Deno.test("TrustedDeviceEntry: requires publicKeyAlgorithm to be Ed25519 or ECDSA-P256", () => {
  const ownId = makeDeviceId("device-local-1");
  const entryBad: TrustedDeviceEntry = {
    deviceId: makeDeviceId("device-remote-1"),
    deviceName: "Bad Device",
    publicKeyBase64: "Zm9v",
    publicKeyAlgorithm: "RSA-2048" as "Ed25519", // invalid algorithm
    pairedAtEpochMs: 1_700_000_000_000,
    enabled: true,
  };
  const state = isStateFileV1({
    schemaVersion: 1,
    ownDeviceId: ownId,
    trustedDevices: [entryBad],
    clockCounter: 0,
  });
  assertStrictEquals(state, false);
});

Deno.test("TrustedDeviceEntry: lastSeenEpochMs is optional", () => {
  const ownId = makeDeviceId("device-local-1");
  const entry: TrustedDeviceEntry = {
    deviceId: makeDeviceId("device-remote-1"),
    deviceName: "Minimal Device",
    publicKeyBase64: "Zm9vYmFy",
    publicKeyAlgorithm: "ECDSA-P256",
    pairedAtEpochMs: 1_700_000_000_000,
    // lastSeenEpochMs intentionally absent
    enabled: false,
  };
  const result = isStateFileV1({
    schemaVersion: 1,
    ownDeviceId: ownId,
    trustedDevices: [entry],
    clockCounter: 0,
  });
  assertStrictEquals(result, true);
});

Deno.test("StateFileV1: rejects plain null", () => {
  assertStrictEquals(isStateFileV1(null), false);
});

Deno.test("StateFileV1: rejects plain undefined", () => {
  assertStrictEquals(isStateFileV1(undefined), false);
});

Deno.test("StateFileV1: rejects a plain string", () => {
  assertStrictEquals(isStateFileV1("not an object"), false);
});
