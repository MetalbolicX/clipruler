/**
 * infrastructure/identity/file-key-store.ts
 *
 * FileKeyStore — persists the local device key pair and peer public keys
 * to the filesystem using the KeyStore port contract.
 *
 * File layout:
 * - <configDir>/clipruler/identity.key   — own key pair (JSON: { algorithm, pkcs8Base64 })
 * - <configDir>/clipruler/fingerprints/  — peer public key blobs keyed by fingerprint
 *
 * The own key pair is stored separately from the state file so it survives
 * state file resets (constraint #1: peer keys persist FOREVER).
 *
 * Trusted device CRUD delegates to StateStore via DeviceRepository.
 */

import { encodeBase64 } from "@std/encoding/base64";
import type { AppPaths } from "../persistence/app-paths.ts";
import { StateStore } from "../persistence/state-store.ts";
import type { StateFileV1, TrustedDeviceEntry } from "../persistence/state-file-v1.ts";
import type { KeyStore, PrivateKeyMaterial } from "../../ports/key-store.ts";
import type { DeviceId } from "../../domain/device.ts";
import type { KeyPair } from "./keyring.ts";

const IDENTITY_FILENAME = "identity.key";
const FINGERPRINTS_DIR = "fingerprints";

/**
 * FileKeyStore — implements the KeyStore port using filesystem storage.
 *
 * The own key pair is stored at <configDir>/clipruler/identity.key.
 * Peer public keys are stored as individual blobs under
 * <configDir>/clipruler/fingerprints/<fingerprint>.
 */
export class FileKeyStore implements KeyStore {
  private readonly identityFile: string;
  private readonly fingerprintsDir: string;
  private ownKeyPair: KeyPair | null = null;

  constructor(
    private readonly appPaths: AppPaths,
    private readonly stateStore: StateStore,
  ) {
    this.identityFile = `${appPaths.configDir}/${IDENTITY_FILENAME}`;
    this.fingerprintsDir = `${appPaths.configDir}/${FINGERPRINTS_DIR}`;
  }

  /**
   * Returns the local key pair, loading from identity.key if present,
   * otherwise generating a new one and persisting it.
   */
  async getOrCreateLocal(): Promise<PrivateKeyMaterial> {
    if (this.ownKeyPair !== null) {
      return await toPrivateKeyMaterial(this.ownKeyPair);
    }

    let kp: KeyPair;

    try {
      const content = await Deno.readTextFile(this.identityFile);
      const parsed = JSON.parse(content) as { algorithm: string; pkcs8Base64: string };
      kp = await importKeyPair(parsed.algorithm as "Ed25519" | "ECDSA-P256", parsed.pkcs8Base64);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        const { Keyring } = await import("./keyring.ts");
        kp = await new Keyring().generate();
        await this.saveOwnKeyPair(kp);
      } else {
        throw err;
      }
    }

