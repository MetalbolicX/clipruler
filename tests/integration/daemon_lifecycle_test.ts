/**
 * tests/integration/daemon_lifecycle_test.ts
 *
 * Integration test for daemon lifecycle: start, PID file, admin socket,
 * graceful shutdown, and cleanup.
 *
 * Layer: integration — exercises the real composition root with in-process
 * temporary paths; no network, no real TLS certs.
 *
 * Note: UdpBeacon requires Deno.listenDatagram which may not be available
 * in all environments (requires --allow-net + multicast support).
 * This test uses a fake beacon for the beacon dependency.
 *
 * Strict TDD: RED first (this test should fail until PR1 implementation is complete).
 */
import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@^1.0";
import { SHUTDOWN_TIMEOUT_MS } from "../../src/shells/constants.ts";
import { LockHeldError } from "../../src/infrastructure/pid-lock/pid-lock.ts";

// The composition root — only import after understanding the test harness below
// We import dynamically to allow test double injection

Deno.test(
  "daemon lifecycle: SHUTDOWN_TIMEOUT_MS is 5000",
  () => {
    assertEquals(SHUTDOWN_TIMEOUT_MS, 5_000);
  },
);

// NOTE: Full lifecycle integration tests require network/mcast permissions.
// See tests/integration/daemon_lifecycle_test.md for test matrix.
// The following tests are scaffolded and verify type-level correctness only:

Deno.test(
  "daemon lifecycle: constants module exports SHUTDOWN_TIMEOUT_MS",
  async () => {
    const constants = await import("../../src/shells/constants.ts");
    assertEquals(constants.SHUTDOWN_TIMEOUT_MS, 5_000);
  },
);

Deno.test(
  "daemon lifecycle: composition root exports buildAndRunDaemon function",
  async () => {
    const cr = await import("../../src/shells/composition-root.ts");
    // Verify buildAndRunDaemon is a function
    assertEquals(typeof cr.buildAndRunDaemon, "function");
  },
);

Deno.test(
  "daemon lifecycle: daemon module exports daemonMain",
  async () => {
    const daemon = await import("../../src/shells/daemon.ts");
    assertEquals(typeof daemon.daemonMain, "function");
  },
);

Deno.test(
  "daemon lifecycle: admin server exports startAdminServer function",
  async () => {
    const admin = await import("../../src/shells/admin/admin-server.ts");
    assertEquals(typeof admin.startAdminServer, "function");
  },
);

// ---------------------------------------------------------------------------
// Wire format helpers — matching protocol/envelope.ts wire format
// ---------------------------------------------------------------------------

/** Encode an envelope to wire format (length-prefixed JSON). */
function encodeWire(env: Record<string, unknown>): Uint8Array {
  const json = JSON.stringify(env);
  const body = new TextEncoder().encode(json);
  const result = new Uint8Array(4 + body.byteLength);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setUint32(0, body.byteLength, false);
  result.set(body, 4);
  return result;
}

/**
 * Connect to a Unix socket server, send an envelope, and read the response.
 * Uses FramingReader from the infrastructure layer for consistent chunk handling.
 */
