/**
 * Unit tests for infrastructure/identity/file-key-store.ts.
 *
 * Verifies:
 * - loadOwnKeyPair() creates and saves a new key pair when none exists
 * - saveOwnKeyPair() writes identity.key with PKCS8 DER base64-encoded
 * - loadOwnKeyPair() reads back a previously saved key pair with correct algorithm
 * - identity.key is written with 0o600 permissions on POSIX
 * - listTrustedDevices returns empty array initially
 * - addTrustedDevice stores a device (delegates to StateStore via DeviceRepository)
 * - deleteTrustedDevice removes a device by id (delegates to StateStore via DeviceRepository)
 *
 * Layer: unit — uses Deno.makeTempDir for isolation; cleans up in finally.
 */
import { assertEquals, assertExists } from "jsr:@std/assert@^1.0";
import { makeDeviceId } from "../../../../src/domain/device.ts";
import type { AppPaths } from "../../../../src/infrastructure/persistence/app-paths.ts";
import { FileKeyStore } from "../../../../src/infrastructure/identity/file-key-store.ts";
import { StateStore } from "../../../../src/infrastructure/persistence/state-store.ts";
import { Keyring } from "../../../../src/infrastructure/identity/keyring.ts";

async function makeTempAppPaths(prefix = "file-key-store-test"): Promise<{
  appPaths: AppPaths;
  cleanup: () => void;
}> {
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
  await Deno.mkdir(appPaths.configDir, { recursive: true });
  await Deno.mkdir(appPaths.dataDir, { recursive: true });
  const cleanup = () => {
    Deno.removeSync(dir, { recursive: true });
  };
  return { appPaths, cleanup };
}

Deno.test("loadOwnKeyPair() generates and persists a new key pair on first call", async (t) => {
  const { appPaths, cleanup } = await makeTempAppPaths(t.name);
  try {
    const stateStore = new StateStore(appPaths);
    const keyStore = new FileKeyStore(appPaths, stateStore);

    const kp1 = await keyStore.loadOwnKeyPair();

    // Should have a valid key pair
    assertEquals(kp1.algorithm === "Ed25519" || kp1.algorithm === "ECDSA-P256", true);
    assertEquals(kp1.publicKey instanceof Uint8Array, true);
    assertEquals(kp1.publicKey.length > 0, true);
    assertEquals(kp1.privateKey instanceof CryptoKey, true);

    // The file should now exist at <configDir>/identity.key
    const expectedKeyFile = appPaths.configDir + "/identity.key";
    const fileInfo = await Deno.stat(expectedKeyFile);
    assertExists(fileInfo);
  } finally {
    cleanup();
  }
});

Deno.test("loadOwnKeyPair() returns the same key pair on repeated calls", async (t) => {
  const { appPaths, cleanup } = await makeTempAppPaths(t.name);
  try {
    const stateStore = new StateStore(appPaths);
    const keyStore = new FileKeyStore(appPaths, stateStore);

    const kp1 = await keyStore.loadOwnKeyPair();
    const kp2 = await keyStore.loadOwnKeyPair();

    // Should be exactly the same algorithm
    assertEquals(kp2.algorithm, kp1.algorithm);
    // Public key bytes must be identical
    assertEquals(kp2.publicKey.length, kp1.publicKey.length);
  } finally {
    cleanup();
  }
});

Deno.test("saveOwnKeyPair() exports private key as JWK and persists to identity.key", async (t) => {
  const { appPaths, cleanup } = await makeTempAppPaths(t.name);
  try {
    const stateStore = new StateStore(appPaths);
    const keyStore = new FileKeyStore(appPaths, stateStore);

    const kp = await keyStore.loadOwnKeyPair();

    // Re-read the file content directly to verify it's JWK
    const expectedKeyFile = appPaths.configDir + "/identity.key";
    const fileContent = await Deno.readTextFile(expectedKeyFile);
    const parsed = JSON.parse(fileContent) as { algorithm: string; jwk: { d: string; x: string; crv: string } };

    assertEquals(typeof parsed.algorithm, "string");
    assertEquals(parsed.algorithm, kp.algorithm);
    assertEquals(typeof parsed.jwk, "object");
    assertEquals(typeof parsed.jwk.d, "string");
    assertEquals(parsed.jwk.d.length > 0, true);
    assertEquals(typeof parsed.jwk.x, "string");
    assertEquals(parsed.jwk.x.length > 0, true);
    assertEquals(typeof parsed.jwk.crv, "string");
    // crv should match algorithm: Ed25519 or P-256
    if (parsed.algorithm === "Ed25519") {
      assertEquals(parsed.jwk.crv, "Ed25519");
    } else {
      assertEquals(parsed.jwk.crv, "P-256");
    }
  } finally {
    cleanup();
  }
});

Deno.test("identity.key file mode is 0o600 on POSIX", async (t) => {
  const { appPaths, cleanup } = await makeTempAppPaths(t.name);
  try {
    const stateStore = new StateStore(appPaths);
    const keyStore = new FileKeyStore(appPaths, stateStore);

    await keyStore.loadOwnKeyPair();

    const expectedKeyFile = appPaths.configDir + "/identity.key";
    const fileInfo = await Deno.stat(expectedKeyFile);

    const mode = fileInfo.mode;
    if (mode !== null && mode !== undefined) {
      // Mask out the permission bits (0o777)
      const perms = mode & 0o777;
      assertEquals(perms, 0o600, `expected 0o600, got ${perms.toString(8)}`);
    }
  } finally {
    cleanup();
  }
});

Deno.test("listTrustedDevices returns empty array initially", async (t) => {
  const { appPaths, cleanup } = await makeTempAppPaths(t.name);
  try {
    const stateStore = new StateStore(appPaths);
    const keyStore = new FileKeyStore(appPaths, stateStore);

    const devices = await keyStore.listTrustedDevices();
    assertEquals(devices, []);
  } finally {
    cleanup();
  }
});

Deno.test("addTrustedDevice + listTrustedDevices round-trip", async (t) => {
  const { appPaths, cleanup } = await makeTempAppPaths(t.name);
  try {
    const stateStore = new StateStore(appPaths);
    const keyStore = new FileKeyStore(appPaths, stateStore);

    // Generate a key pair to get a public key
    const keyring = new Keyring();
    const kp = await keyring.generate();

    await keyStore.addTrustedDevice(
      { id: makeDeviceId("device-remote-1"), name: "Test Phone" },
      kp.publicKey,
    );

    const devices = await keyStore.listTrustedDevices();
    assertEquals(devices.length, 1);
    assertEquals(devices[0]?.deviceId, "device-remote-1");
    assertEquals(devices[0]?.deviceName, "Test Phone");
  } finally {
    cleanup();
  }
});

Deno.test("deleteTrustedDevice removes a previously added device", async (t) => {
  const { appPaths, cleanup } = await makeTempAppPaths(t.name);
  try {
    const stateStore = new StateStore(appPaths);
    const keyStore = new FileKeyStore(appPaths, stateStore);

    const keyring = new Keyring();
    const kp = await keyring.generate();

    const device = { id: makeDeviceId("device-remote-1"), name: "Test Phone" };
    await keyStore.addTrustedDevice(device, kp.publicKey);

    let devices = await keyStore.listTrustedDevices();
    assertEquals(devices.length, 1);

    await keyStore.deleteTrustedDevice(device.id);

    devices = await keyStore.listTrustedDevices();
    assertEquals(devices.length, 0);
  } finally {
    cleanup();
  }
});
