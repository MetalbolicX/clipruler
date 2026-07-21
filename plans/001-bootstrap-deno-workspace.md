# Plan 001: Bootstrap Deno workspace

> **Executor instructions**: Follow this plan step by step. Run every verification command and
> confirm the expected result before moving to the next step. If anything in the "STOP conditions"
> section occurs, stop and report — do not improvise. When done, update the status row in
> `plans/README.md`.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `none` (greenfield), 2026-07-20

## Why this matters

Every later plan assumes a working `deno task` suite (fmt, lint, check, test), a consistent module
graph via JSR imports, and CI parity. Bootstrapping first means the rest of the work is verifiable
from step one.

## Current state

The repo is empty except for `.atl/` and these `plans/`. Deno 2.9.3 is installed with TypeScript
6.0.3 (verified during recon). No `deno.json`, no source files, no tests.

## Commands you will need

| Purpose    | Command                                | Expected on success               |
| ---------- | -------------------------------------- | --------------------------------- |
| Format     | `deno fmt`                             | exit 0                            |
| Lint       | `deno lint`                            | exit 0, no warnings               |
| Type check | `deno check main.ts src/**/*.ts`       | exit 0                            |
| Tests      | `deno test`                            | exit 0, 0 tests passing initially |
| Run smoke  | `deno run --allow-read main.ts --help` | prints help text, exit 0          |

## Scope

**In scope**:

- `deno.json`
- `deno.lock` (auto-generated)
- `.gitignore`
- `README.md` (skeleton)
- `main.ts` (hello-world stub that prints version and exits)
- `src/version.ts` (single source of truth for version)
- `.github/workflows/ci.yml`
- `tests/smoke_test.ts`

**Out of scope**:

- Any feature logic (domain, ports, infrastructure).
- npm-style `package.json` — not needed; JSR is the package source.

## Git workflow

- Branch: `001-bootstrap`
- Conventional commits; example message: `chore: bootstrap deno workspace`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Write `deno.json`

Create `deno.json` at the repo root. Use this exact shape (filled in):

```json
{
  "name": "@clipruler/clipruler",
  "version": "0.1.0",
  "exports": "./main.ts",
  "imports": {
    "@std/cli": "jsr:@std/cli@^1.0",
    "@std/path": "jsr:@std/path@^1.0",
    "@std/fs": "jsr:@std/fs@^1.0",
    "@std/async": "jsr:@std/async@^1.0",
    "@std/crypto": "jsr:@std/crypto@^1.0",
    "@std/encoding": "jsr:@std/encoding@^1.0",
    "@std/uuid": "jsr:@std/uuid@^1.0",
    "@std/testing": "jsr:@std/testing@^1.0",
    "@std/log": "jsr:@std/log@^1.0",
    "@std/bytes": "jsr:@std/bytes@^1.0",
    "@std/streams": "jsr:@std/streams@^1.0",
    "@std/semver": "jsr:@std/semver@^1.0"
  },
  "tasks": {
    "check": "deno check main.ts src/**/*.ts",
    "test": "deno test --allow-read",
    "fmt": "deno fmt",
    "fmt:check": "deno fmt --check",
    "lint": "deno lint",
    "smoke": "deno run --allow-read main.ts --help"
  },
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  },
  "fmt": { "indentWidth": 2, "lineWidth": 100 },
  "lint": {
    "rules": { "tags": ["recommended", "strict"] }
  }
}
```

**Verify**: `deno task fmt` exits 0.

### Step 2: Write `.gitignore`

```
# Deno
deno.lock
# Allow deno.lock if you prefer reproducible installs; remove this line to commit it.

# Build output
dist/
*.prof

# Editor
.vscode/
.idea/
*.swp

# OS
.DS_Store
Thumbs.db

# Local state (created by the daemon at runtime)
.state/
*.pid

# Plans scratch
.scratch/
```

**Verify**: `cat .gitignore` returns the file content.

