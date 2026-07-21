/**
 * Unit tests for application/forget-device.ts.
 *
 * Verifies:
 * - DeviceView type alias is Pick of PairedDeviceView fields
 * - ForgetDeviceInput and ForgetDeviceOutput shapes
 * - ForgetDevice.execute removes known fingerprint and persists
 * - ForgetDevice.execute is no-op for unknown fingerprint (no save)
 *
 * Layer: unit — uses a minimal StateStore mock.
 */
import { assertEquals, assertExists } from "jsr:@std/assert@^1.0";
import type { PairedDeviceView } from "../../../src/application/list-devices.ts";
import type { StateFileV1 } from "../../../src/infrastructure/persistence/state-file-v1.ts";
import type { LogicalClock } from "../../../src/ports/logical-clock.ts";
import type {
  DeviceView,
  ForgetDeviceInput,
  ForgetDeviceOutput,
} from "../../../src/application/forget-device.ts";
import { ForgetDevice } from "../../../src/application/forget-device.ts";
import { makePublicKeyFingerprint, makeDeviceId } from "../../../src/domain/device.ts";

// ---------------------------------------------------------------------------
// FakeClock — deterministic logical clock for testing
// ---------------------------------------------------------------------------

class FakeClock {
  readonly deviceId = makeDeviceId("test-device");
  tick(): Promise<number> {
    return Promise.resolve(42);
  }
  observe(_remote: number): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// MockStateStore — minimal mock for StateStore.load/save
// ---------------------------------------------------------------------------

// StateStore is a concrete class with Deno filesystem deps.
// For unit testing we use a simple in-memory mock.
interface StateStoreMock {
  _state: StateFileV1 | null;
  _saveCalls: StateFileV1[];
  load(): Promise<StateFileV1 | null>;
  save(state: StateFileV1): Promise<void>;
}

function makeMockStore(initial: StateFileV1 | null): StateStoreMock {
  return {
    _state: initial,
    _saveCalls: [],
    async load() {
      return this._state ? structuredClone(this._state) : null;
    },
    async save(state: StateFileV1) {
      this._saveCalls.push(structuredClone(state));
      this._state = structuredClone(state);
    },
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const FP_KNOWN = makePublicKeyFingerprint("a".repeat(64));
const FP_UNKNOWN = makePublicKeyFingerprint("b".repeat(64));
const DEV_ID = makeDeviceId("dev-1");

function makeState(
  trustedDevices: Array<{
    fingerprint: string;
    deviceId: string;
    deviceName: string;
    enabled: boolean;
  }>,
): StateFileV1 {
  return {
    schemaVersion: 1,
    ownDeviceId: DEV_ID,
    trustedDevices: trustedDevices.map((d) => ({
      deviceId: d.deviceId as import("../../../src/domain/device.ts").DeviceId,
      deviceName: d.deviceName,
      publicKeyBase64: d.fingerprint,
      publicKeyAlgorithm: "Ed25519" as const,
      pairedAtEpochMs: 1000,
      enabled: d.enabled,
    })),
    clockCounter: 5,
  };
}

// ---------------------------------------------------------------------------
// DeviceView type alias verification
// ---------------------------------------------------------------------------

Deno.test("DeviceView is Pick<PairedDeviceView, deviceId|fingerprint|name|sharingEnabled>", () => {
  const view: DeviceView = {
    deviceId: DEV_ID,
    fingerprint: FP_KNOWN,
    name: "Test Device",
    sharingEnabled: true,
  };
  assertEquals(view.deviceId, DEV_ID);
  assertEquals(view.fingerprint, FP_KNOWN);
  assertEquals(view.name, "Test Device");
  assertEquals(view.sharingEnabled, true);
});

// ---------------------------------------------------------------------------
// ForgetDeviceInput / ForgetDeviceOutput shapes
// ---------------------------------------------------------------------------

Deno.test("ForgetDeviceInput requires fingerprint", () => {
  const input: ForgetDeviceInput = { fingerprint: FP_KNOWN };
  assertEquals(input.fingerprint, FP_KNOWN);
});

Deno.test("ForgetDeviceOutput contains DeviceView array", () => {
  const output: ForgetDeviceOutput = {
    devices: [{
      deviceId: DEV_ID,
      fingerprint: FP_KNOWN,
      name: "Test Device",
      sharingEnabled: true,
    }],
  };
  assertEquals(output.devices.length, 1);
  assertExists(output.devices[0]);
  assertEquals(output.devices[0]!.deviceId, DEV_ID);
});

// ---------------------------------------------------------------------------
// ForgetDevice removes known fingerprint and persists
// ---------------------------------------------------------------------------

Deno.test("ForgetDevice.execute removes known fingerprint and persists", async () => {
  // Store: one device with fingerprint matching FP_KNOWN
  const store = makeMockStore(makeState([{
    fingerprint: FP_KNOWN,
    deviceId: DEV_ID,
    deviceName: "Test Device",
    enabled: true,
  }]));

  const clock = new FakeClock();
  // The fingerprint parameter identifies the device; internally we filter
  // TrustedDeviceEntry by publicKeyBase64 matching the fingerprint string
  const useCase = new ForgetDevice({
    stateStore: store as unknown as import("../../../src/infrastructure/persistence/state-store.ts").StateStore,
    clock,
  });

  // Use FP_KNOWN as the fingerprint to remove
  const result = await useCase.execute({ fingerprint: FP_KNOWN });

  assertEquals(result.devices.length, 0);
  assertEquals(store._saveCalls.length, 1);
  assertEquals(store._state?.trustedDevices.length, 0);
});

// ---------------------------------------------------------------------------
// ForgetDevice is no-op for unknown fingerprint (no save)
// ---------------------------------------------------------------------------

Deno.test("ForgetDevice.execute is no-op for unknown fingerprint — no save", async () => {
  const store = makeMockStore(makeState([{
    fingerprint: FP_KNOWN,
    deviceId: DEV_ID,
    deviceName: "Test Device",
    enabled: true,
  }]));

  const clock = new FakeClock();
  const useCase = new ForgetDevice({
    stateStore: store as unknown as import("../../../src/infrastructure/persistence/state-store.ts").StateStore,
    clock,
  });

  // FP_UNKNOWN doesn't match any device — no-op, no save
  const result = await useCase.execute({ fingerprint: FP_UNKNOWN });

  assertEquals(result.devices.length, 1);
  assertEquals(store._saveCalls.length, 0);
  assertEquals(result.devices[0]!.fingerprint, FP_KNOWN);
});
