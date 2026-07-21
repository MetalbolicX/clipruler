/**
 * application/toggle-device.ts
 *
 * Toggle clipboard sharing for a paired device use case.
 */

import type { DeviceRepository } from "../ports/device-repository.ts";
import type { PublicKeyFingerprint } from "../domain/device.ts";

export interface ToggleSharingDeps {
  readonly devices: DeviceRepository;
}

/**
 * Enable or disable clipboard sharing for a paired device identified by fingerprint.
 *
 * No-ops when the device is not found (already unpaired).
 */
export async function toggleSharing(
  deps: ToggleSharingDeps,
  fingerprint: PublicKeyFingerprint,
  enabled: boolean,
): Promise<void> {
  const stored = await deps.devices.getByFingerprint(fingerprint);
  if (!stored) return; // no-op when device not found
  await deps.devices.setSharingEnabled(stored.deviceId, enabled);
}
