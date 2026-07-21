# Plan 010: CLI shell + admin channel client

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 009
- **Category**: feature

## Why this matters

This phase produces the user-facing `clipruler` subcommands: `pair`, `list`, `enable`, `disable`,
`forget`, `status`. Each one talks to a running daemon over the admin channel from Plan 009. After
this phase, the project is usable end-to-end from a terminal.

## Current state

After 009: the daemon runs, exposes an admin socket, and accepts request envelopes. `main.ts`
dispatches only `daemon`. No CLI subcommands exist.

## Commands you will need

| Purpose | Command                                                                    |
| ------- | -------------------------------------------------------------------------- |
| Check   | `deno task check`                                                          |
| Test    | `deno task test`                                                           |
| Pair    | `deno run --allow-all main.ts pair <fingerprint>` (against running daemon) |
| List    | `deno run --allow-all main.ts list`                                        |

## Scope

**In scope**:

- `src/shells/cli/mod.ts`
- `src/shells/cli/admin-client.ts`
- `src/shells/cli/render.ts` (output formatting)
- `tests/integration/cli_admin_test.ts`

**Out of scope**:

- GUI (Plan 011).
- TUI/color libraries.

## Dependency note (ROI)

- Argument parsing uses `@std/cli` `parseArgs`. Std.
- Considered and rejected: Cliffy. It would add a dependency for ~5 subcommands with simple arg
  shapes. Revisit if the CLI grows to 20+ subcommands with nested options.

## Steps

### Step 1: Admin client

Create `src/shells/cli/admin-client.ts`:

```ts
import type { Envelope } from "../../protocol/envelope.ts";
import { readEnvelope, writeEnvelope } from "../../infrastructure/transport/framing.ts";

export interface AdminEndpoint {
  /** POSIX: { kind: "unix", path: "/path/to/sock" }. Windows: { kind: "tcp", port: 54321 }. */
  kind: "unix" | "tcp";
  path?: string;
  port?: number;
}

export async function adminCommand(
  endpoint: AdminEndpoint,
  kind: string,
  payload: unknown,
): Promise<unknown> {
  const conn = endpoint.kind === "unix"
    ? await Deno.connect({ transport: "unix", path: endpoint.path! })
    : await Deno.connect({ port: endpoint.port!, hostname: "127.0.0.1" });
  try {
    const env: Envelope<unknown> = {
      v: 1,
      kind: kind as Envelope<unknown>["kind"],
      originDeviceId: "cli",
      messageId: cryptoRandom(),
      payload,
    };
    await writeEnvelope(conn, env);
    const resp = await readEnvelope(conn);
    return resp;
  } finally {
    conn.close();
  }
}

function cryptoRandom(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

> The CLI reads the endpoint from `paths.adminEndpoint` (a tiny file the daemon writes next to
> `state.json`). If the file is missing, the CLI prints a clear "daemon is not running" message and
> exits 2.

### Step 2: Resolve admin endpoint

Add to `src/infrastructure/persistence/paths.ts`:

```ts
export interface AppPaths {
  // ... existing fields
  readonly adminEndpointFile: string; // <configDir>/admin.endpoint
}
```

The daemon writes `{"kind":"unix","path":"..."}` (POSIX) or `{"kind":"tcp","port":54321}` (Windows)
into this file on startup and removes it on shutdown.

### Step 3: Subcommands

Create `src/shells/cli/mod.ts`:

```ts
import { parseArgs } from "@std/cli";
import { readAdminEndpoint } from "./admin-client.ts";
import { renderDevices, renderPairResult, renderStatus } from "./render.ts";

export async function cliMain(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "list":
      return await cmdList(rest);
    case "pair":
      return await cmdPair(rest);
    case "enable":
      return await cmdToggle(rest, true);
    case "disable":
      return await cmdToggle(rest, false);
    case "forget":
      return await cmdForget(rest);
    case "status":
      return await cmdStatus(rest);
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return 0;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printHelp();
      return 2;
  }
}

async function cmdList(_args: string[]): Promise<number> {
  const endpoint = await readAdminEndpoint();
  if (!endpoint) {
    console.error("daemon not running");
    return 2;
  }
  const result = await adminCommand(endpoint, "admin.list", {});
  renderDevices(result);
  return 0;
}

// cmdPair, cmdToggle, cmdForget, cmdStatus follow the same pattern.
```

### Step 4: Render helpers

Create `src/shells/cli/render.ts` with `renderDevices`, `renderStatus`, and `renderPairResult`.
Plain text, no color. Example:

```ts
export function renderDevices(view: unknown): void {
  // view is the JSON from listDevices(); print two sections:
  // "Paired devices:" with name + fingerprint + sharing flag + reachable flag
  // "Available devices:" with name + fingerprint + endpoint
}
```

### Step 5: Wire main.ts

Replace the help-only dispatch in `main.ts` from Plans 001/009:

```ts
import { cliMain } from "./src/shells/cli/mod.ts";
import { daemonMain } from "./src/shells/daemon.ts";

const args = Deno.args;
if (args[0] === "daemon") {
  const deviceName = Deno.env.get("CLIPRULER_DEVICE_NAME") ?? Deno.hostname();
  await daemonMain(deviceName);
  Deno.exit(0);
}
Deno.exit(await cliMain(args));
```

### Step 6: Integration test

Create `tests/integration/cli_admin_test.ts`:

- Start a daemon in-process (Plan 009 harness).
- Use the admin client to call `list`, `status`, `pair` (against a stubbed peer), `enable`,
  `disable`, `forget`.
- Assert each call returns a well-formed response and the daemon's state reflects the change (e.g.
  after `enable`, `list` shows `clipboardSharingEnabled: true` for that device).

## Test plan

- 1 integration test that exercises every subcommand end-to-end against a running in-process daemon.
  6 assertions (one per subcommand).

## Done criteria

ALL must hold:

- [ ] `deno task check` exits 0
- [ ] `deno lint` exits 0
- [ ] The CLI integration test passes
- [ ] `clipruler pair`, `list`, `enable`, `disable`, `forget`, `status` all work against a running
      daemon
- [ ] When the daemon is not running, every subcommand prints a clear error and exits 2
- [ ] No third-party deps outside `@std/cli`
- [ ] `plans/README.md` status row for 010 updated

## STOP conditions

Stop and report if:

- The admin endpoint file race (daemon writes while CLI reads) causes more than 1 in 100 test runs
  to flake. Add a short retry with backoff inside `readAdminEndpoint` (3 attempts, 50ms apart).
- Cliffy would significantly reduce code. Escalate before adding it; the current decision is
  std-only.

## Maintenance notes

- The CLI is intentionally a thin client. All business logic lives in the daemon and the application
  layer.
- For the GUI (Plan 011), the desktop shell will talk to the same admin endpoint so it behaves
  exactly like the CLI.
- A future `clipruler daemon --detach` (post-MVP) would fork and write a pidfile; the current
  foreground design is enough for v0.1.0.
