/**
 * application/index.ts
 *
 * Barrel — re-exports all application-layer use cases and types.
 */

export { pairWith } from "./pair-device.ts";
export type { PairDeviceDeps, PairOutcome } from "./pair-device.ts";

export { listDevices } from "./list-devices.ts";
export type {
  AvailableDeviceView,
  DeviceListView,
  ListDevicesDeps,
  PairedDeviceView,
} from "./list-devices.ts";

export { toggleSharing } from "./toggle-device.ts";
export type { ToggleSharingDeps } from "./toggle-device.ts";
