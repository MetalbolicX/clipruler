/**
 * Unit tests for domain/device.ts — branded identity types and fingerprint derivation.
 * @std/assert required by spec deviation correction.
 */
import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0";
import {
  deriveFingerprint,
  Device,
  isDeviceId,
  isMessageId,
  isPublicKeyFingerprint,
  makeDeviceId,
  makeMessageId,
  makePublicKeyFingerprint,
} from "../../../src/domain/device.ts";

/**
 * Scenario: bare string rejected.
 * We verify the Brand guard rejects a plain string at runtime.
 * Compile-time rejection is enforced by Brand<T,B> nominal typing.
 */
Deno.test("DeviceId guard rejects bare string", () => {
  const raw = "device-001" as unknown;
  // isDeviceId should return false for a bare string
  assertEquals(isDeviceId(raw), false);
});

Deno.test("MessageId guard rejects bare string", () => {
  const raw = "msg-001" as unknown;
  assertEquals(isMessageId(raw), false);
});

Deno.test("PublicKeyFingerprint guard rejects bare string", () => {
  const raw = "fp-001" as unknown;
  assertEquals(isPublicKeyFingerprint(raw), false);
});

/**
 * Scenario: equal underlying values are equal.
 * Two DeviceIds built from the same string must be equal.
 */
Deno.test("makeDeviceId produces equal ids for same input", () => {
  const id1 = makeDeviceId("device-abc");
  const id2 = makeDeviceId("device-abc");
  assertEquals(id1, id2);
});

Deno.test("makeDeviceId produces different ids for different inputs", () => {
  const id1 = makeDeviceId("device-abc");
  const id2 = makeDeviceId("device-xyz");
  assertNotEquals(id1, id2);
});

Deno.test("makeMessageId produces equal ids for same input", () => {
  const id1 = makeMessageId("msg-abc");
  const id2 = makeMessageId("msg-abc");
  assertEquals(id1, id2);
});

Deno.test("makePublicKeyFingerprint produces equal fingerprints for same input", () => {
  const fp1 = makePublicKeyFingerprint("fp-abc");
  const fp2 = makePublicKeyFingerprint("fp-abc");
  assertEquals(fp1, fp2);
});

/**
 * Device value object — two devices are equal if their deviceIds match.
 */
Deno.test("Device equality by deviceId", () => {
  const d1 = new Device(makeDeviceId("dev-001"), "My Device");
  const d2 = new Device(makeDeviceId("dev-001"), "Different Name");
  const d3 = new Device(makeDeviceId("dev-002"), "My Device");
  assertEquals(d1.equals(d2), true);
  assertEquals(d1.equals(d3), false);
});

Deno.test("Device stores name", () => {
  const d = new Device(makeDeviceId("dev-001"), "My Device");
  assertEquals(d.name, "My Device");
});

/**
 * Scenario: same input, same output (deterministic fingerprint).
 * deriveFingerprint is async; identical Uint8Array input yields identical hex output.
 */
Deno.test("deriveFingerprint is deterministic: same input yields same output", async () => {
  const key1 = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
  const key2 = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
  const [fp1, fp2] = await Promise.all([
    deriveFingerprint(key1),
    deriveFingerprint(key2),
  ]);
  assertEquals(fp1, fp2);
});

/**
 * Scenario: different input, different output.
 * Two distinct byte sequences yield two distinct hex fingerprints.
 */
Deno.test("deriveFingerprint: different inputs yield different outputs", async () => {
  const keyA = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
  const keyB = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc]);
  const [fpA, fpB] = await Promise.all([
    deriveFingerprint(keyA),
    deriveFingerprint(keyB),
  ]);
  assertNotEquals(fpA, fpB);
});

/**
 * Edge case: empty key still produces a fingerprint.
 */
Deno.test("deriveFingerprint handles empty Uint8Array", async () => {
  const empty = new Uint8Array(0);
  const fp = await deriveFingerprint(empty);
  // SHA-256 of empty input is the known hash of nothing
  assertEquals(fp.length, 64); // hex-encoded SHA-256 = 64 chars
});

/**
 * Edge case: fingerprint is a valid hex string.
 */
Deno.test("deriveFingerprint returns hex-encoded string", async () => {
  const key = new Uint8Array([0x01, 0x02, 0x03]);
  const fp = await deriveFingerprint(key);
  // Must be 64-char hex string
  assertEquals(/^[0-9a-f]{64}$/.test(fp), true);
});
