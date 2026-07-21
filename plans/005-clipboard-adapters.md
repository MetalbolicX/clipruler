# Plan 005: Clipboard adapter layer

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 003
- **Category**: feature

## Why this matters

Clipboard access is the most platform-specific part of the project. A clean adapter boundary means
each platform gets exactly one well-tested implementation and a `NullAdapter` fallback that lets the
daemon run on headless machines as a relay.

## Current state

After 003/004: ports exist, persistence works. No clipboard port yet, no adapters. The plan also
produces `docs/platform-support.md` as the authoritative matrix.

## Commands you will need

| Purpose           | Command                                                                  |
| ----------------- | ------------------------------------------------------------------------ |
| Check             | `deno task check`                                                        |
| Test              | `deno task test`                                                         |
| Linux wl smoke    | `deno test --allow-run --allow-env --filter "wl-clipboard"`              |
| Linux xclip smoke | `deno test --allow-run --allow-env --filter "xclip"`                     |
| Windows smoke     | `deno test --allow-run --allow-env --filter "powershell"` (Windows only) |

## Scope

**In scope**:

- `src/ports/clipboard-adapter.ts`
- `src/infrastructure/clipboard/detector.ts`
- `src/infrastructure/clipboard/wl-clipboard.ts`
- `src/infrastructure/clipboard/xclip.ts`
- `src/infrastructure/clipboard/powershell.ts`
- `src/infrastructure/clipboard/null-adapter.ts`
- `src/infrastructure/clipboard/mod.ts` (factory)
- `tests/unit/infrastructure/detector_test.ts`
- `tests/integration/clipboard_smoke_test.ts`
- `docs/platform-support.md`

**Out of scope**:

- macOS adapter (post-MVP).
- Images and files (post-MVP).

## Dependency note (ROI)

- No third-party dependencies. All clipboard backends use `Deno.Command` to invoke platform CLI
  tools (`wl-paste`, `wl-copy`, `xclip`, `xsel`,
  `powershell.exe -Command Get-Clipboard/Set-Clipboard`).
- Considered and rejected: FFI bindings to `user32.dll`, native Wayland protocol bindings. Both add
  platform-specific native code; subprocess calls are good enough for MVP polling intervals (1–2s).

## Architecture constraints

- `ClipboardAdapter` is the port. It has `read()`, `write()`, and `subscribe(handler)` for change
  notifications.
- The detector returns one of the concrete adapter classes; the factory instantiates it.
- The `NullAdapter` returns empty content, never notifies, and `write()` is a no-op. This is the
  relay-only path.
- Adapters must be cheap to construct; they do not start subprocesses until the first
  `read()`/`write()`/`subscribe()` call.

## Steps

### Step 1: Port — clipboard adapter

Create `src/ports/clipboard-adapter.ts`:

```ts
export interface ClipboardContent {
  readonly text: string;
  readonly isPassword: boolean;
}

export interface ClipboardAdapter {
  /** Read current clipboard content. */
  read(): Promise<ClipboardContent>;
  /** Overwrite the clipboard. */
  write(content: ClipboardContent): Promise<void>;
  /**
   * Subscribe to clipboard changes. The handler fires on local user-driven
   * changes AND on writes performed by this adapter. The caller is
   * responsible for deduplication (see conflict-resolver).
   */
  subscribe(handler: (content: ClipboardContent) => void): () => void;
  /** Human-readable name, e.g. "wl-clipboard", "powershell". */
  readonly name: string;
}
```

### Step 2: Detector

Create `src/infrastructure/clipboard/detector.ts`:

```ts
export type DetectedBackend =
  | "windows-powershell"
  | "linux-wl"
  | "linux-xclip"
  | "macos-pbcopy"
  | "null";

export interface DetectionResult {
  readonly backend: DetectedBackend;
  readonly reason: string;
}

export function detectBackend(env: {
  WAYLAND_DISPLAY?: string;
  DISPLAY?: string;
  os: typeof Deno.build.os;
}): DetectionResult {
  if (env.os === "windows") {
    return { backend: "windows-powershell", reason: "Deno.build.os === 'windows'" };
  }
  if (env.os === "darwin") return { backend: "macos-pbcopy", reason: "Deno.build.os === 'darwin'" };
  if (env.WAYLAND_DISPLAY) {
    return { backend: "linux-wl", reason: `WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY}` };
  }
  if (env.DISPLAY) return { backend: "linux-xclip", reason: `DISPLAY=${env.DISPLAY}` };
  return {
    backend: "null",
    reason: "no WAYLAND_DISPLAY or DISPLAY on a non-Windows/darwin host",
  };
}

export function detectFromEnv(): DetectionResult {
  return detectBackend({
    WAYLAND_DISPLAY: Deno.env.get("WAYLAND_DISPLAY"),
    DISPLAY: Deno.env.get("DISPLAY"),
    os: Deno.build.os,
  });
}
```

### Step 3: wl-clipboard adapter

Create `src/infrastructure/clipboard/wl-clipboard.ts`:

```ts
import type { ClipboardAdapter, ClipboardContent } from "../../ports/clipboard-adapter.ts";

export class WlClipboardAdapter implements ClipboardAdapter {
  readonly name = "wl-clipboard";
  private timer: number | null = null;
  private lastText = "";
  private readonly handlers = new Set<(c: ClipboardContent) => void>();

  async read(): Promise<ClipboardContent> {
    const out = await run(["wl-paste", "--no-newline"]);
    return { text: out, isPassword: false };
  }

  async write(content: ClipboardContent): Promise<void> {
    const proc = new Deno.Command("wl-copy", {
      stdin: "piped",
    }).spawn();
    const w = proc.stdin.getWriter();
    await w.write(new TextEncoder().encode(content.text));
    await w.close();
    await proc.status;
  }

  subscribe(handler: (c: ClipboardContent) => void): () => void {
    this.handlers.add(handler);
    if (this.timer === null) {
      this.timer = setInterval(() => void this.poll(), 1000);
    }
    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  private async poll(): Promise<void> {
    const text = (await run(["wl-paste", "--no-newline"])).trim();
    if (text !== this.lastText) {
      this.lastText = text;
      const content = { text, isPassword: false };
      for (const h of this.handlers) h(content);
    }
  }
}

async function run(cmd: string[]): Promise<string> {
  const proc = new Deno.Command(cmd[0]!, { args: cmd.slice(1), stdout: "piped" }).spawn();
  const { stdout } = await proc.output();
  return new TextDecoder().decode(stdout);
}
```

### Step 4: xclip adapter (with xsel fallback)

Create `src/infrastructure/clipboard/xclip.ts` mirroring `wl-clipboard.ts` but using:

- read: `xclip -out -selection clipboard` (fallback `xsel --output --clipboard`)
- write: `xclip -in -selection clipboard` (fallback `xsel --input --clipboard`)

The constructor probes which tool is installed and stores the chosen binary.

### Step 5: PowerShell adapter

Create `src/infrastructure/clipboard/powershell.ts`:

```ts
export class PowershellClipboardAdapter implements ClipboardAdapter {
  readonly name = "powershell";

  async read(): Promise<ClipboardContent> {
    const text = await run(["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard"]);
    return { text: text.replace(/\r\n$/, "\n"), isPassword: false };
  }

  async write(content: ClipboardContent): Promise<void> {
    // Set-Clipboard takes the value as an argument; pipe via stdin to avoid
    // quoting issues.
    const escaped = content.text.replace(/'/g, "''");
    const proc = new Deno.Command("powershell.exe", {
      args: ["-NoProfile", "-Command", `Set-Clipboard -Value '${escaped}'`],
    }).spawn();
    await proc.status;
  }

  subscribe(handler: (c: ClipboardContent) => void): () => void {
    // PowerShell polling mirrors the wl/xclip loop.
    // 1s interval, dedupe by text equality.
    // Implement with setInterval, same shape as wl-clipboard.
    // Return an unsubscribe function.
  }
}
```

> Implement `subscribe` to match the wl-clipboard polling shape.

### Step 6: Null adapter

Create `src/infrastructure/clipboard/null-adapter.ts`:

