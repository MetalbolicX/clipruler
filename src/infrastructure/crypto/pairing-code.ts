/**
 * infrastructure/crypto/pairing-code.ts
 *
 * Derives a short-authentication-string (SAS) pairing code from two
 * public-key fingerprints using SHA-256 canonical hashing.
 *
 * The code is commutative, deterministic, and produces exactly 6 lowercase
 * hex characters. No external dependencies — uses WebCrypto only.
 */

import type { PublicKeyFingerprint } from "../../domain/device.ts";

const HEX_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * Derive a 6-character hex pairing code from two public-key fingerprints.
 *
 * Canonicalizes `lo < hi ? [lo,hi] : [hi,lo]` then SHA-256("lo:hi") and
 * returns the first 6 hex characters.
 *
 * @param a - first fingerprint (branded PublicKeyFingerprint, 64 lowercase hex)
 * @param b - second fingerprint (branded PublicKeyFingerprint, 64 lowercase hex)
 * @returns 6-character lowercase hex string
 * @throws Error if either input is not a valid 64-char lowercase hex fingerprint
 */
export async function derivePairingCode(
  a: PublicKeyFingerprint,
  b: PublicKeyFingerprint,
): Promise<string> {
  if (!HEX_FINGERPRINT_RE.test(a)) {
    throw new Error(`Invalid fingerprint (a): not 64-char hex`);
  }
  if (!HEX_FINGERPRINT_RE.test(b)) {
    throw new Error(`Invalid fingerprint (b): not 64-char hex`);
  }
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const data = new TextEncoder().encode(`${lo}:${hi}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 6);
}
