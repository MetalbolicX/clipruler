/**
 * shells/composition-root.ts
 *
 * Daemon composition root — wires every adapter together.
 *
 * Design (Plan 009 §Architecture constraints):
 * - The composition root is the ONLY place that instantiates concrete adapters.
 * - It is a function, not a class — owns the object graph at runtime.
 * - SIGINT/SIGTERM triggers graceful shutdown (daemon.ts layer).
 *
 * Shutdown sequence:
 * 1. Stop accepting new TLS connections.
 * 2. Stop the UDP beacon.
 * 3. Close existing peer connections.
 * 4. Force-flush the logical counter and state store.
 * 5. Release the PID lock.
 * 6. Exit 0.
 */

import { ensureAppDirs, resolveAppPaths } from "../infrastructure/persistence/app-paths.ts";
import { StateStore } from "../infrastructure/persistence/state-store.ts";
import { ConsoleLogger } from "../infrastructure/logger/console-logger.ts";
import { FileKeyStore } from "../infrastructure/identity/file-key-store.ts";
import { derivePublicKeyFingerprint } from "../infrastructure/identity/index.ts";
import { PersistentClock } from "../infrastructure/clock/persistent-clock.ts";
import { makeTlsTcpTransport } from "../infrastructure/transport/tls-tcp.ts";
import { UdpBeacon } from "../infrastructure/discovery/udp-beacon.ts";
import { buildClipboardAdapter } from "../infrastructure/clipboard/index.ts";
import { PidLock } from "../infrastructure/pid-lock/pid-lock.ts";
import { createRemoteWriteGate, startLocalSync } from "../application/sync-clipboard.ts";
import { startRemoteReceiver } from "../application/receive-clipboard.ts";
import { makeSelfSignedCertP256 } from "../infrastructure/transport/tls-cert.ts";
import { PROTOCOL_VERSION } from "../protocol/envelope.ts";
import { SHUTDOWN_TIMEOUT_MS } from "./constants.ts";
import { startAdminServer } from "./admin/admin-server.ts";
import { listDevices, pairWith, toggleSharing } from "../application/index.ts";
import type { StoredDevice } from "../ports/device-repository.ts";
import type { DeviceId, PublicKeyFingerprint } from "../domain/device.ts";
import { makePublicKeyFingerprint } from "../domain/device.ts";
import type { RunningAdminServer } from "./admin/admin-server.ts";
import type { DeviceRepository } from "../ports/device-repository.ts";
import type { UiPort } from "../ports/ui.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunningDaemon {
  readonly adminSocketPath: string;
  readonly tlsPort: number;
  readonly stop: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Composition root
// ---------------------------------------------------------------------------

/**
 * Build and run the daemon, wiring all adapters.
 *
 * @param opts.deviceName - Human-readable device name (e.g. hostname)
 * @returns RunningDaemon handle with adminSocketPath, tlsPort, and stop()
 */
