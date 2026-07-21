/**
 * infrastructure/identity/keyring.ts
 *
 * Keyring — generates cryptographic key pairs for local device identity.
 *
 * Algorithm priority: Ed25519 first; ECDSA-P256 fallback if Ed25519 is
 * unavailable or generateKey rejects.
 *
 * Both algorithms produce SPKI DER public key bytes and PKCS8 private key
 * bytes, yielding 32-byte SHA-256 fingerprints.
 */

export type KeyPairAlgorithm = "Ed25519" | "ECDSA-P256";

/**
 * A locally-generated key pair for the local device.
 */
export interface KeyPair {
  /** The algorithm used to generate this key pair. */
  readonly algorithm: KeyPairAlgorithm;
  /**
   * SPKI DER-encoded public key bytes.
   * Same key material regardless of algorithm (Ed25519 raw bytes or
   * ECDSA-P256 uncompressed point, wrapped in SubjectPublicKeyInfo).
   */
  readonly publicKey: Uint8Array;
  /** Web Crypto CryptoKey (private key for signing). */
  readonly privateKey: CryptoKey;
}

/**
 * Generates a cryptographic key pair, preferring Ed25519.
 *
 * Falls back to ECDSA-P256 if:
 * - Ed25519 is not supported by the platform, or
 * - generateKey rejects the Ed25519 algorithm identifier.
 */
export class Keyring {
  /**
   * Generate a new key pair.
   *
   * Tries Ed25519 first; falls back to ECDSA-P256 on failure.
   * Both produce SPKI DER public keys and PKCS8 private keys.
   */
  async generate(): Promise<KeyPair> {
    return await tryEd25519().catch(() => generateEcdsaP256());
  }
}

async function tryEd25519(): Promise<KeyPair> {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: "Ed25519" } as Algorithm,
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;

  const publicKeyBytes = await exportSpki(keyPair.publicKey);
  return {
    algorithm: "Ed25519",
    publicKey: publicKeyBytes,
    privateKey: keyPair.privateKey,
  };
}

async function generateEcdsaP256(): Promise<KeyPair> {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" } as EcKeyGenParams,
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;

  const publicKeyBytes = await exportSpki(keyPair.publicKey);
  return {
    algorithm: "ECDSA-P256",
    publicKey: publicKeyBytes,
    privateKey: keyPair.privateKey,
  };
}

async function exportSpki(publicKey: CryptoKey): Promise<Uint8Array> {
  const spkiDer = await globalThis.crypto.subtle.exportKey("spki", publicKey);
  return new Uint8Array(spkiDer);
}
