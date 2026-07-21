# Plan 012: Docs + packaging v0.1.0

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 011
- **Category**: docs, release

## Why this matters

This phase turns the project from "works on my machine" into a releasable v0.1.0: complete
architecture docs, a protocol reference, a platform support matrix, installable binaries for Tier 1
platforms, and a polished README.

## Current state

After 011: daemon + CLI + desktop shell all work. `docs/platform-support.md` exists (Plan 005). No
`docs/architecture.md`, no `docs/protocol.md`, no release binaries, README still a skeleton.

## Commands you will need

| Purpose        | Command                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------- |
| Check          | `deno task check`                                                                        |
| Build Linux    | `deno desktop main.ts --target x86_64-unknown-linux-gnu -o dist/clipruler-linux-x64`     |
| Build Windows  | `deno desktop main.ts --target x86_64-pc-windows-msvc -o dist/clipruler-windows-x64.exe` |
| Verify Linux   | `./dist/clipruler-linux-x64 --version`                                                   |
| Verify Windows | `.\dist\clipruler-windows-x64.exe --version` (on Windows)                                |

## Scope

**In scope**:

- `docs/architecture.md`
- `docs/protocol.md`
- `docs/platform-support.md` (already exists; review + expand)
- `docs/desktop-shell.md` (already exists; review)
- `README.md` (rewrite for release)
- `CHANGELOG.md`
- `dist/` build outputs (gitignored)
- `.github/workflows/release.yml`

**Out of scope**:

- macOS build (post-MVP).
- Auto-update server infrastructure.
- Homebrew / Scoop / AUR packaging (post-MVP).

## Steps

### Step 1: docs/architecture.md

Write the architecture reference:

- Module map (the hexagonal layout from the master plan).
- Dependency rule diagram (text).
- Lifecycle of a clipboard event (local → broadcast → remote applied).
- Lifecycle of a pairing flow.
- Persistence shape (state.json schema, key file location).
- Process model (daemon + admin socket + CLI + desktop).
- Security model (TLS pinning, pairing code, unpaired-rejection).
- Extension points: add a new clipboard adapter, add a new transport, add a new shell.

### Step 2: docs/protocol.md

Document the wire protocol:

- Envelope format (version, kind, originDeviceId, messageId, payload).
- Length-prefix layout (4 bytes BE, max 16 MiB).
- Each envelope kind: payload shape, who sends it, who handles it, examples.
  - `hello` (UDP beacon payload, JSON-encoded, sent on `238.42.42.42:42731`).
  - `pairing.request`, `pairing.confirm`, `pairing.cancel`.
  - `clipboard.event` (text-only in v1; image/file payloads reserved).
  - `control.bye` (graceful disconnect).
- Versioning: `PROTOCOL_VERSION = 1`. Bump policy.
- Admin channel protocol (over Unix socket / loopback TCP): `admin.list`, `admin.pair`,
  `admin.toggle`, `admin.forget`, `admin.status`.

### Step 3: Review docs/platform-support.md

- Confirm Wayland/X11 detection rules.
- Confirm Alpine Tier 2 (daemon-only) and Tier 3 (relay-only).
- Add a section on Windows session requirements (interactive user session for clipboard access;
  service accounts unsupported).
- Add the `NullClipboardAdapter` behavior on headless hosts.

### Step 4: CHANGELOG.md

