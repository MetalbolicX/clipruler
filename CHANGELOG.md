# Changelog

## 0.1.0 -- 2026-07-21

### Added

- LAN clipboard sharing between trusted devices on the same network.
- UDP-beacon discovery on `238.42.42.42:42731` (administratively scoped multicast).
- Pairing with 6-char confirmation code and Ed25519 public-key pinning.
- TLS TCP transport with length-prefixed JSON framing (16 MiB max).
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
- Deno.Tray and Deno.BrowserWindow are experimental APIs.
