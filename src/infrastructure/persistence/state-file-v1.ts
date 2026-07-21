/**
 * infrastructure/persistence/state-file-v1.ts
 *
 * Schema definitions for the persisted state file (version 1).
 * Exports TrustedDeviceEntry, StateFileV1 types, and isStateFileV1 guard.
 */

import type { DeviceId } from "../../domain/device.ts";

// ---------------------------------------------------------------------------
// Trusted device entry
// ---------------------------------------------------------------------------

export type PublicKeyAlgorithm = "Ed25519" | "ECDSA-P256";

/**
 * A device that has been paired with the local device.
 * All fields are required unless annotated optional.
 */
export interface TrustedDeviceEntry {
  deviceId: DeviceId;
  deviceName: string;
  /** Base64-encoded public key (raw bytes, not DER). */
  publicKeyBase64: string;
  publicKeyAlgorithm: PublicKeyAlgorithm;
  pairedAtEpochMs: number;
  /** Set when the device is last observed active. Omit to indicate stale. */
  lastSeenEpochMs?: number;
  /** False marks the device as disabled (ignored in pairing decisions). */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// State file root
// ---------------------------------------------------------------------------

/**
 * The persisted state file schema (version 1).
 *
 * schemaVersion: always 1 — if this does not match, refuse to load.
 * ownDeviceId: the local device's identity.
 * trustedDevices: list of known paired devices (may be empty).
 * clockCounter: monotonically increasing counter for the logical clock.
 */
export interface StateFileV1 {
  readonly schemaVersion: 1;
  readonly ownDeviceId: DeviceId;
  readonly trustedDevices: TrustedDeviceEntry[];
  readonly clockCounter: number;
}

// ---------------------------------------------------------------------------
// Runtime type guard
// ---------------------------------------------------------------------------

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Returns true if the given value is a structurally valid StateFileV1.
 * Used at runtime to validate untrusted JSON before deserialising.
 */
export function isStateFileV1(x: unknown): x is StateFileV1 {
  if (!isObject(x)) return false;

  // schemaVersion must be exactly 1
  if ((x as Record<string, unknown>)["schemaVersion"] !== 1) return false;

  // ownDeviceId must be a non-empty string
  if (!isString((x as Record<string, unknown>)["ownDeviceId"])) return false;
  if (((x as Record<string, unknown>)["ownDeviceId"] as string).length === 0) {
    return false;
  }

  // trustedDevices must be an array
  if (!Array.isArray((x as Record<string, unknown>)["trustedDevices"])) {
    return false;
  }

  // clockCounter must be a non-negative integer
  if (!isNumber((x as Record<string, unknown>)["clockCounter"])) return false;
  if ((x as unknown as StateFileV1).clockCounter < 0) return false;

  // Each trusted device entry must pass structural validation
  for (const entry of (x as unknown as StateFileV1).trustedDevices) {
    if (!isTrustedDeviceEntry(entry)) return false;
  }

  return true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTrustedDeviceEntry(x: unknown): x is TrustedDeviceEntry {
  if (!isObject(x)) return false;

  const o = x as Record<string, unknown>;

  if (typeof o["deviceId"] !== "string" || (o["deviceId"] as string).length === 0) {
    return false;
  }
  if (!isString(o["deviceName"])) return false;
  if (!isString(o["publicKeyBase64"])) return false;
  if (!isString(o["publicKeyAlgorithm"])) return false;
  if (
    o["publicKeyAlgorithm"] !== "Ed25519" && o["publicKeyAlgorithm"] !== "ECDSA-P256"
  ) {
    return false;
  }
  if (!isNumber(o["pairedAtEpochMs"])) return false;
  if (o["lastSeenEpochMs"] !== undefined && !isNumber(o["lastSeenEpochMs"])) {
    return false;
  }
  if (!isBoolean(o["enabled"])) return false;

  return true;
}
