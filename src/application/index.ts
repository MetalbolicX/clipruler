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

export { ForgetDevice } from "./forget-device.ts";
export type { ForgetDeviceDeps, ForgetDeviceInput, ForgetDeviceOutput } from "./forget-device.ts";
export type { DeviceView } from "./forget-device.ts";

// ---------------------------------------------------------------------------
// Clipboard sync (Plan 008)
// ---------------------------------------------------------------------------

export { createRemoteWriteGate, type RemoteWriteGate, startLocalSync } from "./sync-clipboard.ts";
export type { SyncClipboardDeps } from "./sync-clipboard.ts";

export { startRemoteReceiver } from "./receive-clipboard.ts";
export type { ReceiveClipboardDeps } from "./receive-clipboard.ts";