```markdown
# Changelog

## 0.1.0 — <release date>

### Added

- LAN clipboard sharing between trusted devices.
- UDP-beacon discovery on `238.42.42.42:42731`.
- Pairing with 6-char confirmation code and Ed25519 public-key pinning.
- TLS TCP transport with length-prefixed JSON framing.
- Clipboard adapters: wl-clipboard (Linux Wayland), xclip/xsel (Linux X11), PowerShell (Windows),
  null (relay-only).
- Daemon shell with PID lock, admin socket, and graceful shutdown.
- CLI: `pair`, `list`, `enable`, `disable`, `forget`, `status`.
- Desktop shell (Deno Desktop) with tray icon and device-list GUI for Windows and Linux glibc.
- Atomic JSON state persistence with schema versioning.

### Security

- Per-device Ed25519 keypair generated at first start.
- All peer connections authenticated by pinned cert fingerprint.
- Clipboard events from unpaired peers are dropped.

### Known limitations

- Text-only clipboard content. Images and files are not supported.
- macOS is not supported in this release.
- Alpine Linux is supported as daemon/relay only; the Deno Desktop GUI is unavailable because Deno
  does not ship a musl target.
- The daemon runs in the foreground; OS auto-start is not configured.
```

### Step 5: README.md (release version)

- One-paragraph description.
- Install section (download the binary from releases).
- Quick start: `clipruler desktop` on two machines on the same LAN.
- Platform support table (reuse from `docs/platform-support.md`).
- Architecture overview (link to `docs/architecture.md`).
- Security model summary.
- Contributing pointer.
- MIT license.

### Step 6: Build binaries

Run:

```
deno desktop main.ts --target x86_64-unknown-linux-gnu -o dist/clipruler-linux-x64
deno desktop main.ts --target x86_64-pc-windows-msvc -o dist/clipruler-windows-x64.exe
```

**Verify**:

- `./dist/clipruler-linux-x64 --version` prints `0.1.0`.
- `./dist/clipruler-linux-x64 --help` prints the help text from Plan 001.
- (Cross-verify on Windows; if a Windows machine is unavailable, mark the Windows binary as untested
  in the release notes.)

### Step 7: Release workflow

Create `.github/workflows/release.yml`:

```yaml
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            target: x86_64-unknown-linux-gnu
            artifact: clipruler-linux-x64
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            artifact: clipruler-windows-x64.exe
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: denoland/setup-deno@v2
        with:
          deno-version: v2.9.3
      - run: deno desktop main.ts --target ${{ matrix.target }} -o ${{ matrix.artifact }}
      - uses: softprops/action-gh-release@v2
        with:
          files: ${{ matrix.artifact }}
```

### Step 8: Tag the release

- Confirm `src/version.ts` says `0.1.0`.
- Tag `v0.1.0` (do not push unless instructed).

## Test plan

- Documentation review: every claim in `docs/` must be backed by a working feature. Walk through
  each doc section and confirm the code matches.
- Binary smoke: run `--version`, `--help`, and the manual smoke test from `docs/desktop-shell.md` on
  at least one Tier 1 platform.

## Done criteria

ALL must hold:

- [ ] `docs/architecture.md`, `docs/protocol.md`, `docs/platform-support.md`,
      `docs/desktop-shell.md` are complete and consistent with the code
- [ ] `README.md` is release-ready
- [ ] `CHANGELOG.md` lists 0.1.0
- [ ] Linux x86_64 binary builds and runs `--version` successfully
- [ ] Windows x86_64 binary builds (tested or marked untested)
- [ ] `.github/workflows/release.yml` is syntactically valid
- [ ] `plans/README.md` shows all plans as DONE
- [ ] No third-party deps outside `@std/*` and JSR

## STOP conditions

Stop and report if:

- `deno desktop` rejects the `--target` flag on a cross-compile. Run the build on the target
  platform instead and document the limitation.
- The Windows binary fails verification because of the ASN.1 cert generator (Plan 004). Do NOT ship
  a binary that cannot establish TLS; debug the cert generator on Windows.
- A documented feature does not match the actual behavior. Update the doc, not the behavior, unless
  the behavior is a bug.

## Maintenance notes

- The release workflow uses `deno desktop`; when `deno compile` grows tray support, switch to the
  simpler command.
- The macOS build (post-MVP) will add a third matrix entry and a new clipboard adapter
  (`pbcopy`/`pbpaste`).
- Auto-update is deferred. When enabled, the manifest server (latest.json + bsdiff patches) becomes
  a new operational surface; budget for it separately.
