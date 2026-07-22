/**
 * domain/device.ts
 *
 * Pure domain identity primitives: branded nominal IDs and deterministic fingerprint.
 * Zero Deno.* runtime imports — uses globalThis.crypto.subtle for SHA-256.
 * All exports are side-effect-free and immutable.
 */

// ---------------------------------------------------------------------------
// Brand — nominal typing helper
// ---------------------------------------------------------------------------

/**
 * Brand<T,B> makes T nominally typed as B.
 * The `__brand: B` phantom field prevents bare-string cross-assignment
 * at compile time; guards enforce it at runtime too.
 */
export type Brand<T, B extends string> = T & { readonly __brand: B };

// ---------------------------------------------------------------------------
// ID types
// ---------------------------------------------------------------------------

/** Device identity — opaque branded string. */
export type DeviceId = Brand<string, "DeviceId">;

/** Per-message identity — opaque branded string. */
export type MessageId = Brand<string, "MessageId">;

/** Public-key fingerprint — opaque branded string. */
export type PublicKeyFingerprint = Brand<string, "PublicKeyFingerprint">;

// ---------------------------------------------------------------------------
// Guards — runtime validation (also used by factories)
// ---------------------------------------------------------------------------

const DEVICE_BRAND = "DeviceId" as const;
const MESSAGE_BRAND = "MessageId" as const;
const FINGERPRINT_BRAND = "PublicKeyFingerprint" as const;

const isBranded = <T>(value: unknown, brand: string): value is T => {
  return (
    typeof value === "string" &&
    (value as unknown as { __brand?: string }).__brand === brand
  );
};

export const isDeviceId = (value: unknown): value is DeviceId => {
  return isBranded<DeviceId>(value, DEVICE_BRAND);
};

export const isMessageId = (value: unknown): value is MessageId => {
  return isBranded<MessageId>(value, MESSAGE_BRAND);
};

export const isPublicKeyFingerprint = (value: unknown): value is PublicKeyFingerprint => {
  return isBranded<PublicKeyFingerprint>(value, FINGERPRINT_BRAND);
};

// ---------------------------------------------------------------------------
// Factories — trusted boundary for creating branded IDs
// ---------------------------------------------------------------------------

export const makeDeviceId = (raw: string): DeviceId => {
  return raw as DeviceId;
};

export const makeMessageId = (raw: string): MessageId => {
  return raw as MessageId;
};

export const makePublicKeyFingerprint = (raw: string): PublicKeyFingerprint => {
  return raw as PublicKeyFingerprint;
};

// ---------------------------------------------------------------------------
// Device value object
// ---------------------------------------------------------------------------

export class Device {
  readonly deviceId: DeviceId;
  readonly name: string;

  constructor(deviceId: DeviceId, name: string) {
    this.deviceId = deviceId;
    this.name = name;
  }

  equals(other: Device): boolean {
    return this.deviceId === other.deviceId;
  }
}

// ---------------------------------------------------------------------------
// Deterministic fingerprint — SHA-256 via Web Crypto (globalThis.crypto)
// ---------------------------------------------------------------------------

/**
 * Derive a SHA-256 fingerprint from a public key (Uint8Array).
 * Returns a lowercase 64-character hex string (SHA-256 digest).
 * This operation is deterministic: identical input ALWAYS yields identical output.
 */
export const deriveFingerprint = async (key: Uint8Array): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    key as BufferSource,
  );
  return bytesToHex(digest);
};

/**
 * Canonical hex encoding: lowercase, two hex chars per byte.
 */
export const bytesToHex = (buffer: ArrayBuffer): string => {
  const view = new DataView(buffer);
  const parts: string[] = new Array(buffer.byteLength);
  for (let i = 0; i < buffer.byteLength; i++) {
    parts[i] = view.getUint8(i).toString(16).padStart(2, "0");
  }
  return parts.join("");
};
