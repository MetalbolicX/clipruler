# Plan 011: Desktop shell (Deno Desktop + tray)

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: 010
- **Category**: feature

## Why this matters

The desktop shell turns clipruler from a CLI-only daemon into a tray application with a device-list
GUI. This is the user-facing surface for Tier 1 platforms (Windows + Linux glibc). Alpine is
excluded because Deno Desktop has no musl target (documented in `docs/platform-support.md`).

## Current state

After 010: daemon + CLI work end-to-end. No GUI, no tray, no Deno Desktop configuration.

## Commands you will need

| Purpose | Command                                              |
| ------- | ---------------------------------------------------- |
| Check   | `deno task check`                                    |
| Test    | `deno task test`                                     |
| Build   | `deno desktop main.ts -- desktop`                    |
| Run     | `./clipruler` (Linux) or `.\clipruler.exe` (Windows) |

## Scope

**In scope**:

- `deno.json` `desktop` block
- `src/shells/desktop.ts`
- `src/shells/desktop/bindings.ts` (exposes use cases to the webview)
- `ui/index.html`, `ui/devices.ts`, `ui/styles.css`
- `icons/tray.png`
- `docs/desktop-shell.md`

**Out of scope**:

- macOS build (post-MVP).
- Auto-update (`Deno.autoUpdate`).
- CEF backend (default webview backend is fine).

## Dependency note (ROI)

- `deno desktop` is part of Deno 2.9 itself, not a third-party dependency.
- UI uses vanilla TypeScript + the `fetch`-equivalent bindings API. No React, no Vue, no CSS
  framework. The surface is one device list and one pairing dialog.
- Considered and rejected: React/Vue. The UI has fewer than 10 components; the build complexity is
  not justified. If the GUI grows significantly, revisit.

## Architecture constraints

- The desktop shell launches the same daemon in-process (calls `buildAndRunDaemon`). The webview
  binds to the daemon's use cases via `win.bind("listDevices", ...)`, etc.
- The tray icon shows a context menu: "Show devices", "Quit".
- On startup, hide the main window; the user reaches it via the tray. This matches the tray-only
  background app pattern from the Deno Desktop docs.
- The desktop shell exits cleanly on "Quit" (closes the daemon, releases the PID lock).

## Steps

### Step 1: Deno Desktop configuration

Extend `deno.json` with a `desktop` block:

```json
{
  "desktop": {
    "title": "Clipruler",
    "width": 480,
    "height": 600,
    "resizable": false,
    "icon": "icons/tray.png"
  }
}
```

### Step 2: Tray icon asset

Place `icons/tray.png` (22x22 PNG, mostly-silhouette template style per the Deno Tray docs).

### Step 3: Desktop shell entry

Create `src/shells/desktop.ts`:

```ts
import { buildAndRunDaemon } from "../composition-root.ts";

export async function desktopMain(deviceName: string): Promise<void> {
  const running = await buildAndRunDaemon({ deviceName });

  // Hide the implicit Deno Desktop window on startup; the tray toggles it.
  const win = globalThis.Deno?.desktop?.currentWindow;
  if (win) win.hide();

  // Bindings: the webview calls these to drive the daemon.
  if (win) {
    win.bind("listDevices", async () => {
      return await running.adminLocalCall("admin.list", {});
    });
    win.bind("pair", async (fingerprint: string) => {
      return await running.adminLocalCall("admin.pair", { fingerprint });
    });
    win.bind("toggle", async (fingerprint: string, enabled: boolean) => {
      return await running.adminLocalCall("admin.toggle", { fingerprint, enabled });
    });
    win.bind("forget", async (fingerprint: string) => {
      return await running.adminLocalCall("admin.forget", { fingerprint });
    });
    win.bind("status", async () => {
      return await running.adminLocalCall("admin.status", {});
    });
  }

  // Tray.
  const trayIcon = await Deno.readFile("icons/tray.png");
  const tray = new Deno.Tray();
  tray.setIcon(trayIcon);
  tray.setTooltip(`Clipruler — ${deviceName}`);
  tray.setMenu([
    { item: { label: "Show devices", id: "show", enabled: true } },
    { item: { label: "Quit", id: "quit", enabled: true } },
  ]);
  tray.addEventListener("menuclick", (e) => {
    if (e.detail.id === "show" && win) win.show();
    if (e.detail.id === "quit") {
      void (async () => {
        await running.stop();
        Deno.exit(0);
      })();
    }
  });
}
```

> `running.adminLocalCall` is a new method on the `RunningDaemon` interface from Plan 009: it
> invokes an admin handler in-process (skipping the admin socket) for speed. The CLI keeps using the
> socket.

