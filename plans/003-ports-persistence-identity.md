# Plan 003: Ports + persistence + identity

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. Honor STOP conditions.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 002
- **Category**: feature

## Why this matters

This phase defines the contracts (`ports/`) the rest of the system depends on and the first concrete
adapters that satisfy them: atomic JSON persistence, per-device identity via WebCrypto, and a PID
lockfile. These are foundational: every later phase composes them.

## Current state

After 002: `src/domain/` and `src/protocol/` exist with types and tests. No `ports/`, no
`infrastructure/`, no concrete storage. Identity, persistence, and concurrency control are all
undefined.

## Commands you will need

| Purpose            | Command                                                           |
| ------------------ | ----------------------------------------------------------------- |
| Check              | `deno task check`                                                 |
| Test               | `deno task test`                                                  |
| Atomic write smoke | `deno test --allow-read --allow-write tests/unit/infrastructure/` |

## Scope

**In scope**:

- `src/ports/device-repository.ts`
- `src/ports/key-store.ts`
- `src/ports/logical-clock.ts`
- `src/ports/logger.ts`
- `src/ports/index.ts`
- `src/infrastructure/persistence/paths.ts`
- `src/infrastructure/persistence/schema.ts`
- `src/infrastructure/persistence/state-store.ts`
- `src/infrastructure/crypto/identity.ts`
- `src/infrastructure/crypto/fingerprint.ts`
- `src/infrastructure/pid/lockfile.ts`
- `src/infrastructure/logging/console-logger.ts`
- `tests/unit/infrastructure/state_store_test.ts`
- `tests/unit/infrastructure/identity_test.ts`
- `tests/unit/infrastructure/lockfile_test.ts`

**Out of scope**:

- `ports/clipboard-adapter.ts` (Plan 005)
- `ports/transport.ts`, `ports/discovery.ts` (Plans 004, 006)
- Actual TLS cert generation (Plan 004 needs identity; cert helpers live there)
- Pairing code derivation (Plan 007)

## Dependency note (ROI)

- `@std/path` for `join`, `dirname`: std, no question.
- `@std/fs` for `ensureDir`: std.
- `@std/crypto` for SHA-256 fingerprinting: std.
- `@std/encoding/hex`: std.
- WebCrypto `crypto.subtle` for Ed25519: built into Deno, zero deps.
- Considered and rejected: `dnt`, `zod`, `ajv`. Schema validation is hand-rolled because the shape
  is tiny and a validator would be the largest dependency in the project.

## Architecture constraints

- `ports/` files export only `interface` and `type`. No runtime exports, no classes, no functions.
  This guarantees shells are the only composition sites.
- Adapters must be constructable with a logger and a path or config; never reach for globals.

## Steps

### Step 1: Port — logger

Create `src/ports/logger.ts`:

```ts
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}
```

Create `src/infrastructure/logging/console-logger.ts`:

```ts
import type { Logger, LogLevel } from "../../ports/logger.ts";

export class ConsoleLogger implements Logger {
  constructor(private readonly scope = "clipruler") {}

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.emit("debug", msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.emit("info", msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.emit("warn", msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.emit("error", msg, meta);
  }
  child(scope: string): Logger {
    return new ConsoleLogger(`${this.scope}:${scope}`);
  }
  private emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      msg,
      ...meta,
    });
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  }
}
```

**Verify**: `deno check src/infrastructure/logging/console-logger.ts` exits 0.

### Step 2: Port — key store

Create `src/ports/key-store.ts`:

```ts
export interface PrivateKeyMaterial {
  readonly format: "pkcs8-spki";
  readonly algorithm: "Ed25519";
  // Base64 of the raw PKCS8 (private) or SPKI (public) bytes.
  readonly privateKeyBase64: string;
  readonly publicKeyBase64: string;
}

export interface KeyStore {
  /** Returns the local keypair, generating one on first call. */
  getOrCreateLocal(): Promise<PrivateKeyMaterial>;
  /** Pin a peer's public key after successful pairing. */
  storePeerPublicKey(fingerprint: string, publicKeyBase64: string): Promise<void>;
  /** Lookup a pinned peer key. Returns null if the peer is not paired. */
  getPeerPublicKey(fingerprint: string): Promise<string | null>;
  /** Forget a peer key after unpairing. */
  deletePeerPublicKey(fingerprint: string): Promise<void>;
}
```

