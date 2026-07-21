/**
 * Unit tests for infrastructure/crypto/pairing-code.ts.
 *
 * Verifies:
 * - derivePairingCode is commutative: derivePairingCode(a,b) === derivePairingCode(b,a)
 * - Different pairs produce different 6-hex codes
 * - Code format is always exactly 6 lowercase hex characters
 * - Malformed non-hex input throws
 *
 * Layer: unit — pure function, no mocks needed.
 */
import { assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@^1.0";
import type { PublicKeyFingerprint } from "../../../src/domain/device.ts";
import { makePublicKeyFingerprint } from "../../../src/domain/device.ts";

// Two valid 64-char hex fingerprints for commutativity test
const FPA = makePublicKeyFingerprint("a".repeat(64));
const FPB = makePublicKeyFingerprint("b".repeat(64));

// Two distinct pairs for distinct-code test
const FPC = makePublicKeyFingerprint("c".repeat(64));
const FPD = makePublicKeyFingerprint("d".repeat(64));

Deno.test("derivePairingCode is commutative", async () => {
  const { derivePairingCode } = await import(
    "../../../src/infrastructure/crypto/pairing-code.ts"
  );
  const codeAB = await derivePairingCode(FPA, FPB);
  const codeBA = await derivePairingCode(FPB, FPA);
  assertEquals(codeAB, codeBA);
});

Deno.test("different pairs produce different 6-hex codes", async () => {
  const { derivePairingCode } = await import(
    "../../../src/infrastructure/crypto/pairing-code.ts"
  );
  const code1 = await derivePairingCode(FPA, FPB);
  const code2 = await derivePairingCode(FPC, FPD);
  assertNotEquals(code1, code2);
  // Each must be exactly 6 lowercase hex chars
  const HEX6 = /^[0-9a-f]{6}$/;
  assertEquals(HEX6.test(code1), true);
  assertEquals(HEX6.test(code2), true);
});

Deno.test("rejects malformed non-hex input", async () => {
  const { derivePairingCode } = await import(
    "../../../src/infrastructure/crypto/pairing-code.ts"
  );
  // Pass a non-hex string cast as PublicKeyFingerprint to bypass type check
  const malformed = "not-a-hex-fingerprint" as PublicKeyFingerprint;
  await assertRejects(
    () => derivePairingCode(malformed, FPA),
    Error,
    "Invalid fingerprint",
  );
  await assertRejects(
    () => derivePairingCode(FPA, malformed),
    Error,
    "Invalid fingerprint",
  );
});