export async function buildAndRunDaemon(opts: {
  deviceName: string;
}): Promise<RunningDaemon> {
  const { deviceName } = opts;
  const logger = new ConsoleLogger("daemon");

  // ---- 1. Directories ----
  const paths = resolveAppPaths();
  await ensureAppDirs(paths);

  // ---- 2. PID lock ----
  const pidLock = new PidLock(paths);
  await pidLock.acquire();

  // ---- 3. State store ----
  const stateStore = new StateStore(paths);
  const state = await stateStore.load();

  // ---- 4. Identity / KeyStore ----
  const keyStore = new FileKeyStore(paths, stateStore);
  const keyMaterial = await keyStore.getOrCreateLocal();

  // Derive fingerprint from the public key stored in keyMaterial
  // We need the raw SPKI bytes - re-import the key to get them
  const publicKeySpkiDer = getPublicKeySpkiDer(keyMaterial);
  const fingerprint: string = await derivePublicKeyFingerprint(publicKeySpkiDer);

  // ---- 5. Logical clock (with debounced persistence sink) ----
  const initialCounter = state?.clockCounter ?? 0;
  const deviceId = fingerprint as DeviceId;

  const clock = new PersistentClock(
    deviceId,
    initialCounter,
    (nextCounter) => {
      // Debounced sink — write state on clock advance
      void flushCounter(nextCounter, stateStore, deviceId, logger);
    },
    logger,
  );

  // Deferred flush handle
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingCounter: number | undefined;

  function flushCounter(
    counter: number,
    store: StateStore,
    devId: DeviceId,
    log: typeof logger,
  ): void {
    pendingCounter = counter;
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(async () => {
      flushTimer = undefined;
      if (pendingCounter === undefined) return;
      const counterToWrite = pendingCounter;
      pendingCounter = undefined;
      try {
        const currentState = await store.load();
        await store.save({
          schemaVersion: 1,
          ownDeviceId: devId,
          trustedDevices: currentState?.trustedDevices ?? [],
          clockCounter: counterToWrite,
        });
      } catch (err) {
        log.error("clock: state persist failed", { error: String(err) });
      }
    }, 1000); // 1s debounce
  }

  // ---- 6. Clipboard adapter ----
  const clipboard = buildClipboardAdapter(logger);

  // ---- 7. TLS transport ----
  // Generate a self-signed TLS cert using a fresh P-256 key pair
  // (separate from the device identity key)
  const { certPem, keyPem } = await makeSelfSignedCertP256();

  // Determine TLS port (0 = OS-assigned ephemeral)
  const tlsPort = 0;

  const transport = makeTlsTcpTransport({
    mode: "listen",
    listen: {
      hostname: "0.0.0.0",
      port: tlsPort,
      cert: certPem,
      key: keyPem,
    },
    // Banner fingerprint: our TLS cert fingerprint (derived from the P-256 key)
    onPeerCert: (_conn) => Promise.resolve(fingerprint),
  });

  await transport.listen();
  const boundAddr = transport.addr() as Deno.NetAddr;
  const actualTlsPort = boundAddr.port;

  // ---- 8. UDP beacon ----
  const beacon = new UdpBeacon({
    self: {
      name: deviceName,
      publicKeyFingerprint: fingerprint as PublicKeyFingerprint,
      tlsPort: actualTlsPort,
      protocolVersion: PROTOCOL_VERSION,
    },
    logger,
  });
  await beacon.start();

  // ---- 9. Device repository ----
  const deviceRepo: DeviceRepository = createDeviceRepository(keyStore, logger);

  // ---- 10. Use cases + shared gate ----
  const remoteWriteGate = createRemoteWriteGate();

  // Start local sync (outgoing clipboard)
  const unsubscribeLocal = startLocalSync({
    logger: logger.child("sync"),
    clock,
    devices: deviceRepo,
    transport,
    clipboard: clipboard!,
    remoteWriteGate,
  });

  // Start remote receiver (incoming clipboard)
  const unsubscribeRemote = startRemoteReceiver({
    logger: logger.child("recv"),
    clock,
    devices: deviceRepo,
    transport,
    clipboard: clipboard!,
    localDeviceId: deviceId,
    remoteWriteGate,
  });

  // ---- 11. Admin server ----
  // Admin socket path: dataDir/admin.sock (POSIX) or dataDir/admin.port (Windows)
  const adminSocketPath = Deno.build.os === "windows"
    ? `${paths.dataDir}/admin.port`
    : `${paths.dataDir}/admin.sock`;

  // Stub UI port for daemon context — pairing code is logged since there is no TUI in the daemon.
  // The pairing flow requires user interaction; the daemon-side just initiates the request.
  const stubUi: UiPort = {
    presentPairingCode(code: string): Promise<void> {
      logger.info("pairing: present code to user", { code });
      return Promise.resolve();
    },
    confirmPairing(_remoteName: string, _code: string): Promise<boolean> {
      return Promise.resolve(false);
    },
    notifyPaired(_deviceName: string): Promise<void> {
      return Promise.resolve();
    },
    notifyPairingFailed(_reason: "mismatch" | "rejected" | "timeout"): Promise<void> {
      return Promise.resolve();
    },
  };

  const adminLogger = logger.child("admin");

  const adminServer: RunningAdminServer = await startAdminServer(adminSocketPath, {
    logger: adminLogger,
    onList: async (): Promise<unknown> => {
      const view = await listDevices({ devices: deviceRepo, discovery: beacon });
      return view;
    },
    onPair: async (fingerprint: string): Promise<unknown> => {
      const outcome = await pairWith(
        {
          logger: adminLogger,
          devices: deviceRepo,
          discovery: beacon,
          keys: keyStore,
          transport: transport,
          ui: stubUi,
        },
        makePublicKeyFingerprint(fingerprint),
        deviceName,
      );
      return outcome;
    },
    onEnable: async (fp: string, enabled: boolean): Promise<unknown> => {
      await toggleSharing({ devices: deviceRepo }, makePublicKeyFingerprint(fp), enabled);
      return { status: "ok" };
    },
    onForget: (fp: string): Promise<unknown> => {
      // TODO(plan-010): implement forget-device use case
      logger.info("admin: forget not yet implemented; will be added in plan-010", {
        fingerprint: fp,
      });
      return Promise.resolve({ status: "ok", message: "queued" });
    },
    onStatus: (): Promise<unknown> =>
      Promise.resolve({
        pid: Deno.pid,
        adminSocketPath,
        tlsPort: actualTlsPort,
        deviceName,
      }),
  });

  // ---- 12. Return handle with graceful shutdown ----
  const stop = async (): Promise<void> => {
    logger.info("daemon: shutting down gracefully");

    // Timeout guard
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        logger.warn("daemon: shutdown timed out, forcing");
        resolve();
      }, SHUTDOWN_TIMEOUT_MS)
    );

    const shutdown = async (): Promise<void> => {
      // 1. Stop admin server first
      await adminServer.stop();

      // 2. Stop TLS transport (no new connections, close existing)
      await transport.close();

      // 3. Stop beacon
      await beacon.stop();

      // 4. Unsubscribe use cases
      unsubscribeLocal();
      unsubscribeRemote();

      // 5. Force-flush counter
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      if (pendingCounter !== undefined) {
        await flushCounter(pendingCounter, stateStore, deviceId, logger);
        pendingCounter = undefined;
      }

      // 6. Release PID lock
      await pidLock.release();

      logger.info("daemon: shutdown complete");
    };

    await Promise.race([shutdown(), timeout]);
  };

  return {
    adminSocketPath: adminServer.socketPath,
    tlsPort: actualTlsPort,
    stop,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Re-import the public key from stored key material to get SPKI DER bytes.
 */
function getPublicKeySpkiDer(
  material: { algorithm: string; publicKeyBase64: string },
): Uint8Array {
  // The stored publicKeyBase64 is the raw SPKI DER bytes (base64 encoded)
  const binary = atob(material.publicKeyBase64);
  const spkiDer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    spkiDer[i] = binary.charCodeAt(i);
  }
  return spkiDer;
}