### Step 3: Port — device repository

Create `src/ports/device-repository.ts`:

```ts
import type { Device, DeviceId } from "../domain/device.ts";

export interface StoredDevice extends Device {
  /** Endpoint hint, e.g. "192.168.1.10:7341". May be stale. */
  readonly lastEndpoint: string | null;
  /** ISO timestamp of last observed reachability. */
  readonly lastSeenAt: string | null;
  /** User-controlled clipboard opt-in, defaults to false. */
  readonly clipboardSharingEnabled: boolean;
}

export interface DeviceRepository {
  list(): Promise<readonly StoredDevice[]>;
  get(id: DeviceId): Promise<StoredDevice | null>;
  upsert(device: StoredDevice): Promise<void>;
  remove(id: DeviceId): Promise<void>;
  setSharingEnabled(id: DeviceId, enabled: boolean): Promise<void>;
}
```

### Step 4: Port — logical clock

Create `src/ports/logical-clock.ts`:

```ts
import type { DeviceId, LogicalCounter } from "../domain/clipboard-event.ts";

export interface LogicalClock {
  /** Advance and return the next local counter value. */
  tick(): Promise<LogicalCounter>;
  /** Observe a remote counter; local clock advances past it if needed. */
  observe(remote: LogicalCounter): Promise<void>;
  /** Bind to a device identity. Used in Version tuples. */
  readonly deviceId: DeviceId;
}
```

> `LogicalCounter` is re-exported from `clipboard-event.ts` in Plan 002; if not, move it to
> `device.ts` and import from there.

### Step 5: Ports barrel

Create `src/ports/index.ts` re-exporting all port interfaces.

**Verify**: `deno check src/ports/index.ts` exits 0.

### Step 6: Persistence — paths

Create `src/infrastructure/persistence/paths.ts`:

```ts
import { join } from "@std/path";
import { ensureDir } from "@std/fs";

export interface AppPaths {
  readonly configDir: string;
  readonly stateFile: string; // <configDir>/state.json
  readonly privateKeyFile: string; // <configDir>/identity.key
  readonly pidFile: string; // <configDir>/clipruler.pid
}

export function resolveAppPaths(appName = "clipruler"): AppPaths {
  const os = Deno.build.os;
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  const base = (() => {
    switch (os) {
      case "darwin":
        return join(home, "Library", "Application Support", appName);
      case "windows": {
        const appdata = Deno.env.get("APPDATA") ?? join(home, "AppData", "Roaming");
        return join(appdata, appName);
      }
      default: {
        const xdg = Deno.env.get("XDG_CONFIG_HOME") ?? join(home, ".config");
        return join(xdg, appName);
      }
    }
  })();
  return {
    configDir: base,
    stateFile: join(base, "state.json"),
    privateKeyFile: join(base, "identity.key"),
    pidFile: join(base, "clipruler.pid"),
  };
}

export async function ensureAppDirs(paths: AppPaths): Promise<void> {
  await ensureDir(paths.configDir);
}
```

**Verify**: `deno check src/infrastructure/persistence/paths.ts` exits 0.

### Step 7: Persistence — schema

Create `src/infrastructure/persistence/schema.ts`:

```ts
export const SCHEMA_VERSION = 1;

export interface StateFileV1 {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly logicalCounter: number;
  readonly trustedDevices: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly publicKeyFingerprint: string;
    readonly publicKeyBase64: string;
    readonly lastEndpoint: string | null;
    readonly lastSeenAt: string | null;
    readonly clipboardSharingEnabled: boolean;
  }>;
}

export function isStateFileV1(value: unknown): value is StateFileV1 {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === SCHEMA_VERSION &&
    typeof v.deviceId === "string" &&
    typeof v.deviceName === "string" &&
    typeof v.logicalCounter === "number" &&
    Array.isArray(v.trustedDevices)
  );
}

export function emptyState(deviceId: string, deviceName: string): StateFileV1 {
  return {
    schemaVersion: SCHEMA_VERSION,
    deviceId,
    deviceName,
    logicalCounter: 0,
    trustedDevices: [],
  };
}
```

