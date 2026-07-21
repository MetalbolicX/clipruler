/**
 * Unit tests for infrastructure/persistence/state-store.ts.
 *
 * Verifies:
 * - load() returns null when file absent
 * - load() throws CorruptedStateError on malformed JSON
 * - load() throws SchemaVersionMismatchError on wrong schema version
 * - load() returns parsed StateFileV1 on success
 * - save() writes a state file that load() can read back
 * - save() produces no .tmp.* sibling on success (atomic rename verified)
 * - save() can update an existing state file
 *
 * Layer: unit — uses Deno.makeTempDir for isolation; cleans up in finally.
 */
import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStrictEquals,
} from "jsr:@std/assert@^1.0";
import { makeDeviceId } from "../../../../src/domain/device.ts";
import type {
  StateFileV1,
  TrustedDeviceEntry,
} from "../../../../src/infrastructure/persistence/state-file-v1.ts";
import {
  CorruptedStateError,
  SchemaVersionMismatchError,
} from "../../../../src/infrastructure/persistence/errors.ts";
import type { AppPaths } from "../../../../src/infrastructure/persistence/app-paths.ts";
import { StateStore } from "../../../../src/infrastructure/persistence/state-store.ts";

async function makeTempAppPaths(
  prefix = "state-store-test",
): Promise<{ appPaths: AppPaths; cleanup: () => void }> {
  const dir = await Deno.makeTempDir({ prefix });
  const stateFile = dir + "/state.json";
  const pidFile = dir + "/clipruler.pid";
  const appPaths: AppPaths = {
    configDir: dir + "/config",
    dataDir: dir,
    cacheDir: dir + "/cache",
    stateFile,
    pidFile,
    adminEndpointFile: dir + "/admin.endpoint",
  };
  const cleanup = () => {
    Deno.removeSync(dir, { recursive: true });
  };
  return { appPaths, cleanup };
}

function makeState(overrides: Partial<StateFileV1> = {}): StateFileV1 {
  const ownId = makeDeviceId("device-test-1");
  const entry: TrustedDeviceEntry = {
    deviceId: makeDeviceId("device-remote-1"),
    deviceName: "Test Phone",
    publicKeyBase64: "dGVzdGtleWJhc2U2NA==",
    publicKeyAlgorithm: "Ed25519",
    pairedAtEpochMs: 1_700_000_000_000,
    lastSeenEpochMs: 1_701_000_000_000,
    enabled: true,
  };
  return {
    schemaVersion: 1,
    ownDeviceId: ownId,
    trustedDevices: [entry],
    clockCounter: 10,
    ...overrides,
  };
}

Deno.test("load() returns null when file absent", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    const store = new StateStore(appPaths);
    const result = await store.load();
    assertStrictEquals(result, null);
  } finally {
    cleanup();
  }
});

Deno.test("load() throws CorruptedStateError on malformed JSON", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    // Write invalid JSON
    await Deno.writeTextFile(appPaths.stateFile, "{ this is not json }");
    const store = new StateStore(appPaths);
    await assertRejects(
      () => store.load(),
      CorruptedStateError,
    );
  } finally {
    cleanup();
  }
});

Deno.test("load() throws SchemaVersionMismatchError when schemaVersion is not 1", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    const badState = { schemaVersion: 99, ownDeviceId: "x", trustedDevices: [], clockCounter: 0 };
    await Deno.writeTextFile(appPaths.stateFile, JSON.stringify(badState));
    const store = new StateStore(appPaths);
    await assertRejects(
      () => store.load(),
      SchemaVersionMismatchError,
    );
  } finally {
    cleanup();
  }
});

Deno.test("load() returns parsed StateFileV1 on success", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    const state = makeState();
    await Deno.writeTextFile(appPaths.stateFile, JSON.stringify(state));
    const store = new StateStore(appPaths);
    const loaded = await store.load();
    assertExists(loaded);
    assertEquals(loaded.schemaVersion, 1);
    assertEquals(loaded.ownDeviceId, state.ownDeviceId);
    assertEquals(loaded.trustedDevices.length, 1);
    assertEquals(loaded.clockCounter, 10);
  } finally {
    cleanup();
  }
});

Deno.test("save() then load() recovers the same state", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    const state = makeState();
    const store = new StateStore(appPaths);
    await store.save(state);
    const loaded = await store.load();
    assertExists(loaded);
    assertEquals(loaded.ownDeviceId, state.ownDeviceId);
    assertEquals(loaded.clockCounter, state.clockCounter);
    assertEquals(loaded!.trustedDevices[0]!.deviceName, "Test Phone");
  } finally {
    cleanup();
  }
});

Deno.test("save() produces no .tmp.* sibling on success", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    const state = makeState();
    const store = new StateStore(appPaths);
    await store.save(state);

    // List all files in dataDir — must not contain any .tmp.* files
    const entries: string[] = [];
    for await (const e of Deno.readDir(appPaths.dataDir)) {
      entries.push(e.name);
    }
    const tmpFiles = entries.filter((n) => n.includes(".tmp."));
    assertEquals(tmpFiles, [], "no .tmp.* files should remain after save");
  } finally {
    cleanup();
  }
});

Deno.test("save() can update an existing state file", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    const store = new StateStore(appPaths);
    await store.save(makeState({ clockCounter: 1 }));
    await store.save(makeState({ clockCounter: 2 }));
    const loaded = await store.load();
    assertExists(loaded);
    assertEquals(loaded.clockCounter, 2);
  } finally {
    cleanup();
  }
});