async function sendAdminEnvelopeAndReadResponse(
  sockPath: string,
  envelope: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const conn = await Deno.connect({ transport: "unix", path: sockPath });
  try {
    const wireData = encodeWire(envelope);
    await conn.write(wireData);

    // Read 4-byte length prefix
    const lenBuf = new Uint8Array(4);
    let lenRead = 0;
    while (lenRead < 4) {
      const n = await conn.read(lenBuf.subarray(lenRead, 4 - lenRead));
      if (n === null) break;
      lenRead += n;
    }
    const bodyLen = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getUint32(0, false);

    // Read body
    const body = new Uint8Array(bodyLen);
    let bodyRead = 0;
    while (bodyRead < bodyLen) {
      const n = await conn.read(body.subarray(bodyRead, bodyLen - bodyRead));
      if (n === null) break;
      bodyRead += n;
    }

    const json = new TextDecoder().decode(body);
    return JSON.parse(json) as Record<string, unknown>;
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

Deno.test(
  "endpoint file: exists after daemon start, removed after daemon stop",
  async () => {
    const tmpDir = await Deno.makeTempDir();
    const dataDir = `${tmpDir}/clipruler`;
    await Deno.mkdir(dataDir, { recursive: true });

    const origHome = Deno.env.get("HOME");
    const origXdgDataHome = Deno.env.get("XDG_DATA_HOME");
    const origXdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgCacheHome = Deno.env.get("XDG_CACHE_HOME");

    try {
      Deno.env.set("HOME", tmpDir);
      Deno.env.set("XDG_DATA_HOME", tmpDir);
      Deno.env.set("XDG_CONFIG_HOME", tmpDir);
      Deno.env.set("XDG_CACHE_HOME", tmpDir);

      const { buildAndRunDaemon } = await import("../../src/shells/composition-root.ts");
      const { resolveAppPaths } = await import("../../src/infrastructure/persistence/app-paths.ts");

      const daemon = await buildAndRunDaemon({ deviceName: "test-device-endpoint" });

      const paths = resolveAppPaths();
      const endpointFile = paths.adminEndpointFile;

      // (a) Endpoint file must exist after daemon start
      const stat = await Deno.stat(endpointFile);
      assertExists(stat, "endpoint file must exist after daemon start");
      assertEquals(stat.isFile, true);

      // Read and parse the endpoint file — must be valid JSON
      const content = await Deno.readTextFile(endpointFile);
      const endpoint = JSON.parse(content) as { kind: string; path?: string; port?: number };
      if (Deno.build.os === "windows") {
        assertEquals(endpoint.kind, "tcp");
        assertEquals(typeof endpoint.port, "number");
      } else {
        assertEquals(endpoint.kind, "unix");
        assertEquals(typeof endpoint.path, "string");
      }

      await daemon.stop();

      // (b) Endpoint file must be removed after daemon stop
      let gone = false;
      try {
        await Deno.stat(endpointFile);
        gone = false;
      } catch (err) {
        gone = err instanceof Deno.errors.NotFound;
      }
      assertEquals(gone, true, "endpoint file must be removed after daemon stop");
    } finally {
      if (origHome !== undefined) Deno.env.set("HOME", origHome);
      else Deno.env.delete("HOME");
      if (origXdgDataHome !== undefined) Deno.env.set("XDG_DATA_HOME", origXdgDataHome);
      else Deno.env.delete("XDG_DATA_HOME");
      if (origXdgConfigHome !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdgConfigHome);
      else Deno.env.delete("XDG_CONFIG_HOME");
      if (origXdgCacheHome !== undefined) Deno.env.set("XDG_CACHE_HOME", origXdgCacheHome);
      else Deno.env.delete("XDG_CACHE_HOME");

      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* ignore */ }
    }
  },
);

Deno.test(
  "admin.forget: calls ForgetDevice and returns ok (replaces TODO stub)",
  async () => {
    const tmpDir = await Deno.makeTempDir();
    const dataDir = `${tmpDir}/clipruler`;
    await Deno.mkdir(dataDir, { recursive: true });

    const origHome = Deno.env.get("HOME");
    const origXdgDataHome = Deno.env.get("XDG_DATA_HOME");
    const origXdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgCacheHome = Deno.env.get("XDG_CACHE_HOME");

    try {
      Deno.env.set("HOME", tmpDir);
      Deno.env.set("XDG_DATA_HOME", tmpDir);
      Deno.env.set("XDG_CONFIG_HOME", tmpDir);
      Deno.env.set("XDG_CACHE_HOME", tmpDir);

      const { buildAndRunDaemon } = await import("../../src/shells/composition-root.ts");

      const daemon = await buildAndRunDaemon({ deviceName: "test-device-forget" });

      const adminSockPath = `${dataDir}/admin.sock`;

      // Send admin.forget with a fingerprint that does not exist in state
      // The real implementation should return ok (not throw) for unknown fingerprint
      const response = await sendAdminEnvelopeAndReadResponse(adminSockPath, {
        version: 1,
        messageId: "test-msg-forget",
        originDeviceId: "test",
        kind: "admin.forget",
        payload: { fingerprint: "unknown-fp-12345" },
      });

      assertEquals(response.kind, "admin.response");
      const payload = response.payload as { status: string };
      // The real implementation must return ok (stub returned "queued")
      assertEquals(payload.status, "ok");

      await daemon.stop();

      try {
        await Deno.remove(adminSockPath);
      } catch { /* ignore */ }
    } finally {
      if (origHome !== undefined) Deno.env.set("HOME", origHome);
      else Deno.env.delete("HOME");
      if (origXdgDataHome !== undefined) Deno.env.set("XDG_DATA_HOME", origXdgDataHome);
      else Deno.env.delete("XDG_DATA_HOME");
      if (origXdgConfigHome !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdgConfigHome);
      else Deno.env.delete("XDG_CONFIG_HOME");
      if (origXdgCacheHome !== undefined) Deno.env.set("XDG_CACHE_HOME", origXdgCacheHome);
      else Deno.env.delete("XDG_CACHE_HOME");

      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* ignore */ }
    }
  },
);