### Step 8: Persistence — atomic state store

Create `src/infrastructure/persistence/state-store.ts`:

```ts
import { join } from "@std/path";
import { crypto } from "@std/crypto";
import { encodeBase64 } from "@std/encoding/base64";
import type { Logger } from "../../ports/logger.ts";
import type { StateFileV1 } from "./schema.ts";
import { isStateFileV1 } from "./schema.ts";

/**
 * Atomic file replacement: write to <file>.tmp.<rand>, fsync, rename.
 * The rename is atomic on POSIX and Windows for same-filesystem moves.
 */
export class StateStore {
  constructor(
    private readonly stateFile: string,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<StateFileV1 | null> {
    try {
      const raw = await Deno.readTextFile(this.stateFile);
      const parsed: unknown = JSON.parse(raw);
      if (!isStateFileV1(parsed)) {
        this.logger.error("state.json failed schema validation", { stateFile: this.stateFile });
        return null;
      }
      return parsed;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
  }

  async save(state: StateFileV1): Promise<void> {
    const tmp = await this.tmpPath();
    const text = JSON.stringify(state, null, 2);
    // Write with mode 0600 on POSIX; ignored on Windows.
    const file = await Deno.open(tmp, {
      write: true,
      create: true,
      truncate: true,
      mode: 0o600,
    });
    try {
      await file.write(new TextEncoder().encode(text));
    } finally {
      file.close();
    }
    await Deno.rename(tmp, this.stateFile);
  }

  private async tmpPath(): Promise<string> {
    const rand = encodeBase64(crypto.getRandomValues(new Uint8Array(6)));
    return `${this.stateFile}.tmp.${rand}`;
  }
}
```

**Verify**: `deno check src/infrastructure/persistence/state-store.ts` exits 0.

### Step 9: Crypto — identity

Create `src/infrastructure/crypto/identity.ts`:

```ts
import { crypto } from "@std/crypto";
import { encodeBase64 } from "@std/encoding/base64";
import type { PrivateKeyMaterial } from "../../ports/key-store.ts";

/**
 * Generates an Ed25519 keypair using WebCrypto. Ed25519 is supported in
 * Deno 2.9 via crypto.subtle. Keys are exportable for persistence.
 */
export async function generateIdentity(): Promise<PrivateKeyMaterial> {
  const pair = await crypto.subtle.generateKey(
    "Ed25519",
    true,
    ["sign", "verify"],
  );
  const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return {
    format: "pkcs8-spki",
    algorithm: "Ed25519",
    privateKeyBase64: encodeBase64(new Uint8Array(pkcs8)),
    publicKeyBase64: encodeBase64(new Uint8Array(spki)),
  };
}

export async function fingerprintOf(publicKeyBase64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(publicKeyBase64), (c) => c.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return encodeBase64(new Uint8Array(digest));
}
```

Create `src/infrastructure/crypto/file-key-store.ts` implementing `KeyStore` on top of
`paths.privateKeyFile` (load-or-generate, store under `0600`):

```ts
import * as base64 from "@std/encoding/base64";
import type { KeyStore, PrivateKeyMaterial } from "../../ports/key-store.ts";
import { generateIdentity } from "./identity.ts";

export class FileKeyStore implements KeyStore {
  // ...load private key from path, generate+persist if missing,
  // peer public keys kept in an in-memory map + persisted via state store.
  constructor(
    private readonly privateKeyPath: string,
    private readonly peerKeys: Map<string, string>,
  ) {}
  // Implementations omitted; follow the interface.
}
```

