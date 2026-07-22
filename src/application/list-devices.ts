/**
 * application/list-devices.ts
 *
 * List paired and available devices use case.
 *
 * Returns the union of stored paired devices and currently visible (reachable)
 * peers, with a reachability cross-reference computed from discovery state.
 */

import type { DeviceRepository, StoredDevice } from "../ports/device-repository.ts";
import type { Discovery } from "../ports/discovery.ts";
import type { DeviceId, PublicKeyFingerprint } from "../domain/device.ts";

export interface ListDevicesDeps {
  readonly devices: DeviceRepository;
  readonly discovery: Discovery;
}

export interface PairedDeviceView {
  readonly deviceId: DeviceId;
  readonly fingerprint: PublicKeyFingerprint;
  readonly name: string;
  readonly sharingEnabled: boolean;
  readonly reachable: boolean;
}

export interface AvailableDeviceView {
  readonly fingerprint: PublicKeyFingerprint;
  readonly name: string;
  readonly remoteAddress: string;
  readonly tlsPort: number;
}

export interface DeviceListView {
  readonly paired: readonly PairedDeviceView[];
  readonly available: readonly AvailableDeviceView[];
}

/**
 * List all paired and available devices with reachability cross-reference.
 *
 * Paired devices come from DeviceRepository; available (unpaired but visible)
 * peers come from Discovery.visible(). A paired device is "reachable" when its
 * fingerprint appears in the visible peer map.
 */
export const listDevices = async (
  deps: ListDevicesDeps,
): Promise<DeviceListView> => {
  const [stored, visible] = await Promise.all([
    deps.devices.list(),
    deps.discovery.visible(),
  ]);
  const visibleFingerprints = new Set(visible.keys());

  const paired: PairedDeviceView[] = stored.map((d: StoredDevice) => ({
    deviceId: d.deviceId,
    fingerprint: d.fingerprint,
    name: d.name,
    sharingEnabled: d.clipboardSharingEnabled,
    reachable: visibleFingerprints.has(d.fingerprint),
  }));

  const pairedFingerprints = new Set(stored.map((d) => d.fingerprint));
  const available: AvailableDeviceView[] = [];
  for (const [fp, sighting] of visible.entries()) {
    if (pairedFingerprints.has(fp)) continue; // already paired — skip
    available.push({
      fingerprint: fp,
      name: sighting.advertisement.name,
      remoteAddress: sighting.remoteAddress,
      tlsPort: sighting.advertisement.tlsPort,
    });
  }

  return { paired, available };
};
