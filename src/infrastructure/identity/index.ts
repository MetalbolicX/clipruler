/**
 * infrastructure/identity/index.ts
 *
 * Barrel — re-exports all identity infrastructure types and classes.
 */

// Key pair types and generation
export type { KeyPair, KeyPairAlgorithm } from "./keyring.ts";
export { Keyring } from "./keyring.ts";

// Public key fingerprint derivation
export { derivePublicKeyFingerprint } from "./fingerprint.ts";

// File-based KeyStore implementation
export { FileKeyStore } from "./file-key-store.ts";
