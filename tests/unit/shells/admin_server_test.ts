/**
 * tests/unit/shells/admin_server_test.ts
 *
 * Unit tests for admin server dispatch logic.
 * Strict TDD: RED first — tests describe expected behavior.
 *
 * Layer: unit — tests dispatch behavior by connecting a real Unix socket client.
 */
import { assertEquals, assertExists } from "jsr:@std/assert@^1.0";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Spy logger — records all calls for assertions. */
class SpyLog {
  readonly errors: Array<{ msg: string; meta: Record<string, unknown> | undefined }> = [];
  debug(_msg: string, _meta?: Record<string, unknown>): void {}
  info(_msg: string, _meta?: Record<string, unknown>): void {}
  warn(_msg: string, _meta?: Record<string, unknown>): void {}
  error(msg: string, meta?: Record<string, unknown>) {
    this.errors.push({ msg, meta });
  }
  child(): SpyLog {
    return this;
  }
}

// ---------------------------------------------------------------------------
// AdminServerDeps factory
// ---------------------------------------------------------------------------

function makeDeps(overrides: {
  onStatus?: () => Promise<unknown>;
  onList?: () => Promise<unknown>;
  onPair?: (fp: string) => Promise<unknown>;
  onEnable?: (fp: string, enabled: boolean) => Promise<unknown>;
  onForget?: (fp: string) => Promise<unknown>;
} = {}): {
  logger: SpyLog;
  deps: {
    logger: SpyLog;
    onStatus: () => Promise<unknown>;
    onList: () => Promise<unknown>;
    onPair: (fp: string) => Promise<unknown>;
    onEnable: (fp: string, enabled: boolean) => Promise<unknown>;
    onForget: (fp: string) => Promise<unknown>;
  };
} {
  const logger = new SpyLog();
  return {
    logger,
    deps: {
      logger,
      onStatus: overrides.onStatus ?? (() =>
        Promise.resolve({
          deviceName: "test-device",
          tlsPort: 12345,
          adminSocketPath: "/tmp/clipruler/admin.sock",
          peerCount: 2,
          knownPeerFingerprints: ["fp1", "fp2"],
        })),
      onList: overrides.onList ?? (() => Promise.resolve({ paired: [], available: [] })),
      onPair: overrides.onPair ?? ((_fp: string) => Promise.resolve({ kind: "ok" })),
      onEnable: overrides.onEnable ?? ((_fp: string, _e: boolean) => Promise.resolve()),
      onForget: overrides.onForget ?? ((_fp: string) => Promise.resolve()),
    },
  };
}

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
 * Uses the FramingReader from the infrastructure layer for consistent framing.
 */
