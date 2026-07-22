/**
 * ports/key-store.ts
 *
 * KeyStore port interface — defines the contract for local key management
 * and peer public key storage.
 */

export type KeyPairAlgorithm = "Ed25519" | "ECDSA-P256";

export interface PrivateKeyMaterial {
  readonly format: "jwk-spki";
  readonly algorithm: KeyPairAlgorithm;
  /** Base64-encoded JWK JSON containing the private key. */
  readonly privateKeyBase64: string;
  /** Base64-encoded SPKI public key bytes. */
  readonly publicKeyBase64: string;
}

export interface KeyStore {
  /** Returns the local keypair, generating one on first call. */
  getOrCreateLocal(): Promise<PrivateKeyMaterial>;
  /** Pin a peer's public key after successful pairing. */
  storePeerPublicKey(fingerprint: string, publicKeyBase64: string): Promise<void>;
  /** Lookup a pinned peer key. Returns null if the peer is not paired. */
  getPeerPublicKey(fingerprint: string): Promise<string | null>;
  /** Forget a peer key after unpairing. */
  deletePeerPublicKey(fingerprint: string): Promise<void>;
}
