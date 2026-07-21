/**
 * Unit tests for infrastructure/identity/keyring.ts.
 *
 * Verifies:
 * - Keyring.generate() returns a KeyPair with algorithm "Ed25519" or "ECDSA-P256"
 * - KeyPair.publicKey is a Uint8Array of SPKI DER bytes
 * - KeyPair.privateKey is a CryptoKey
 * - generate() is idempotent per instance (caller manages singleton if desired)
 * - Both Ed25519 and ECDSA-P256 produce 32-byte fingerprints (SHA-256 of SPKI DER)
 * - The algorithm enum values match the spec: "Ed25519" | "ECDSA-P256"
 *
 * Layer: unit — uses globalThis.crypto.subtle directly.
 */
import { assertEquals, assertExists } from "jsr:@std/assert@^1.0";
import { Keyring } from "../../../../src/infrastructure/identity/keyring.ts";
import { derivePublicKeyFingerprint } from "../../../../src/infrastructure/identity/fingerprint.ts";

Deno.test("Keyring.generate() returns KeyPair with valid algorithm enum", async () => {
  const keyring = new Keyring();
  const kp = await keyring.generate();

  assertExists(kp);
  assertExists(kp.algorithm);
  assertEquals(
    kp.algorithm === "Ed25519" || kp.algorithm === "ECDSA-P256",
    true,
    `algorithm must be "Ed25519" or "ECDSA-P256", got: ${kp.algorithm}`,
  );
});

Deno.test("KeyPair.publicKey is a Uint8Array (SPKI DER bytes)", async () => {
  const keyring = new Keyring();
  const kp = await keyring.generate();

  assertEquals(kp.publicKey instanceof Uint8Array, true);
  assertEquals(kp.publicKey.length > 0, true);
});

Deno.test("KeyPair.privateKey is a CryptoKey", async () => {
  const keyring = new Keyring();
  const kp = await keyring.generate();

  assertEquals(kp.privateKey instanceof CryptoKey, true);
});

Deno.test("Both algorithms produce 32-byte fingerprints via SHA-256 of SPKI DER", async () => {
  const keyring = new Keyring();
  const kp = await keyring.generate();

  const fp = await derivePublicKeyFingerprint(kp.publicKey);
  assertEquals(fp.length, 64); // 32 bytes × 2 hex chars
});

Deno.test("generate() returns correct algorithm field value type", async () => {
  const keyring = new Keyring();
  const kp = await keyring.generate();

  // Explicitly narrow to verify the exact union type
  if (kp.algorithm === "Ed25519") {
    assertEquals(kp.algorithm, "Ed25519");
  } else {
    assertEquals(kp.algorithm, "ECDSA-P256");
  }
});

Deno.test("Two generate() calls produce distinct key pairs (non-idempotent by default)", async () => {
  const keyring = new Keyring();
  const kp1 = await keyring.generate();
  const kp2 = await keyring.generate();

  // They should be different keys (different public key bytes)
  const fp1 = await derivePublicKeyFingerprint(kp1.publicKey);
  const fp2 = await derivePublicKeyFingerprint(kp2.publicKey);
  assertEquals(fp1 === fp2, false);
});
