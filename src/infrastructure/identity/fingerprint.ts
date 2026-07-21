/**
 * infrastructure/identity/fingerprint.ts
 *
 * Derives a 32-byte (64-char hex) SHA-256 fingerprint from a public key
 * encoded in SPKI DER format.
 *
 * Deterministic: identical bytes → identical fingerprint.
 * Used as the stable peer-key identifier in the system.
 */

import { bytesToHex } from "../../domain/device.ts";

/**
 * Derive a SHA-256 fingerprint from a public key SPKI DER blob.
 *
 * @param publicKeySpkiDer - Uint8Array of SPKI DER-encoded public key bytes
 * @returns 64-character lowercase hex string (SHA-256 digest)
 */
export async function derivePublicKeyFingerprint(
  publicKeySpkiDer: Uint8Array,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    publicKeySpkiDer as BufferSource,
  );
  return bytesToHex(digest);
}