Deno.test(
  "admin.status round-trip: daemon started, admin socket returns status with tlsPort",
  async () => {
    // Create a temp directory for the daemon's data dir
    const tmpDir = await Deno.makeTempDir();
    const dataDir = `${tmpDir}/clipruler`;
    await Deno.mkdir(dataDir, { recursive: true });

    // Save original env and patch to use temp directory
    const origHome = Deno.env.get("HOME");
    const origXdgDataHome = Deno.env.get("XDG_DATA_HOME");
    const origXdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgCacheHome = Deno.env.get("XDG_CACHE_HOME");

    try {
      Deno.env.set("HOME", tmpDir);
      Deno.env.set("XDG_DATA_HOME", tmpDir);
      Deno.env.set("XDG_CONFIG_HOME", tmpDir);
      Deno.env.set("XDG_CACHE_HOME", tmpDir);

      // Import composition root after env is set
      const { buildAndRunDaemon } = await import("../../src/shells/composition-root.ts");

      const daemon = await buildAndRunDaemon({ deviceName: "test-device-lifecycle" });

      // Determine admin socket path (Unix on POSIX)
      const adminSockPath = `${dataDir}/admin.sock`;

      try {
        // Send admin.status envelope
        const response = await sendAdminEnvelopeAndReadResponse(adminSockPath, {
          version: 1,
          messageId: "test-msg-id",
          originDeviceId: "test",
          kind: "admin.status",
          payload: {},
        });

        // Verify response
        assertEquals(response.kind, "admin.response");
        const payload = response.payload as { status: string; message?: string };
        assertEquals(payload.status, "ok");
        assertExists(payload.message);

        const parsed = JSON.parse(payload.message as string) as Record<string, unknown>;
        assertExists(parsed["tlsPort"], "tlsPort must be present in status response");
        assertEquals(typeof parsed["tlsPort"], "number");
        assertEquals(parsed["pid"], Deno.pid);
        assertEquals(parsed["deviceName"], "test-device-lifecycle");
      } finally {
        await daemon.stop();

        // Clean up admin socket
        try {
          await Deno.remove(adminSockPath);
        } catch {
          // ignore
        }
      }
    } finally {
      // Restore env
      if (origHome !== undefined) Deno.env.set("HOME", origHome);
      else Deno.env.delete("HOME");
      if (origXdgDataHome !== undefined) Deno.env.set("XDG_DATA_HOME", origXdgDataHome);
      else Deno.env.delete("XDG_DATA_HOME");
      if (origXdgConfigHome !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdgConfigHome);
      else Deno.env.delete("XDG_CONFIG_HOME");
      if (origXdgCacheHome !== undefined) Deno.env.set("XDG_CACHE_HOME", origXdgCacheHome);
      else Deno.env.delete("XDG_CACHE_HOME");

      // Clean up temp dir
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch {
        // ignore
      }
    }
  },
);

Deno.test(
  "second daemon invocation rejects with LockHeldError",
  async () => {
    // Create a temp directory for the daemon's data dir
    const tmpDir = await Deno.makeTempDir();
    const dataDir = `${tmpDir}/clipruler`;
    await Deno.mkdir(dataDir, { recursive: true });

    // Save original env and patch to use temp directory
    const origHome = Deno.env.get("HOME");
    const origXdgDataHome = Deno.env.get("XDG_DATA_HOME");
    const origXdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgCacheHome = Deno.env.get("XDG_CACHE_HOME");

    try {
      Deno.env.set("HOME", tmpDir);
      Deno.env.set("XDG_DATA_HOME", tmpDir);
      Deno.env.set("XDG_CONFIG_HOME", tmpDir);
      Deno.env.set("XDG_CACHE_HOME", tmpDir);

      // Import composition root after env is set
      const { buildAndRunDaemon } = await import("../../src/shells/composition-root.ts");

      const daemon = await buildAndRunDaemon({ deviceName: "test-device-lock" });

      try {
        // Attempt to start a second daemon — should throw LockHeldError
        await assertRejects(
          async () => {
            await buildAndRunDaemon({ deviceName: "test-device-lock-second" });
          },
          LockHeldError,
        );
      } finally {
        await daemon.stop();

        // Clean up admin socket
        try {
          await Deno.remove(`${dataDir}/admin.sock`);
        } catch {
          // ignore
        }
      }
    } finally {
      // Restore env
      if (origHome !== undefined) Deno.env.set("HOME", origHome);
      else Deno.env.delete("HOME");
      if (origXdgDataHome !== undefined) Deno.env.set("XDG_DATA_HOME", origXdgDataHome);
      else Deno.env.delete("XDG_DATA_HOME");
      if (origXdgConfigHome !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdgConfigHome);
      else Deno.env.delete("XDG_CONFIG_HOME");
      if (origXdgCacheHome !== undefined) Deno.env.set("XDG_CACHE_HOME", origXdgCacheHome);
      else Deno.env.delete("XDG_CACHE_HOME");

      // Clean up temp dir
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch {
        // ignore
      }
    }
  },
);
