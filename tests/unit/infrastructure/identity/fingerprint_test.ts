/**
 * Unit tests for infrastructure/identity/fingerprint.ts.
 *
 * Verifies:
 * - derivePublicKeyFingerprint produces a 64-char hex string (SHA-256)
 * - derivePublicKeyFingerprint is deterministic: same bytes → same output
 * - derivePublicKeyFingerprint produces distinct outputs for distinct inputs
 * - Both Ed25519 SPKI DER and ECDSA-P256 SPKI DER produce 32-byte fingerprints
 *
 * Layer: unit — pure function, no mocks needed.
 */
import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0";
import { derivePublicKeyFingerprint } from "../../../../src/infrastructure/identity/fingerprint.ts";

// Ed25519 public key in SPKI DER format (32-byte raw key wrapped in AlgorithmIdentifier)
// OID 1.3.101.112 = Ed25519
// Sequence: AlgorithmIdentifier (SEQUENCE) + BIT STRING (raw key bytes)
const ED25519_SPKI_DER = new Uint8Array([
  0x30,
  0x2a,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x03,
  0x21,
  0x00,
  0x9d,
  0x61,
  0xe0,
  0x7b,
  0xba,
  0x09,
  0xa5,
  0x93,
  0x64,
  0x3f,
  0x94,
  0x5d,
  0x0b,
  0x29,
  0x80,
  0x55,
  0x16,
  0x7a,
  0xf1,
  0x75,
  0x3c,
  0x8b,
  0x8f,
  0x01,
  0x8a,
  0x9f,
  0x44,
  0x04,
  0x1e,
  0x8b,
]);

// ECDSA-P256 public key in SPKI DER format
// OID 1.2.840.10045.2.1 = ecPublicKey
// OID 1.2.840.10045.3.1.7 = P-256
const ECDSA_P256_SPKI_DER = new Uint8Array([
  0x30,
  0x59,
  0x30,
  0x13,
  0x06,
  0x07,
  0x2a,
  0x86,
  0x48,
  0xce,
  0x3d,
  0x02,
  0x01,
  0x06,
  0x08,
  0x2a,
  0x86,
  0x48,
  0xce,
  0x3d,
  0x03,
  0x01,
  0x07,
  0x03,
  0x42,
  0x00,
  // 65-byte uncompressed P-256 point (0x04 || x || y)
  0x04,
  0x04,
  0x5f,
  0xc9,
  0xf4,
  0x2f,
  0x4d,
  0x8c,
  0x6f,
  0x6e,
  0x8a,
  0x1d,
  0xb0,
  0x5d,
  0xc7,
  0x0b,
  0x25,
  0x1c,
  0xda,
  0x4c,
  0x50,
  0x4c,
  0xb3,
  0x66,
  0x21,
  0x74,
  0x1c,
  0xa4,
  0x82,
  0x3d,
  0xe8,
  0x6a,
  0xde,
  0x68,
  0xb4,
  0x6d,
  0x41,
  0xea,
  0x00,
  0x5c,
  0xee,
  0xf9,
  0x1c,
  0xae,
  0xdf,
  0xcf,
  0x59,
  0xdc,
  0x4f,
  0x81,
  0x6b,
  0x4b,
  0x8f,
  0xac,
  0x0b,
  0x0f,
  0x95,
  0x23,
  0x16,
  0x0a,
  0x18,
  0x5f,
]);

// A second Ed25519 SPKI DER for distinct-output test
const ED25519_SPKI_DER_2 = new Uint8Array([
  0x30,
  0x2a,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x03,
  0x21,
  0x00,
  0xaa,
  0xbb,
  0xcc,
  0xdd,
  0xee,
  0xff,
  0x11,
  0x22,
  0x33,
  0x44,
  0x55,
  0x66,
  0x77,
  0x88,
  0x99,
  0x00,
  0x11,
  0x22,
  0x33,
  0x44,
  0x55,
  0x66,
  0x77,
  0x88,
  0x99,
  0xaa,
  0xbb,
  0xcc,
  0xdd,
  0xee,
]);

Deno.test("derivePublicKeyFingerprint produces 64-char hex string for Ed25519 SPKI DER", async () => {
  const fp = await derivePublicKeyFingerprint(ED25519_SPKI_DER);
  assertEquals(typeof fp, "string");
  assertEquals(fp.length, 64);
  // must be valid lowercase hex (all chars in 0-9a-f)
  assertEquals(fp.replace(/[0-9a-f]/g, "").length, 0);
});

Deno.test("derivePublicKeyFingerprint produces 64-char hex string for ECDSA-P256 SPKI DER", async () => {
  const fp = await derivePublicKeyFingerprint(ECDSA_P256_SPKI_DER);
  assertEquals(typeof fp, "string");
  assertEquals(fp.length, 64);
});

Deno.test("derivePublicKeyFingerprint is deterministic: same bytes yield same output", async () => {
  const fp1 = await derivePublicKeyFingerprint(ED25519_SPKI_DER);
  const fp2 = await derivePublicKeyFingerprint(ED25519_SPKI_DER);
  assertEquals(fp1, fp2);
});

Deno.test("derivePublicKeyFingerprint produces distinct outputs for distinct inputs", async () => {
  const fp1 = await derivePublicKeyFingerprint(ED25519_SPKI_DER);
  const fp2 = await derivePublicKeyFingerprint(ED25519_SPKI_DER_2);
  assertNotEquals(fp1, fp2);
});
