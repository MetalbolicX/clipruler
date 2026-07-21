/**
 * ports/device-repository.ts
 *
 * DeviceRepository port interface — defines the contract for storing
 * and retrieving known peer devices.
 */

import type { Device, DeviceId, PublicKeyFingerprint } from "../domain/device.ts";

export interface StoredDevice extends Device {
  /** Endpoint hint, e.g. "192.168.1.10:7341". May be stale. */
  readonly lastEndpoint: string | null;
  /** ISO timestamp of last observed reachability. */
  readonly lastSeenAt: string | null;
  /** User-controlled clipboard opt-in, defaults to false. */
  readonly clipboardSharingEnabled: boolean;
  /** Public-key fingerprint — stable identity for pairing and transport. */
  readonly fingerprint: PublicKeyFingerprint;
}

export interface DeviceRepository {
  list(): Promise<readonly StoredDevice[]>;
  get(id: DeviceId): Promise<StoredDevice | null>;
  getByFingerprint(fp: PublicKeyFingerprint): Promise<StoredDevice | null>;
  upsert(device: StoredDevice): Promise<void>;
  remove(id: DeviceId): Promise<void>;
  setSharingEnabled(id: DeviceId, enabled: boolean): Promise<void>;
}
