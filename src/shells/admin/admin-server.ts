/**
 * shells/admin/admin-server.ts
 *
 * Admin server — Unix socket (POSIX) or TCP loopback (Windows) admin channel.
 *
 * Design (Plan 009):
 * - Unix socket on POSIX: Deno.listen({ transport: "unix", path: socketPath })
 * - TCP loopback on Windows: until Deno supports named pipes
 * - File mode 0600 on POSIX — same user only
 * - Wire format: length-prefixed JSON Envelope (same as TLS transport framing)
 * - Admin protocol: request/response envelope pairs
 *
 * PR1 scope: stub — only "admin.status" returns a meaningful response.
 * All other admin kinds return admin.response with error.
 */

import type { Logger } from "../../ports/logger.ts";
import type { Envelope } from "../../protocol/envelope.ts";
import { decodeEnvelope, encodeEnvelope } from "../../protocol/envelope.ts";
import { makeMessageId } from "../../domain/device.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdminServerDeps {
  readonly logger: Logger;
  readonly onList: () => Promise<unknown>;
  readonly onPair: (fingerprint: string) => Promise<unknown>;
  readonly onEnable: (fingerprint: string, enabled: boolean) => Promise<unknown>;
  readonly onForget: (fingerprint: string) => Promise<unknown>;
  readonly onStatus: () => Promise<unknown>;
}

