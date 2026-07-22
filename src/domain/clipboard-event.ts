/**
 * domain/clipboard-event.ts
 *
 * Pure domain clipboard event types and version comparison.
 * Zero Deno.* runtime imports.
 */

import type { DeviceId } from "./device.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClipboardEvent = {
  readonly sourceDeviceId: DeviceId;
  readonly counter: number;
  readonly timestamp: number;
  readonly text: string;
};

export type Version = {
  readonly counter: number;
  readonly deviceId: DeviceId;
};

// ---------------------------------------------------------------------------
// Version comparison — total order: counter first, deviceId tie-break
// Returns: -1 (a < b) | 0 (a == b) | 1 (a > b)
// ---------------------------------------------------------------------------

export const compareVersions = (a: Version, b: Version): -1 | 0 | 1 => {
  if (a.counter !== b.counter) {
    return a.counter > b.counter ? 1 : -1;
  }
  // Counters equal — tie-break on deviceId lexicographically
  const aId = a.deviceId as unknown as string;
  const bId = b.deviceId as unknown as string;
  if (aId < bId) return -1;
  if (aId > bId) return 1;
  return 0;
};

// Re-exports for test convenience
export { makeDeviceId } from "./device.ts";
export type { DeviceId } from "./device.ts";
