# Clipruler

LAN clipboard sharing between trusted devices.

## Status

v0.1.0 — first public release. Tier 1 platforms: Linux glibc (x86_64, arm64), Windows x86_64. See
[CHANGELOG.md](CHANGELOG.md).

## Install

Download the release bundle for your platform from the
[Releases page](https://github.com/.../releases):

- Linux x86_64: `clipruler-linux-x64` (AppImage-style bundle)
- Windows x86_64: `clipruler-windows-x64.msi`

Or build from source:

```bash
git clone https://github.com/.../clipruler
cd clipruler
deno task build:linux    # produces dist/clipruler-linux-x64
```

## Quick start

On two machines on the same LAN:

1. **Start the daemon on machine A**:
   ```bash
   ./clipruler-linux-x64 daemon
   ```
2. **On machine B** (also running the daemon):
   ```bash
   ./clipruler-linux-x64 list
   ```
3. **Pair them**:
   ```bash
   ./clipruler-linux-x64 pair
   ```
   The 6-character pairing code is shown on both machines. Confirm the codes match.

4. **Optional: launch the desktop shell** (tray + GUI):
   ```bash
   ./clipruler-linux-x64 desktop
   ```

The shared clipboard syncs within ~1 second.

## Platform support

See [docs/platform-support.md](docs/platform-support.md) for the full matrix.

| Platform       | Tier 1 (full)       | Tier 2/3 (daemon/relay) |
| -------------- | ------------------- | ----------------------- |
| Linux glibc    | Yes (Wayland + X11) | —                       |
| Windows        | Yes                 | —                       |
| macOS          | No (v0.2)           | —                       |
| Linux Alpine   | —                   | Yes (musl)              |
| Linux headless | —                   | Yes (relay)             |

## Architecture

Hexagonal: pure domain at the core, ports as contracts, adapters per platform/runtime, and shells
that wire concrete adapters. See [docs/architecture.md](docs/architecture.md).

## Security

- Per-device Ed25519 keypair generated at first start.
- All peer connections authenticated by pinned TLS cert fingerprint.
- Pairing requires confirmation of a 6-character code derived from the peer's public key.
- Clipboard events from unpaired peers are dropped.

See [docs/architecture.md#security-model](docs/architecture.md#security-model).

## Documentation

- [docs/architecture.md](docs/architecture.md) — hexagonal architecture reference
- [docs/protocol.md](docs/protocol.md) — wire protocol reference
- [docs/platform-support.md](docs/platform-support.md) — Tier 1/2/3 matrix
- [docs/desktop-shell.md](docs/desktop-shell.md) — desktop shell runbook
- [docs/discovery.md](docs/discovery.md) — UDP beacon reference
- [CHANGELOG.md](CHANGELOG.md) — release notes

## Contributing

Issues and PRs welcome. See [plans/README.md](plans/README.md) for the implementation roadmap. Run
tests with `deno task test` (no network required; integration tests are gated by env vars).

## License

MIT — see [LICENSE](LICENSE) (TBD; currently no LICENSE file; will be added at first release).