> The executor implements the five methods per the interface. Peer key persistence piggy-backs on
> `StateStore.trustedDevices[].publicKeyBase64`.

### Step 10: PID lockfile

Create `src/infrastructure/pid/lockfile.ts`:

```ts
import type { Logger } from "../../ports/logger.ts";

export class PidLock {
  constructor(
    private readonly pidFile: string,
    private readonly logger: Logger,
  ) {}

  async acquire(): Promise<void> {
    try {
      const existing = await Deno.readTextFile(this.pidFile);
      const pid = Number(existing.trim());
      if (!Number.isNaN(pid) && await this.isAlive(pid)) {
        throw new Error(`Another clipruler daemon is running as PID ${pid}`);
      }
      this.logger.warn("stale pid file found, overriding", { pidFile: this.pidFile });
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    await Deno.writeTextFile(this.pidFile, String(Deno.pid));
  }

  async release(): Promise<void> {
    try {
      await Deno.remove(this.pidFile);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }

  private async isAlive(pid: number): Promise<boolean> {
    try {
      // signal 0: check existence without actually sending a signal.
      Deno.kill(pid, "SIGCONT");
      return true;
    } catch {
      return false;
    }
  }
}
```

**Verify**: `deno check src/infrastructure/pid/lockfile.ts` exits 0.

### Step 11: Unit tests

Create `tests/unit/infrastructure/state_store_test.ts`:

- `tmpDir = await Deno.makeTempDir()`
- Write a `StateFileV1` via `save`, read it back via `load`, assert equal.
- Confirm no `.tmp.*` files remain after save.
- Confirm `load` returns null when file is missing.

Create `tests/unit/infrastructure/identity_test.ts`:

- `generateIdentity()` produces distinct keypairs.
- `fingerprintOf` is stable (same input → same hash).

Create `tests/unit/infrastructure/lockfile_test.ts`:

- `acquire` writes the current PID.
- A second `acquire` in the same process throws (the PID is alive).
- `release` removes the file.

**Verify**: `deno test --allow-read --allow-write tests/unit/infrastructure/` passes all new tests.

## Test plan

- 3 new test files, ~10 tests total. Use `Deno.makeTempDir()` for isolation.
- No tests touch the real config directory; everything goes in temp dirs.

## Done criteria

ALL must hold:

- [ ] `deno task check` exits 0
- [ ] `deno lint` exits 0
- [ ] `deno task test` exits 0; new infrastructure tests pass alongside the domain tests from Plan
      002
- [ ] `src/ports/` contains only interfaces and types (verified by
      `grep -nE "class |function |const |export {" src/ports/` returning only `export {` re-export
      statements)
- [ ] `StateStore.save` leaves no `.tmp.*` files behind
- [ ] Private key file is created with mode `0600` on POSIX
- [ ] No third-party imports outside `@std/*`
- [ ] `plans/README.md` status row for 003 updated

## STOP conditions

Stop and report if:

- `crypto.subtle.generateKey("Ed25519", ...)` returns a result without `publicKey`/`privateKey`
  fields. Deno 2.9 should support this; if not, fall back to `"ECDSA"` with named curve P-256 and
  note the deviation.
- `Deno.open(..., { mode: 0o600 })` is rejected by the type checker on the target platform. Drop the
  `mode` option on Windows and document.
- The PID check via `Deno.kill(pid, "SIGCONT")` throws `ENOSYS` on a platform. Fall back to
  `/proc/<pid>` on Linux or `tasklist` on Windows.

## Maintenance notes

- The state file schema is intentionally minimal. When image/file support lands, add a new
  `schemaVersion` and a migration in `schema.ts`. Never mutate a published schema version.
- Peer public keys currently ride in `StateStore.trustedDevices`. If the peer count grows large
  (hundreds), move to a separate store — but that is well past MVP.
- `FileKeyStore` persists the private key as base64 PKCS8 with `0600`. A future hardening pass could
  add an OS keychain adapter (Keychain, DPAPI, Secret Service) behind the same `KeyStore` interface.
