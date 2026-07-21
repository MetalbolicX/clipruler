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
import { makeMessageId } from "../../domain/device.ts";
import { readEnvelope, writeEnvelope } from "../../infrastructure/transport/framing.ts";

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
export async function startAdminServer(
  socketPath: string,
  deps: AdminServerDeps,
): Promise<RunningAdminServer> {
  const os = Deno.build.os;

  if (os === "windows") {
    return await startTcpAdminServer(socketPath, deps);
  }
  return await startUnixAdminServer(socketPath, deps);
}

/**
 * Unix socket admin server (POSIX).
 */
async function startUnixAdminServer(
  socketPath: string,
  deps: AdminServerDeps,
): Promise<RunningAdminServer> {
  const { logger } = deps;

  // Set socket file mode to 0600 — owner read/write only
  try {
    await Deno.chmod(socketPath, 0o600);
  } catch {
    // File may not exist yet; will be created by listen
  }

  let closeFn: () => void = () => {};
  const server = Deno.listen({
    transport: "unix",
    path: socketPath,
  });

  const stopped = new Promise<void>((resolve) => {
    closeFn = () => {
      try {
        server.close();
      } catch {
        // Ignore close errors
      }
      resolve();
    };
  });

  // Accept loop — handle connections concurrently
  (async () => {
    for await (const conn of server) {
      handleUnixConn(conn as Deno.Conn, deps, logger).catch((err) => {
        logger.error("admin-server: connection error", { error: String(err) });
      });
    }
  })();

  return {
    socketPath,
    stop: async () => {
      closeFn();
      await stopped;
    },
  };
}

/**
 * TCP loopback admin server (Windows fallback).
 * Listens on an ephemeral port and writes the chosen port to socketPath file.
 */
async function startTcpAdminServer(
  socketPath: string,
  deps: AdminServerDeps,
): Promise<RunningAdminServer> {
  const { logger } = deps;

  // TCP loopback on port 0 → OS assigns an ephemeral port
  const server = Deno.listen({ transport: "tcp", port: 0, hostname: "127.0.0.1" });
  const addr = server.addr as Deno.NetAddr;
  const port = addr.port;

  // Write the chosen port to socketPath so the CLI knows where to connect
  await Deno.writeTextFile(socketPath, `${port}`);

  let closeFn: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    closeFn = () => {
      try {
        server.close();
      } catch {
        // Ignore close errors
      }
      resolve();
    };
  });

  (async () => {
    for await (const conn of server) {
      handleTcpConn(conn as Deno.TcpConn, deps, logger).catch((err) => {
        logger.error("admin-server: TCP connection error", { error: String(err) });
      });
    }
  })();

  return {
    socketPath,
    stop: async () => {
      closeFn();
      await stopped;
    },
  };
}

/**
 * Handle a single Unix socket connection.
 */
async function handleUnixConn(
  conn: Deno.Conn,
  deps: AdminServerDeps,
  logger: Logger,
): Promise<void> {
  try {
    const reader = conn.readable.getReader();
    const writer = conn.writable.getWriter();
    await handleConnection(reader, writer, deps, logger);
  } finally {
    try {
      conn.close();
    } catch {
      // Ignore
    }
  }
}

/**
 * Handle a single TCP connection.
 */
async function handleTcpConn(
  conn: Deno.TcpConn,
  deps: AdminServerDeps,
  logger: Logger,
): Promise<void> {
  try {
    const reader = conn.readable.getReader();
    const writer = conn.writable.getWriter();
    await handleConnection(reader, writer, deps, logger);
  } finally {
    try {
      conn.close();
    } catch {
      // Ignore
    }
  }
}

/**
 * Shared connection handler for both Unix and TCP.
 */
async function handleConnection(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  deps: AdminServerDeps,
  logger: Logger,
): Promise<void> {
  try {
    const envelope = await readEnvelope(reader);
    const response = await dispatchAdmin(envelope, deps, logger);
    if (response) {
      await writeEnvelope(writer, response);
      await writer.ready;
    }
  } catch (err) {
    logger.error("admin-server: handle error", { error: String(err) });
  } finally {
    try {
      writer.releaseLock();
    } catch {
      // Ignore
    }
  }
}

/**
 * Dispatch an admin envelope to the appropriate callback and return a response.
 */
async function dispatchAdmin(
  envelope: Envelope,
  deps: AdminServerDeps,
  logger: Logger,
): Promise<Envelope | null> {
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
}
