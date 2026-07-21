# Plan 009: Daemon shell

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 008
- **Category**: feature

## Why this matters

This phase produces `clipruler daemon` — the foreground process that wires every adapter together,
owns the network service, handles clean shutdown, and exposes an admin channel for the CLI/GUI to
issue commands.

## Current state

After 008: clipboard sync works end-to-end between in-process test nodes. There is no single process
that composes identity + persistence + discovery + transport + clipboard into a running daemon.

## Commands you will need

| Purpose      | Command                                                 |
| ------------ | ------------------------------------------------------- |
| Check        | `deno task check`                                       |
| Test         | `deno task test --allow-net --allow-read --allow-write` |
| Start daemon | `deno run --allow-all main.ts daemon`                   |
| Stop daemon  | `kill -TERM <pid>` (printed on startup)                 |

## Scope

**In scope**:

- `src/shells/composition-root.ts`
- `src/shells/daemon.ts`
- `src/shells/admin/admin-server.ts` (Unix socket / Windows named pipe)
- `src/infrastructure/pid/lockfile.ts` (extended from 003 if needed)
- `tests/integration/daemon_lifecycle_test.ts`

**Out of scope**:

- CLI subcommands (Plan 010 — consumes the admin channel).
- Deno Desktop GUI (Plan 011).

## Dependency note (ROI)

- Admin channel: Unix socket on POSIX (`Deno.listen({ transport: "unix", path: ... })`), named pipe
  on Windows. The wire format is the same `Envelope` used over TLS, length-prefixed JSON.
- Considered and rejected: HTTP server for admin. Adds HTTP parsing surface and a new attack vector
  (any local process can POST). The socket/pipe is file-permission-gated.

## Architecture constraints

- The composition root is the ONLY place that instantiates concrete adapters.
- `clipruler daemon` runs in the foreground. It prints its PID and the admin socket path on startup,
  then blocks.
- SIGINT/SIGTERM triggers graceful shutdown:
  1. Stop accepting new TLS connections.
  2. Stop the UDP beacon.
  3. Close existing peer connections.
  4. Force-flush the logical counter and state store.
  5. Release the PID lock.
  6. Exit 0.
- The admin channel accepts commands: `list`, `pair`, `enable`, `disable`, `forget`, `status`. Each
  is a request/response envelope pair.

## Steps

### Step 1: Composition root

Create `src/shells/composition-root.ts`:

```ts
import { ensureAppDirs, resolveAppPaths } from "../infrastructure/persistence/paths.ts";
import { StateStore } from "../infrastructure/persistence/state-store.ts";
import { ConsoleLogger } from "../infrastructure/logging/console-logger.ts";
import { FileKeyStore } from "../infrastructure/crypto/file-key-store.ts";
import { fingerprintOf, generateIdentity } from "../infrastructure/crypto/identity.ts";
import { PersistentClock } from "../infrastructure/clock/persistent-clock.ts";
import { TlsTcpTransport } from "../infrastructure/transport/tls-tcp.ts";
import { UdpBeacon } from "../infrastructure/discovery/udp-beacon.ts";
import { buildClipboardAdapter } from "../infrastructure/clipboard/mod.ts";
import { PidLock } from "../infrastructure/pid/lockfile.ts";
// Use cases
import { startLocalSync } from "../application/sync-clipboard.ts";
import { startRemoteReceiver } from "../application/receive-clipboard.ts";

export interface RunningDaemon {
  readonly adminSocketPath: string;
  readonly tlsPort: number;
  readonly stop: () => Promise<void>;
}

export async function buildAndRunDaemon(opts: {
  deviceName: string;
}): Promise<RunningDaemon> {
  const logger = new ConsoleLogger("daemon");
  const paths = resolveAppPaths();
  await ensureAppDirs(paths);

  const pid = new PidLock(paths.pidFile, logger);
  await pid.acquire();

  // ... load-or-create state, identity, key store
  // ... build transport, discovery, clipboard adapter
  // ... register use cases
  // ... open admin socket
  // Return { adminSocketPath, tlsPort, stop }
  throw new Error("follow the outline above; the body wires every adapter");
}
```

### Step 2: Admin server

Create `src/shells/admin/admin-server.ts`:

```ts
import type { Logger } from "../../ports/logger.ts";
import type { Envelope } from "../../protocol/envelope.ts";
import { readEnvelope, writeEnvelope } from "../../infrastructure/transport/framing.ts";

export interface AdminServerDeps {
  readonly logger: Logger;
  // Use case callbacks — wired by the composition root.
  readonly onList: () => Promise<unknown>;
  readonly onPair: (fingerprint: string) => Promise<unknown>;
  readonly onEnable: (fingerprint: string, enabled: boolean) => Promise<unknown>;
  readonly onForget: (fingerprint: string) => Promise<unknown>;
  readonly onStatus: () => Promise<unknown>;
}

export async function startAdminServer(
  socketPath: string,
  deps: AdminServerDeps,
): Promise<{ stop: () => Promise<void> }> {
  // On POSIX: Deno.listen({ transport: "unix", path: socketPath })
  // On Windows: fall back to a TCP loopback listener on an ephemeral port
  //   until Deno supports named pipes.
  // Restrict file mode on the socket to 0600 so only the same user can connect.
  throw new Error("implement: accept loop, readEnvelope, dispatch, writeEnvelope");
}
```

> On Windows, fall back to a loopback-only TCP listener on port 0 and write the chosen port to
> `paths.adminEndpoint` so the CLI knows where to connect. Document this deviation in
> `docs/architecture.md` (Plan 012).

### Step 3: Daemon shell entry

Create `src/shells/daemon.ts`:

```ts
import { buildAndRunDaemon } from "./composition-root.ts";

export async function daemonMain(deviceName: string): Promise<void> {
  const running = await buildAndRunDaemon({ deviceName });
  console.log(JSON.stringify({
    adminSocketPath: running.adminSocketPath,
    tlsPort: running.tlsPort,
    pid: Deno.pid,
  }));

  // Wait for SIGINT or SIGTERM, then graceful shutdown.
  const stopSignal = new Promise<void>((resolve) => {
    const handler = () => resolve();
    Deno.addSignalListener("SIGINT", handler);
    Deno.addSignalListener("SIGTERM", handler);
  });
  await stopSignal;
  await running.stop();
}
```

### Step 4: Wire `main.ts` dispatch

Extend `main.ts` from Plan 001 to dispatch the `daemon` subcommand:

```ts
if (args[0] === "daemon") {
  const deviceName = Deno.env.get("CLIPRULER_DEVICE_NAME") ?? Deno.hostname();
  await import("./src/shells/daemon.ts").then((m) => m.daemonMain(deviceName));
  Deno.exit(0);
}
```

### Step 5: Lifecycle integration test

Create `tests/integration/daemon_lifecycle_test.ts`:

- Start the daemon in-process via `buildAndRunDaemon({ deviceName: "test" })`.
- Connect to the admin socket, send a `status` envelope, expect a response.
- Send SIGTERM (Deno.kill(pid, "SIGTERM")).
- Assert:
  - The admin socket file is removed within 2 seconds.
  - The PID lock file is removed.
  - `state.json` was written one last time (logical counter persisted).
  - The process exits 0.

## Test plan

- 1 integration test covering startup, admin status query, graceful shutdown, and cleanup of all
  side-effects (socket, PID file, state file).

## Done criteria

ALL must hold:

- [ ] `deno task check` exits 0
- [ ] `deno lint` exits 0
- [ ] The lifecycle integration test passes 3 consecutive runs
- [ ] No leftover socket/PID file after SIGTERM
- [ ] The admin socket has mode 0600 on POSIX
- [ ] A second `clipruler daemon` invocation exits with a clear "already running as PID X" error
- [ ] `plans/README.md` status row for 009 updated

## STOP conditions

Stop and report if:

- `Deno.listen({ transport: "unix" })` is unsupported on Windows. Use the TCP loopback fallback
  described above and update the plan.
- The graceful shutdown hangs. Each adapter's `stop()` must have a timeout; the composition root
  should `Promise.race([stopAll(), timeout(5_000)])`.
- The PID lock does not survive a crash (stale PID file blocks the next start). The
  `PidLock.acquire` from Plan 003 must check if the PID is alive before overriding; verify it does.

## Maintenance notes

- The admin protocol reuses the wire envelope format so future IPC optimizations (e.g. switching to
  msgpack) require changing only one codec.
- The daemon does not auto-restart on crash. Auto-restart belongs to the OS service wrapper,
  deferred to a later release.
- The composition root is intentionally a function, not a class — it owns the object graph at
  runtime and makes the dependency flow obvious.