### Step 4: Wire `main.ts` dispatch

Add `desktop` to `main.ts`:

```ts
if (args[0] === "desktop") {
  const deviceName = Deno.env.get("CLIPRULER_DEVICE_NAME") ?? Deno.hostname();
  await import("./src/shells/desktop.ts").then((m) => m.desktopMain(deviceName));
  return;
}
```

### Step 5: UI assets

Create `ui/index.html`:

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Clipruler</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <h1>Devices</h1>
    <section id="paired">
      <h2>Paired</h2>
      <ul id="paired-list"></ul>
    </section>
    <section id="available">
      <h2>Available</h2>
      <ul id="available-list"></ul>
    </section>
    <script type="module" src="devices.ts"></script>
  </body>
</html>
```

Create `ui/devices.ts`:

```ts
// @ts-expect-error — bindings are injected by the Deno Desktop webview host.
const api: CliprulerBindings = globalThis.clipruler ?? {
  listDevices: async () => ({ paired: [], available: [] }),
  pair: async () => ({ kind: "not-found" }),
  toggle: async () => {},
  forget: async () => {},
  status: async () => ({}),
};

interface CliprulerBindings {
  listDevices(): Promise<{ paired: unknown[]; available: unknown[] }>;
  pair(fp: string): Promise<{ kind: string }>;
  toggle(fp: string, enabled: boolean): Promise<void>;
  forget(fp: string): Promise<void>;
  status(): Promise<unknown>;
}

async function refresh(): Promise<void> {
  const view = await api.listDevices();
  // Render paired and available lists; attach Pair/Toggle/Forget handlers.
}

refresh();
setInterval(refresh, 3_000);
```

Create `ui/styles.css` with minimal, readable styling (system fonts, generous padding, list items
with action buttons).

### Step 6: Desktop documentation

Create `docs/desktop-shell.md` documenting:

- How to start the desktop shell (`clipruler desktop` or the compiled binary).
- Tray menu behavior.
- How pairing is triggered from the GUI (click an available device → confirm the 6-char code in a
  dialog).
- The hidden-window-on-startup pattern.
- Why Alpine is unsupported (no `deno desktop` musl target).

### Step 7: Manual smoke test

Document the smoke test in `docs/desktop-shell.md`:

1. Start `clipruler desktop` on two machines on the same LAN.
2. On Machine A, click an available device (Machine B).
3. Both windows show the same 6-char code.
4. Confirm on both.
5. Copy text on Machine A; expect it on Machine B within 2 seconds.
6. Toggle sharing off on Machine B; copy on Machine A; expect Machine B does not receive.
7. Quit via the tray; assert the daemon and PID lock are cleaned up.

## Test plan

- No automated GUI tests for v0.1.0 (the surface is tiny and a GUI test harness is more maintenance
  than it saves).
- Manual smoke test checklist above; recorded in `docs/desktop-shell.md`.

## Done criteria

ALL must hold:

- [ ] `deno task check` exits 0
- [ ] `deno lint` exits 0
- [ ] `deno desktop main.ts` produces a working binary on Linux glibc x86_64 and Windows x86_64
- [ ] Tray icon appears with "Show devices" and "Quit"
- [ ] Device list updates within 5 seconds of a peer starting
- [ ] Pairing dialog shows the 6-char code on both peers
- [ ] Clipboard sync works after pairing from the GUI
- [ ] Quitting via the tray releases the PID lock and cleans up
- [ ] `docs/desktop-shell.md` is published
- [ ] `plans/README.md` status row for 011 updated

## STOP conditions

Stop and report if:

- `Deno.Tray` is `undefined` in the resolved Deno Desktop binary. The binary must be built with
  `deno desktop`, not `deno compile` — verify the build command.
- The webview bindings do not survive reload. Bindings are tied to the window object; do not
  navigate the webview between pages.
- The Linux webview backend (WebKitGTK) is missing on the dev machine. Install `webkit2gtk-4.1` and
  retry; document the system dependency in `docs/desktop-shell.md`.
- On Windows the tray icon does not appear. Verify `icons/tray.png` is a real PNG (not a renamed
  JPEG) and is 16x16 or larger.

## Maintenance notes

- The hidden-window-on-startup pattern can fail on Linux WMs that do not honour the hide request;
  fall back to "minimize" if reports come in.
- Auto-update (`Deno.autoUpdate`) is intentionally not enabled in v0.1.0. The release process is
  `deno desktop` per platform; manual install only.
- When the GUI grows (images, history viewer, settings), revisit the no-framework decision. The
  current vanilla-TS surface is ~100 lines.
