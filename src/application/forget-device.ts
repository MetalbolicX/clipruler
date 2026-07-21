/**
 * application/forget-device.ts
 *
 * Forget device use case — removes a device from the trusted set.
 *
 * Design (Plan 010):
 * - DeviceView is a Pick of PairedDeviceView for the fields we expose
 *   after a device is removed from trust (paired-only projection).
 * - ForgetDevice is a simple use case that:
 *   1. Loads current state
 *   2. Filters out the device with the given fingerprint
 *   3. Saves state if a device was removed (no-op if fingerprint unknown)
 *   4. Returns the updated DeviceView[] (always all remaining paired devices)
 */

import type { PairedDeviceView } from "./list-devices.ts";
import type { StateFileV1 } from "../infrastructure/persistence/state-file-v1.ts";
import type { StateStore } from "../infrastructure/persistence/state-store.ts";
import type { LogicalClock } from "../ports/logical-clock.ts";
import { makePublicKeyFingerprint } from "../domain/device.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Paired-device projection for the forget result.
 * Pick of PairedDeviceView fields — excludes `reachable` which is
 * a discovery-side computed field not stored in state.
 */
export type DeviceView = Pick<
  PairedDeviceView,
  "deviceId" | "fingerprint" | "name" | "sharingEnabled"
>;

export interface ForgetDeviceInput {
  readonly fingerprint: string;
}

export interface ForgetDeviceOutput {
  readonly devices: DeviceView[];
}

// ---------------------------------------------------------------------------
// ForgetDevice use case
// ---------------------------------------------------------------------------

export interface ForgetDeviceDeps {
  readonly stateStore: StateStore;
  readonly clock: LogicalClock;
}

/**
 * ForgetDevice removes a device from the trusted set.
 *
 * - Known fingerprint: removes it, persists state, returns updated list
 * - Unknown fingerprint: no-op (no save), returns current list unchanged
 */
export class ForgetDevice {
  constructor(private readonly deps: ForgetDeviceDeps) {}

  async execute(input: ForgetDeviceInput): Promise<ForgetDeviceOutput> {
    const state = await this.deps.stateStore.load();
    if (!state) {
      return { devices: [] };
    }

    const before = state.trustedDevices.length;
    const updated: StateFileV1 = {
      ...state,
      trustedDevices: state.trustedDevices.filter(
        (d) =>
          d.deviceId !== input.fingerprint &&
          d.publicKeyBase64 !== input.fingerprint,
      ),
    };

    // Only save if something actually changed (known fingerprint case)
    if (updated.trustedDevices.length < before) {
      await this.deps.stateStore.save(updated);
    }

    const devices: DeviceView[] = updated.trustedDevices.map((d) => ({
      deviceId: d.deviceId,
      fingerprint: makePublicKeyFingerprint(d.publicKeyBase64),
      name: d.deviceName,
      sharingEnabled: d.enabled,
    }));

    return { devices };
  }
}