async function sendEnvelopeAndReadResponse(
  sockPath: string,
  envelope: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const conn = await Deno.connect({ transport: "unix", path: sockPath });
  try {
    // Write request
    const wireData = encodeWire(envelope);
    await conn.write(wireData);

    // Read response using the same framing as the server
    // We need to use FramingReader for consistent chunk handling
    const { FramingReader } = await import(
      "../../../src/infrastructure/transport/framing.ts"
    );

    // Use a single reader for the response
    const reader = conn.readable.getReader();
    const fr = new FramingReader(reader);
    const response = await fr.readEnvelope() as unknown as Record<string, unknown>;
    return response;
  } finally {
    try {
      conn.close();
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// RED tests — these should fail against the PR1 stub
// ---------------------------------------------------------------------------

Deno.test("admin.status returns result:ok with status payload", async () => {
  const { deps } = makeDeps({
    onStatus: () =>
      Promise.resolve({
        deviceName: "my-device",
        tlsPort: 54321,
        adminSocketPath: "/tmp/clipruler/admin.sock",
        peerCount: 3,
        knownPeerFingerprints: ["fp-a", "fp-b", "fp-c"],
      }),
  });

  const { startAdminServer } = await import("../../../src/shells/admin/admin-server.ts");
  const tmpDir = await Deno.makeTempDir();
  const sockPath = `${tmpDir}/admin.sock`;

  const server = await startAdminServer(sockPath, deps);
  try {
    const response = await sendEnvelopeAndReadResponse(sockPath, {
      version: 1,
      messageId: "test-msg-id",
      originDeviceId: "test",
      kind: "admin.status",
      payload: {},
    });

    assertEquals(response.kind, "admin.response");
    const payload = response.payload as { status: string; message?: string };
    assertEquals(payload.status, "ok");
    assertExists(payload.message);
    const parsed = JSON.parse(payload.message as string) as Record<string, unknown>;
    assertEquals(parsed["deviceName"], "my-device");
    assertEquals(parsed["tlsPort"], 54321);
    assertEquals(parsed["peerCount"], 3);
  } finally {
    await server.stop();
    try {
      await Deno.remove(sockPath);
    } catch { /* already gone */ }
  }
});

Deno.test("unknown admin kind returns result:error with unknown command message", async () => {
  const { deps } = makeDeps({});
  const { startAdminServer } = await import("../../../src/shells/admin/admin-server.ts");
  const tmpDir = await Deno.makeTempDir();
  const sockPath = `${tmpDir}/admin.sock`;

  const server = await startAdminServer(sockPath, deps);
  try {
    const response = await sendEnvelopeAndReadResponse(sockPath, {
      version: 1,
      messageId: "test-msg-id",
      originDeviceId: "test",
      kind: "admin.notacommand",
      payload: {},
    });

    assertEquals(response.kind, "admin.response");
    const payload = response.payload as { status: string; message?: string };
    assertEquals(payload.status, "error");
    assertExists(payload.message);
    assertEquals(payload.message?.includes("admin.notacommand"), true);
  } finally {
    await server.stop();
    try {
      await Deno.remove(sockPath);
    } catch { /* already gone */ }
  }
});

Deno.test("admin.list returns paired and available devices", async () => {
  const { deps } = makeDeps({
    onList: () =>
      Promise.resolve({
        paired: [
          {
            deviceId: "device-1",
            fingerprint: "fp1",
            name: "Device One",
            sharingEnabled: true,
            reachable: false,
          },
        ],
        available: [],
      }),
  });

  const { startAdminServer } = await import("../../../src/shells/admin/admin-server.ts");
  const tmpDir = await Deno.makeTempDir();
  const sockPath = `${tmpDir}/admin.sock`;

  const server = await startAdminServer(sockPath, deps);
  try {
    const response = await sendEnvelopeAndReadResponse(sockPath, {
      version: 1,
      messageId: "test-msg-id",
      originDeviceId: "test",
      kind: "admin.list",
      payload: {},
    });

    assertEquals(response.kind, "admin.response");
    const payload = response.payload as { status: string; message?: string };
    assertEquals(payload.status, "ok");
    assertExists(payload.message);
    const parsed = JSON.parse(payload.message as string) as {
      paired: Array<Record<string, unknown>>;
    };
    assertEquals(parsed.paired.length, 1);
    assertEquals(parsed.paired[0]!["name"], "Device One");
  } finally {
    await server.stop();
    try {
      await Deno.remove(sockPath);
    } catch { /* already gone */ }
  }
});

Deno.test("admin.enable calls onEnable with true", async () => {
  let calledWithFp = "";
  let calledWithEnabled = false;
  const { deps } = makeDeps({
    onEnable: (fp: string, enabled: boolean) => {
      calledWithFp = fp;
      calledWithEnabled = enabled;
      return Promise.resolve();
    },
  });

  const { startAdminServer } = await import("../../../src/shells/admin/admin-server.ts");
  const tmpDir = await Deno.makeTempDir();
  const sockPath = `${tmpDir}/admin.sock`;

  const server = await startAdminServer(sockPath, deps);
  try {
    const response = await sendEnvelopeAndReadResponse(sockPath, {
      version: 1,
      messageId: "test-msg-id",
      originDeviceId: "test",
      kind: "admin.enable",
      payload: { fingerprint: "test-fp-enable" },
    });

    assertEquals(response.kind, "admin.response");
    const payload = response.payload as { status: string };
    assertEquals(payload.status, "ok");
    assertEquals(calledWithFp, "test-fp-enable");
    assertEquals(calledWithEnabled, true);
  } finally {
    await server.stop();
    try {
      await Deno.remove(sockPath);
    } catch { /* already gone */ }
  }
});

Deno.test("admin.disable calls onEnable with false", async () => {
  let calledWithFp = "";
  let calledWithEnabled = true;
  const { deps } = makeDeps({
    onEnable: (fp: string, enabled: boolean) => {
      calledWithFp = fp;
      calledWithEnabled = enabled;
      return Promise.resolve();
    },
  });

  const { startAdminServer } = await import("../../../src/shells/admin/admin-server.ts");
  const tmpDir = await Deno.makeTempDir();
  const sockPath = `${tmpDir}/admin.sock`;

  const server = await startAdminServer(sockPath, deps);
  try {
    const response = await sendEnvelopeAndReadResponse(sockPath, {
      version: 1,
      messageId: "test-msg-id",
      originDeviceId: "test",
      kind: "admin.disable",
      payload: { fingerprint: "test-fp-disable" },
    });

    assertEquals(response.kind, "admin.response");
    const payload = response.payload as { status: string };
    assertEquals(payload.status, "ok");
    assertEquals(calledWithFp, "test-fp-disable");
    assertEquals(calledWithEnabled, false);
  } finally {
    await server.stop();
    try {
      await Deno.remove(sockPath);
    } catch { /* already gone */ }
  }
});

Deno.test("admin.forget calls onForget with fingerprint", async () => {
  let calledWithFp = "";
  const { deps } = makeDeps({
    onForget: (fp: string) => {
      calledWithFp = fp;
      return Promise.resolve();
    },
  });

  const { startAdminServer } = await import("../../../src/shells/admin/admin-server.ts");
  const tmpDir = await Deno.makeTempDir();
  const sockPath = `${tmpDir}/admin.sock`;

  const server = await startAdminServer(sockPath, deps);
  try {
    const response = await sendEnvelopeAndReadResponse(sockPath, {
      version: 1,
      messageId: "test-msg-id",
      originDeviceId: "test",
      kind: "admin.forget",
      payload: { fingerprint: "forget-fp-abc" },
    });

    assertEquals(response.kind, "admin.response");
    const payload = response.payload as { status: string };
    assertEquals(payload.status, "ok");
    assertEquals(calledWithFp, "forget-fp-abc");
  } finally {
    await server.stop();
    try {
      await Deno.remove(sockPath);
    } catch { /* already gone */ }
  }
});

Deno.test("admin.pair.request returns error (not implemented in PR1 stub)", async () => {
  const { deps } = makeDeps({});
  const { startAdminServer } = await import("../../../src/shells/admin/admin-server.ts");
  const tmpDir = await Deno.makeTempDir();
  const sockPath = `${tmpDir}/admin.sock`;

  const server = await startAdminServer(sockPath, deps);
  try {
    const response = await sendEnvelopeAndReadResponse(sockPath, {
      version: 1,
      messageId: "test-msg-id",
      originDeviceId: "test",
      kind: "admin.pair.request",
      payload: { fingerprint: "remote-fp" },
    });

    // PR1 stub returns error for pair.request
    assertEquals(response.kind, "admin.response");
    const payload = response.payload as { status: string; message?: string };
    assertEquals(payload.status, "error");
  } finally {
    await server.stop();
    try {
      await Deno.remove(sockPath);
    } catch { /* already gone */ }
  }
});

Deno.test("Windows: TCP server writes port to socketPath file", async () => {
  // Only runs on Windows — skip on other platforms
  if (Deno.build.os !== "windows") return;

  const { startAdminServer } = await import("../../../src/shells/admin/admin-server.ts");
  const tmpDir = await Deno.makeTempDir();
  const portFilePath = `${tmpDir}/admin.port`;

  const { deps } = makeDeps({});
  const server = await startAdminServer(portFilePath, deps);
  try {
    const portContent = await Deno.readTextFile(portFilePath);
    const port = parseInt(portContent.trim(), 10);
    assertEquals(typeof port, "number");
    assertEquals(port > 0 && port <= 65535, true);
  } finally {
    await server.stop();
    try {
      await Deno.remove(portFilePath);
    } catch { /* already gone */ }
  }
});