### Step 3: Write `src/version.ts`

```ts
export const VERSION = "0.1.0";
```

### Step 4: Write `main.ts`

```ts
import { VERSION } from "./src/version.ts";

const HELP = `clipruler ${VERSION}
LAN clipboard sharing.

Usage:
  clipruler daemon     Run the background sync daemon (foreground process)
  clipruler desktop    Run the Deno Desktop tray app (Tier 1 platforms)
  clipruler pair       Pair with a discovered device
  clipruler list       List known and available devices
  clipruler enable     Enable clipboard sharing with a device
  clipruler disable    Disable clipboard sharing with a device
  clipruler forget     Remove a paired device
  clipruler status     Show daemon status
  clipruler --help     Show this help
  clipruler --version  Show version

Platform support:
  Tier 1 (full): Windows x86_64, Linux glibc x86_64/arm64 (Wayland + X11)
  Tier 2 (daemon only): Alpine desktop
  Tier 3 (relay only): Alpine headless / any headless server
`;

const args = Deno.args;
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  Deno.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  Deno.exit(0);
}

console.error("No subcommand provided. Run `clipruler --help`.");
Deno.exit(1);
```

### Step 5: Write `tests/smoke_test.ts`

```ts
import { assertEquals } from "@std/testing/asserts";
import { VERSION } from "../src/version.ts";

Deno.test({
  name: "version is a non-empty semver string",
  fn() {
    assertEquals(/^\d+\.\d+\.\d+$/.test(VERSION), true);
  },
});
```

### Step 6: Write `README.md` skeleton

```markdown
# Clipruler

LAN clipboard sharing between trusted devices.

## Status

v0.1.0 — in development. See `plans/` for the roadmap.

## Quick start
```

deno task smoke

```
## Platform support

See `docs/platform-support.md` (created in Plan 005).

## Architecture

See `docs/architecture.md` (created in Plan 012). Hexagonal: pure domain at the
core, ports as contracts, adapters per platform/runtime, and shells that wire
concrete adapters.

## License

MIT.
```

### Step 7: Write `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.9.3
      - run: deno task fmt:check
      - run: deno lint
      - run: deno task check
      - run: deno task test
```

### Step 8: Cache dependencies

Run `deno cache main.ts tests/smoke_test.ts`. This writes `deno.lock`.

**Verify**: `deno.lock` exists and lists `@std/*` entries.

## Test plan

- New test: `tests/smoke_test.ts` (version regex). Model after no other — this is the first test.
  Pattern: use `Deno.test` + `@std/testing/asserts`.
- Verification: `deno task test` exits 0 with 1 passing test.

## Done criteria

ALL must hold:

- [ ] `deno task fmt:check` exits 0
- [ ] `deno lint` exits 0 with no warnings
- [ ] `deno task check` exits 0
- [ ] `deno task test` exits 0, 1 test passing
- [ ] `deno task smoke` prints help, exit 0
- [ ] `deno.json`, `.gitignore`, `README.md`, `main.ts`, `src/version.ts`, `tests/smoke_test.ts`,
      `.github/workflows/ci.yml` exist
- [ ] No third-party dependencies outside `@std/*` and JSR
- [ ] `plans/README.md` status row for 001 updated

## STOP conditions

Stop and report if:

- Any `@std/*` import fails to resolve on JSR — pin to a specific version and note the exact version
  in `deno.json`.
- `deno check` reports errors on `main.ts` that are not a typo in this plan.
- Deno 2.9.3 is not available in the environment — confirm the version before continuing; do not
  silently upgrade.

## Maintenance notes

- Future phases will add `src/` subdirectories; do not flatten `main.ts` into feature code — keep it
  as the dispatcher.
- `deno.lock`: if reproducible installs are required for CI, un-ignore it in `.gitignore` and commit
  the lockfile.
- The CI matrix grows in Plan 005 (platform-specific clipboard tests) and Plan 012 (cross-compile);
  revisit this workflow then.