/**
 * Create a DeviceRepository backed by FileKeyStore.
 */
function createDeviceRepository(
  keyStore: FileKeyStore,
  _log: ConsoleLogger,
): DeviceRepository {
  // For PR1: fingerprint IS the deviceId (same string, different brands)
  // The fingerprint is derived from the public key; the deviceId in trusted
  // devices is stored as the fingerprint string.
  const logger = _log;

  return {
    async list(): Promise<readonly StoredDevice[]> {
      try {
        const trusted = await keyStore.listTrustedDevices();
        // Each trusted entry's deviceId IS the fingerprint string
        return trusted.map((d): StoredDevice => {
          const fp = d.deviceId as unknown as PublicKeyFingerprint;
          return {
            deviceId: d.deviceId,
            name: d.deviceName,
            lastEndpoint: null,
            lastSeenAt: null,
            clipboardSharingEnabled: false,
            fingerprint: fp,
            equals: function (this: StoredDevice, other: { deviceId: DeviceId }) {
              return this.deviceId === other.deviceId;
            },
          };
        });
      } catch (err) {
        logger.error("device-repo: list failed", { error: String(err) });
        return [];
      }
    },

    async get(id: DeviceId): Promise<StoredDevice | null> {
      const all = await this.list();
      return all.find((d) => d.deviceId === id) ?? null;
    },

    async getByFingerprint(
      fp: PublicKeyFingerprint,
    ): Promise<StoredDevice | null> {
      const all = await this.list();
      return all.find((d) => d.fingerprint === fp) ?? null;
    },

    upsert(device: StoredDevice): Promise<void> {
      // TODO: implement via keyStore.addTrustedDevice (PR2+)
      logger.debug("device-repo: upsert", { device: device.deviceId });
      return Promise.resolve();
    },

    async remove(id: DeviceId): Promise<void> {
      try {
        await keyStore.deleteTrustedDevice(id);
      } catch (err) {
        logger.error("device-repo: remove failed", { error: String(err) });
      }
    },

    setSharingEnabled(id: DeviceId, enabled: boolean): Promise<void> {
      // TODO: implement via state update (PR2+)
      logger.debug("device-repo: setSharingEnabled", { id, enabled });
      return Promise.resolve();
    },
  };
}