export interface RunningAdminServer {
  readonly socketPath: string;
  readonly stop: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Admin server
// ---------------------------------------------------------------------------

/**
 * Start the admin server on the given socket path.
 *
 * On POSIX: Unix domain socket with mode 0600.
 * On Windows: TCP loopback on an ephemeral port (written to socketPath as a file).
 *
 * @param socketPath - Unix socket path (POSIX) or file containing port (Windows)
 * @param deps - Callback dependencies wired by the composition root
 * @returns RunningAdminServer with socketPath and stop function
 */
export const startAdminServer = async (
  socketPath: string,
  deps: AdminServerDeps,
): Promise<RunningAdminServer> => {
  const os = Deno.build.os;

  if (os === "windows") {
    return await startTcpAdminServer(socketPath, deps);
  }
  return await startUnixAdminServer(socketPath, deps);
};

/**
 * Unix socket admin server (POSIX).
 * Uses explicit .accept() loop instead of for-await to avoid Deno
 * stream buffering issues with Unix domain sockets.
 */
const startUnixAdminServer = async (
  socketPath: string,
  deps: AdminServerDeps,
): Promise<RunningAdminServer> => {
  const { logger } = deps;

  // Remove stale socket file if it exists
  try {
    await Deno.remove(socketPath);
  } catch {
    // Does not exist — that is fine
  }

  const server = Deno.listen({
    transport: "unix",
    path: socketPath,
  });

  // Set socket file mode to 0600 — owner read/write only
  // Note: chmod must happen AFTER listen, not before
  try {
    await Deno.chmod(socketPath, 0o600);
  } catch {
    // Ignore chmod errors (e.g. on Windows where chmod is NOP)
  }

  let closed = false;
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const closeServer = (): void => {
    if (closed) return;
    closed = true;
    try {
      server.close();
    } catch {
      // Ignore
    }
    resolveStopped();
  };

  // Accept loop — handle connections concurrently using explicit .accept()
  (async () => {
    while (!closed) {
      try {
        const conn = await server.accept();
        handleUnixConn(conn, deps, logger).catch((err) => {
          logger.error("admin-server: connection error", { error: String(err) });
        });
      } catch (err) {
        if (closed) break;
        logger.error("admin-server: accept error", { error: String(err) });
      }
    }
  })();

  return {
    socketPath,
    stop: async () => {
      closeServer();
      await stopped;
    },
  };
};

/**
 * TCP loopback admin server (Windows fallback).
 * Listens on an ephemeral port and writes the chosen port to socketPath file.
 */
const startTcpAdminServer = async (
  socketPath: string,
  deps: AdminServerDeps,
): Promise<RunningAdminServer> => {
  const { logger } = deps;

  // TCP loopback on port 0 → OS assigns an ephemeral port
  const server = Deno.listen({ transport: "tcp", port: 0, hostname: "127.0.0.1" });
  const addr = server.addr as Deno.NetAddr;
  const port = addr.port;

  // Write the chosen port to socketPath so the CLI knows where to connect
  // M5 (plan-010): write JSON {kind:"tcp",port} for uniform parsing on both OSes
  await Deno.writeTextFile(socketPath, JSON.stringify({ kind: "tcp", port }));

  let closed = false;
  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const closeServer = (): void => {
    if (closed) return;
    closed = true;
    try {
      server.close();
    } catch {
      // Ignore close errors
    }
    resolveStopped();
  };

  (async () => {
    while (!closed) {
      try {
        const conn = await server.accept();
        handleTcpConn(conn, deps, logger).catch((err) => {
          logger.error("admin-server: TCP connection error", { error: String(err) });
        });
      } catch (err) {
        if (closed) break;
        logger.error("admin-server: TCP accept error", { error: String(err) });
      }
    }
  })();

  return {
    socketPath,
    stop: async () => {
      closeServer();
      await stopped;
    },
  };
};

/**
 * Handle a single Unix socket connection using raw conn.read()/conn.write().
 * We avoid conn.readable.getReader() on Unix sockets due to Deno stream
 * buffering issues with domain sockets; raw conn.read() works correctly.
 */
const handleUnixConn = async (
  conn: Deno.Conn,
  deps: AdminServerDeps,
  logger: Logger,
): Promise<void> => {
  try {
    await handleUnixConnection(conn, deps, logger);
  } catch (err) {
    logger.error("admin-server: handle error", { error: String(err) });
  } finally {
    try {
      conn.close();
    } catch {
      // Ignore
    }
  }
};

/**
 * Handle a Unix socket connection: read envelope, dispatch, write response.
 * Uses conn.read() for reliable reads on Unix sockets.
 */
const handleUnixConnection = async (
  conn: Deno.Conn,
  deps: AdminServerDeps,
  logger: Logger,
): Promise<void> => {
  // Read 4-byte length prefix with partial-read handling
  const lenBuf = new Uint8Array(4);
  let lenRead = 0;
  while (lenRead < 4) {
    const n = await conn.read(lenBuf.subarray(lenRead, 4 - lenRead));
    if (n === null) return; // EOF
    lenRead += n;
  }
  const bodyLen = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getUint32(0, false);

  // Sanity check on body length
  if (bodyLen === 0 || bodyLen > 16 * 1024 * 1024) {
    logger.error("admin-server: invalid body length", { bodyLen });
    return;
  }

  // Read body
  const body = new Uint8Array(bodyLen);
  let bodyRead = 0;
  while (bodyRead < bodyLen) {
    const n = await conn.read(body.subarray(bodyRead, bodyLen - bodyRead));
    if (n === null) return; // EOF
    bodyRead += n;
  }

  // Reconstruct wire: 4-byte length prefix + body (decodeEnvelope expects full wire format)
  const wire = new Uint8Array(4 + bodyLen);
  wire.set(lenBuf, 0);
  wire.set(body, 4);

  // Decode envelope
  let envelope: Envelope;
  try {
    envelope = decodeEnvelope(wire);
  } catch (err) {
    logger.error("admin-server: decode error", { error: String(err), bodyLen });
    return;
  }

  // Dispatch
  const response = await dispatchAdmin(envelope, deps, logger);
  if (!response) return;

  // Encode and send response
  const respWire = encodeEnvelope(response);
  let wireWritten = 0;
  while (wireWritten < respWire.length) {
    const n = await conn.write(respWire.subarray(wireWritten));
    if (n === null) return;
    wireWritten += n;
  }
};

/**
 * Handle a single TCP connection using raw conn.read()/conn.write().
 */
const handleTcpConn = async (
  conn: Deno.TcpConn,
  deps: AdminServerDeps,
  logger: Logger,
): Promise<void> => {
  try {
    await handleTcpConnection(conn, deps, logger);
  } catch (err) {
    logger.error("admin-server: TCP handle error", { error: String(err) });
  } finally {
    try {
      conn.close();
    } catch {
      // Ignore
    }
  }
};

/**
 * Handle a TCP connection: read envelope, dispatch, write response.
 * Uses conn.read() for reliable reads.
 */
const handleTcpConnection = async (
  conn: Deno.TcpConn,
  deps: AdminServerDeps,
  logger: Logger,
): Promise<void> => {
  // Read 4-byte length prefix
  const lenBuf = new Uint8Array(4);
  let lenRead = 0;
  while (lenRead < 4) {
    const n = await conn.read(lenBuf.subarray(lenRead, 4 - lenRead));
    if (n === null) return; // EOF
    lenRead += n;
  }
  const bodyLen = new DataView(lenBuf.buffer, lenBuf.byteOffset, 4).getUint32(0, false);

  // Read body
  const body = new Uint8Array(bodyLen);
  let bodyRead = 0;
  while (bodyRead < bodyLen) {
    const n = await conn.read(body.subarray(bodyRead, bodyLen - bodyRead));
    if (n === null) return; // EOF
    bodyRead += n;
  }

  // Reconstruct wire: 4-byte length prefix + body (decodeEnvelope expects full wire format)
  const wireIn = new Uint8Array(4 + bodyLen);
  wireIn.set(lenBuf, 0);
  wireIn.set(body, 4);

  // Decode envelope
  let envelope: Envelope;
  try {
    envelope = decodeEnvelope(wireIn);
  } catch (err) {
    logger.error("admin-server: TCP decode error", { error: String(err) });
    return;
  }

  // Dispatch
  const response = await dispatchAdmin(envelope, deps, logger);
  if (!response) return;

  // Encode and send response
  const wire = encodeEnvelope(response);
  let wireWritten = 0;
  while (wireWritten < wire.length) {
    const n = await conn.write(wire.subarray(wireWritten));
    if (n === null) return;
    wireWritten += n;
  }
};

/**
 * Dispatch an admin envelope to the appropriate callback and return a response.
 */
const dispatchAdmin = async (
  envelope: Envelope,
  deps: AdminServerDeps,
  logger: Logger,
): Promise<Envelope | null> => {
  const { onList, onEnable, onForget, onStatus } = deps;

  const makeResponse = (
    status: "ok" | "error",
    message?: string,
  ): Envelope => {
    const msgId = makeMessageId(crypto.randomUUID());
    const payload: { status: "ok" | "error"; message?: string } = message !== undefined
      ? { status, message }
      : { status };
    return {
      version: 1,
      messageId: msgId,
      originDeviceId: "daemon",
      kind: "admin.response",
      payload,
    };
  };

  try {
    switch (envelope.kind) {
      case "admin.status": {
        const status = await onStatus();
        const msgId = makeMessageId(crypto.randomUUID());
        return {
          version: 1,
          messageId: msgId,
          originDeviceId: "daemon",
          kind: "admin.response",
          payload: { status: "ok", message: JSON.stringify(status) },
        };
      }
      case "admin.list": {
        const list = await onList();
        const msgId = makeMessageId(crypto.randomUUID());
        return {
          version: 1,
          messageId: msgId,
          originDeviceId: "daemon",
          kind: "admin.response",
          payload: { status: "ok", message: JSON.stringify(list) },
        };
      }
      case "admin.pair.request": {
        // PR2: full pairing implementation
        return makeResponse("error", "pairing not yet implemented (PR2)");
      }
      case "admin.pair.code": {
        // PR2: full pairing implementation
        return makeResponse("error", "pairing not yet implemented (PR2)");
      }
      case "admin.enable": {
        const payload = envelope.payload as { fingerprint: string };
        await onEnable(payload.fingerprint, true);
        return makeResponse("ok");
      }
      case "admin.disable": {
        const payload = envelope.payload as { fingerprint: string };
        await onEnable(payload.fingerprint, false);
        return makeResponse("ok");
      }
      case "admin.forget": {
        const payload = envelope.payload as { fingerprint: string };
        await onForget(payload.fingerprint);
        return makeResponse("ok");
      }
      default:
        return makeResponse("error", `unknown admin kind: ${envelope.kind}`);
    }
  } catch (err) {
    logger.error("admin-server: dispatch error", { error: String(err) });
    return makeResponse("error", String(err));
  }
};