```ts
import type { ClipboardAdapter, ClipboardContent } from "../../ports/clipboard-adapter.ts";

export class NullClipboardAdapter implements ClipboardAdapter {
  readonly name = "null";

  async read(): Promise<ClipboardContent> {
    return { text: "", isPassword: false };
  }
  async write(_content: ClipboardContent): Promise<void> {
    // Intentional no-op for relay-only nodes.
  }
  subscribe(_handler: (c: ClipboardContent) => void): () => void {
    return () => {};
  }
}
```

### Step 7: Factory

Create `src/infrastructure/clipboard/mod.ts`:

```ts
import type { ClipboardAdapter } from "../../ports/clipboard-adapter.ts";
import { detectFromEnv } from "./detector.ts";
import { WlClipboardAdapter } from "./wl-clipboard.ts";
import { XclipAdapter } from "./xclip.ts";
import { PowershellClipboardAdapter } from "./powershell.ts";
import { NullClipboardAdapter } from "./null-adapter.ts";

export function buildClipboardAdapter(): ClipboardAdapter {
  const detected = detectFromEnv();
  switch (detected.backend) {
    case "linux-wl":
      return new WlClipboardAdapter();
    case "linux-xclip":
      return new XclipAdapter();
    case "windows-powershell":
      return new PowershellClipboardAdapter();
    case "macos-pbcopy":
      throw new Error("macOS adapter lands after v0.1.0");
    case "null":
      return new NullClipboardAdapter();
  }
}
```

### Step 8: Detector unit tests

Create `tests/unit/infrastructure/detector_test.ts`:

- `windows` + no env → `windows-powershell`.
- `linux` + `WAYLAND_DISPLAY=wayland-0` → `linux-wl`.
- `linux` + `DISPLAY=:0`, no Wayland → `linux-xclip`.
- `linux` + both set → `linux-wl` (Wayland preferred).
- `linux` + neither → `null`.
- `darwin` → `macos-pbcopy`.

### Step 9: Adapter smoke test

Create `tests/integration/clipboard_smoke_test.ts`:

- Skip if the required CLI tool is missing (`Deno.Command(...).spawn()` then catch error).
- For wl-clipboard: write `"clipruler-test-${random}"`, read back, assert equal. Same for xclip and
  powershell.
- For the null adapter: always run; assert read returns empty and write is a no-op.

### Step 10: docs/platform-support.md

Create `docs/platform-support.md` with the matrix from the master plan (Windows Tier 1, Linux glibc
Tier 1 Wayland/X11, Alpine desktop Tier 2, Alpine headless Tier 3 relay-only). Include the detector
pseudocode and the env-var precedence (Wayland > X11 > null).

## Test plan

- 6 detector unit tests (pure, no env dependencies beyond the explicit arg).
- 1 smoke test per adapter, each gated on the presence of the CLI tool.

## Done criteria

ALL must hold:

- [ ] `deno task check` exits 0
- [ ] `deno lint` exits 0
- [ ] `deno task test` exits 0; detector tests always pass; adapter smoke tests pass when the tool
      is present, skip otherwise
- [ ] `docs/platform-support.md` exists and documents Wayland/X11/null detection
- [ ] `NullClipboardAdapter` is the only adapter with zero side effects
- [ ] No third-party dependencies
- [ ] `plans/README.md` status row for 005 updated

## STOP conditions

Stop and report if:

- `Deno.Command` rejects the tool path (`wl-paste`, `xclip`, etc.) with an unclear error on a target
  platform. Probe with `Deno.which`-equivalent (`Deno.run({ cmd: ["which", "xclip"] })`).
- PowerShell `Set-Clipboard -Value` mangles multilines or quotes; switch to a stdin-piped variant
  and document.
- The polling interval causes noticeable CPU on any platform; bump from 1s to 2s and note.

## Maintenance notes

- Wayland is preferred over X11 when both env vars are set because modern distros set `DISPLAY` for
  compatibility while actually running Wayland.
- A future event-driven backend (e.g. `wlr-data-control`) can replace the polling loop behind the
  same port.
- PowerShell adapter avoids `Out-String` and `Format-Table`; both add trailing newlines that corrupt
  clipboard content.
