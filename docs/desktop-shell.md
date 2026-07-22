# Desktop Shell — Clipruler v0.1.0

The desktop shell provides a graphical user interface for the clipboard sync daemon using
Deno's experimental BrowserWindow API and a system tray.

## How to Run

```bash
# Using the task (recommended)
deno task desktop

# Or directly
deno run -A main.ts desktop
```

Requirements:
- Deno 2.9+ with `--unstable-desktop` (implied by `-A`)
- A display server (Wayland or X11) on Linux
- Tier 1 platforms: **Linux glibc x86_64/arm64**, **Windows x86_64**

## Headless Fallback

On headless Linux (no `WAYLAND_DISPLAY` or `DISPLAY`), the desktop shell exits immediately:

```
No display server found. Use 'clipruler daemon' + 'clipruler list' instead.
Exit code: 1
```

In this case, use the CLI shell instead:

```bash
deno task daemon   # start the daemon in background
deno task list     # discover and list devices
```

## Tier 1 Platform Support

| Platform | Status | Notes |
|----------|--------|-------|
| Linux glibc (x86_64, arm64) | ✅ Tier 1 | Wayland + X11 |
| Windows (x86_64) | ✅ Tier 1 | |
| macOS | ❌ Not supported | Deferred to v0.2.0 |
| Linux musl (Alpine) | ❌ Not supported | No glibc |
| Other headless | ❌ Not supported | Use `daemon` shell |

## Tray Menu

The system tray icon appears when the desktop shell is running. Tray state reflects
the daemon's device and pairing status.

### States

| State | Tray Label | Menu Items |
|-------|------------|------------|
| Daemon down | — | (tray hidden) |
| 0 paired devices | `clipruler` | Pair, Quit |
| N paired devices | `clipruler (N)` | [device list], Pair, Quit |
| Pairing in progress | `clipruler` | "[code]" (pairing code), Cancel |
| Pairing error | `clipruler ⚠` | Pair (retry), Quit |

### Interactions

- **Left-click**: Show/hide the main webview window
- **Right-click**: Show context menu
- **Quit**: Send SIGTERM to the daemon process (graceful shutdown)

## Webview Architecture

### Single-Page Invariant

The webview window always shows the same HTML page (`webview://clipboard/` or the
bundled HTML). Navigation is handled entirely in-browser using a hash router.

URL patterns:
- `#/` — Home (device list)
- `#/pair` — Pairing code entry
- `#/pair/confirm?code=XXX` — Pairing confirmation
- `#/settings` — Settings

No URL changes are made to the browser engine's address bar. The invariant is
maintained by replacing `window.location` whenever an internal link would navigate.

### `__clipruler` Bindings

The webview page accesses the Clipruler admin API through the `window.__clipruler`
JavaScript object, injected by `bindings.ts` when the webview registers.

```typescript
interface __clipruler {
  invoke(method: string, params?: unknown): Promise<unknown>;
}

// Example: confirm a pairing
const accepted = await window.__clipruler.invoke("admin.pair.confirm", {
  remoteName: "Device B",
  code: "123456",
});
```

### Message Flow

```
DesktopUiPort ←→ WebviewBridge ←→ webview.__clipruler
      ↓ publish()
 webview.publish(message)
      ↓
 webview window —hash router→ renders UI update
```

## macOS Not Supported in v0.1.0

The desktop shell does not launch on macOS. Attempting to run `clipruler desktop`
on macOS exits with code 1 and prints a message directing users to the CLI shell.

Reason: macOS Deno Desktop support requires additional CI matrix and packaging
work deferred to v0.2.0.

## Architecture

```
main.ts ("desktop")
└── desktopMain()
    ├── headlessGuard()          — check WAYLAND_DISPLAY / DISPLAY
    ├── buildAndRunDaemon()
    │   └── startAdminServer()   — admin socket (Unix or TCP)
    ├── WebviewBridge             — UiPort ←→ webview message bus
    ├── DesktopUiPort            — UiPort adapter for the webview
    └── TrayMenu                 — system tray (future slice)
```

See [Plan 011](../plans/011-desktop-shell.md) for full design rationale.

## Slice History

| Slice | Commit | Scope |
|-------|--------|-------|
| 1 | `c68b51e` | Entry guard, main.ts routing, headless guard |
| 2 | `e3ee7a8` | Single-page HTML shell, webview bindings |
| 3 | `3a469a8` | WebviewBridge, DesktopUiPort, tray-menu state machine |
| 4 | (this branch) | Composition root wiring, e2e test, docs |
