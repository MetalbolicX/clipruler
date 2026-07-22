# Platform Support

clipruler accesses the host clipboard exclusively through a `ClipboardAdapter` port. The concrete
adapter is selected at runtime by a pure detector that probes the operating system and environment
variables.

## Support matrix

| Host OS          | Adapter              | Tier | Notes                                         |
| ---------------- | -------------------- | ---- | --------------------------------------------- |
| Windows          | `powershell`         | 1    | Tier 1 — primary target                       |
| Linux (glibc)    | `wl-clipboard`       | 1    | Tier 1 — Wayland desktop                      |
| Linux (glibc)    | `xclip` / `xsel`     | 1    | Tier 1 — X11 desktop                          |
| Linux (Alpine)   | `wl-clipboard`       | 2    | Tier 2 — Alpine desktop (musl compat)         |
| Linux (headless) | `null` (relay-only)  | 3    | Tier 3 — no clipboard access; relay-only node |
| macOS            | `pbcopy` / `pbpaste` | —    | Post-v0.1.0; not implemented yet              |

Tier 1 backends are fully smoke-tested. Tier 2 backends work but lack dedicated CI coverage. Tier 3
is intentional — a headless relay node has no clipboard and must not fail.

## Backend detector

The detector is pure (`detectBackend`) so it is fully unit-testable without environment I/O.

```typescript
function detectBackend(env: {
  WAYLAND_DISPLAY?: string;
  DISPLAY?: string;
  os: typeof Deno.build.os;
}): DetectionResult {
  if (env.os === "windows") {
    return { backend: "windows-powershell", reason: "Deno.build.os === 'windows'" };
  }
  if (env.os === "darwin") {
    return { backend: "macos-pbcopy", reason: "Deno.build.os === 'darwin'" };
  }
  // Linux (or any non-Windows/non-Darwin host)
  if (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY.trim() !== "") {
    return { backend: "linux-wl", reason: `WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY.trim()}` };
  }
  if (env.DISPLAY !== undefined && env.DISPLAY.trim() !== "") {
    return { backend: "linux-xclip", reason: `DISPLAY=${env.DISPLAY.trim()}` };
  }
  return { backend: "null", reason: "no WAYLAND_DISPLAY or DISPLAY on a non-Windows/darwin host" };
}
```

`detectFromEnv()` wraps `detectBackend` and reads `Deno.env` and `Deno.build.os`.

## Environment variable precedence

```
WAYLAND_DISPLAY  →  linux-wl      (Wayland desktop)
DISPLAY          →  linux-xclip   (X11 desktop)
neither set      →  null          (headless relay node)
```

Wayland takes precedence over X11 when both are set. Modern Wayland distros often set `DISPLAY` for
X11 compatibility layers, so a host with both variables set is a Wayland machine running an X11
compat layer.

## macOS (post-v0.1.0)

The `macos-pbcopy` backend is detected but not implemented. Calling `buildClipboardAdapter()` on
macOS throws:

```
Error: macOS adapter lands after v0.1.0; PR2 ships with windows-powershell,
linux-wl, linux-xclip, null only
```

## Smoke test gating

Clipboard smoke tests are gated by the `CLIPRULER_CLIPBOARD_TESTS` environment variable and run only
against the adapter for the current host:

```bash
# Run all unit tests (always safe)
deno task test

# Run clipboard smoke tests on the current host
CLIPRULER_CLIPBOARD_TESTS=1 deno task test:clipboard
```

Each smoke test probes for its required CLI tool and skips automatically when the tool is absent. On
a headless Linux host the smoke tests will skip all real adapters and run only the null-adapter
smoke.

## Windows session requirements

The PowerShell clipboard adapter (`windows-powershell`) relies on `Get-Clipboard` and
`Set-Clipboard`, which access the clipboard of the interactive user session. These cmdlets require a
graphical logon session and are not available to service accounts or headless processes.

**Does not work under:**

- `NT AUTHORITY\SYSTEM` (LocalSystem service account)
- Scheduled tasks running as `SYSTEM`, `LocalService`, or `NetworkService`
- Windows Server background roles without interactive logon

This is a PowerShell/Windows limitation, not a clipruler bug.

**Workarounds:**

- Run the daemon from a user context that has an active interactive session (e.g., a user logged on
  via `explorer.exe`)
- Use a named user account instead of a system account for the scheduled task or service
- On headless Windows servers, use the relay-only Tier 3 configuration (set neither
  `WAYLAND_DISPLAY` nor `DISPLAY` and rely on `null` adapter — though note the null adapter must be
  selected manually on Windows as the auto-detector will return `windows-powershell`)

## Null adapter behavior

On a Tier 3 headless relay node, clipruler uses `NullClipboardAdapter`:

- `read()` returns `{ text: "", isPassword: false }` — empty string, never throws
- `write()` is a silent no-op — returns `Promise.resolve()`, never throws
- `subscribe()` returns a no-op unsubscribe function — subscribers never fire

The daemon starts and runs normally as a relay, forwarding clipboard events between paired devices.
No clipboard I/O occurs. This is intentional: a relay node does not own the clipboard and must not
fail when no clipboard is available.