    this.ownKeyPair = kp;
    return await toPrivateKeyMaterial(kp);
  }

  /** Internal — loads own KeyPair (without port conversion). */
  async loadOwnKeyPair(): Promise<KeyPair> {
    if (this.ownKeyPair !== null) return this.ownKeyPair;

    let kp: KeyPair;

    try {
      const content = await Deno.readTextFile(this.identityFile);
      const parsed = JSON.parse(content) as { algorithm: string; pkcs8Base64: string };
      kp = await importKeyPair(parsed.algorithm as "Ed25519" | "ECDSA-P256", parsed.pkcs8Base64);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        const { Keyring } = await import("./keyring.ts");
        kp = await new Keyring().generate();
        await this.saveOwnKeyPair(kp);
      } else {
        throw err;
      }
    }

    this.ownKeyPair = kp;
    return kp;
  }

  /**
   * Persists the given key pair to identity.key as JSON:
   * { algorithm: "Ed25519" | "ECDSA-P256", pkcs8Base64: "<base64>" }
   */
  async saveOwnKeyPair(kp: KeyPair): Promise<void> {
    const pkcs8Der = await globalThis.crypto.subtle.exportKey("pkcs8", kp.privateKey);
    const pkcs8Base64 = encodeBase64(new Uint8Array(pkcs8Der));

    const content = JSON.stringify({
      algorithm: kp.algorithm,
      pkcs8Base64,
    });

    await ensureDir(this.appPaths.configDir);

    // Write with 0o600 on POSIX; omit mode on Windows
    const opts: Deno.WriteFileOptions = Deno.build.os === "windows" ? {} : { mode: 0o600 };
    await Deno.writeFile(this.identityFile, new TextEncoder().encode(content), opts);

    this.ownKeyPair = kp;
  }

  async storePeerPublicKey(fingerprint: string, publicKeyBase64: string): Promise<void> {
    await ensureDir(this.fingerprintsDir);
    const blobPath = `${this.fingerprintsDir}/${fingerprint}.blob`;
    const opts: Deno.WriteFileOptions = Deno.build.os === "windows" ? {} : { mode: 0o600 };
    await Deno.writeFile(blobPath, new TextEncoder().encode(publicKeyBase64), opts);
  }

  async getPeerPublicKey(fingerprint: string): Promise<string | null> {
    const blobPath = `${this.fingerprintsDir}/${fingerprint}.blob`;
    try {
      return await Deno.readTextFile(blobPath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
  }

  async deletePeerPublicKey(fingerprint: string): Promise<void> {
    const blobPath = `${this.fingerprintsDir}/${fingerprint}.blob`;
    try {
      await Deno.remove(blobPath);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Trusted device operations — delegate to StateStore via DeviceRepository
  // ---------------------------------------------------------------------------

  /**
   * Lists all trusted devices from the StateFileV1.
   */
  async listTrustedDevices(): Promise<readonly StoredDevice[]> {
    const state = await this.stateStore.load();
    if (!state) return [];
    return state.trustedDevices.map((entry) => toStoredDevice(entry));
  }

  /**
   * Adds a device to the trustedDevices list in StateFileV1.
   */
  async addTrustedDevice(
    device: { id: DeviceId; name: string },
    publicKey: Uint8Array,
  ): Promise<void> {
    const state = await this.stateStore.load();
    const publicKeyBase64 = encodeBase64(publicKey).replace(/\n/g, "");

    const entry: TrustedDeviceEntry = {
      deviceId: device.id,
      deviceName: device.name,
      publicKeyBase64,
      publicKeyAlgorithm: "Ed25519",
      pairedAtEpochMs: Date.now(),
      enabled: true,
    };

    const newState: StateFileV1 = state ?? {
      schemaVersion: 1,
      ownDeviceId: device.id,
      trustedDevices: [],
      clockCounter: 0,
    };

    const existingIdx = newState.trustedDevices.findIndex((d) => d.deviceId === device.id);
    if (existingIdx >= 0) {
      newState.trustedDevices[existingIdx] = entry;
    } else {
      newState.trustedDevices.push(entry);
    }

    await this.stateStore.save(newState);
  }

  /**
   * Removes a device from the trustedDevices list in StateFileV1.
   */
  async deleteTrustedDevice(id: DeviceId): Promise<void> {
    const state = await this.stateStore.load();
    if (!state) return;

    const newState: StateFileV1 = {
      ...state,
      trustedDevices: state.trustedDevices.filter((d) => d.deviceId !== id),
    };

    await this.stateStore.save(newState);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ensureDir = async (path: string): Promise<void> => {
  try {
    await Deno.mkdir(path, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  }
};

const toPrivateKeyMaterial = async (kp: KeyPair): Promise<PrivateKeyMaterial> => {
  const pkcs8Der = await globalThis.crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const pkcs8Bytes = new Uint8Array(pkcs8Der);
  const privateKeyBase64 = encodeBase64(pkcs8Bytes).replace(/\n/g, "");
  const publicKeyBase64 = encodeBase64(kp.publicKey).replace(/\n/g, "");
  return {
    format: "pkcs8-spki",
    algorithm: "Ed25519",
    privateKeyBase64,
    publicKeyBase64,
  };
};

const importKeyPair = async (
  algorithm: "Ed25519" | "ECDSA-P256",
  pkcs8Base64: string,
): Promise<KeyPair> => {
  const binary = atob(pkcs8Base64);
  const pkcs8Der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    pkcs8Der[i] = binary.charCodeAt(i);
  }

  const alg = algorithm === "Ed25519"
    ? { name: "Ed25519" } as const
    : { name: "ECDSA", namedCurve: "P-256" } as const;

  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    pkcs8Der,
    alg,
    true,
    ["sign", "verify"],
  );

  const publicKeySpkiDer = await globalThis.crypto.subtle.exportKey("spki", privateKey);

  return {
    algorithm,
    publicKey: new Uint8Array(publicKeySpkiDer),
    privateKey,
  };
};

interface StoredDevice {
  readonly deviceId: DeviceId;
  readonly deviceName: string;
  readonly lastEndpoint: string | null;
  readonly lastSeenAt: string | null;
  readonly clipboardSharingEnabled: boolean;
}

const toStoredDevice = (entry: TrustedDeviceEntry): StoredDevice => ({
  deviceId: entry.deviceId,
  deviceName: entry.deviceName,
  lastEndpoint: null,
  lastSeenAt: entry.lastSeenEpochMs ? new Date(entry.lastSeenEpochMs).toISOString() : null,
  clipboardSharingEnabled: false,
});
