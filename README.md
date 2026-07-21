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

See `docs/architecture.md` (created in Plan 012). Hexagonal: pure domain at the core, ports as
contracts, adapters per platform/runtime, and shells that wire concrete adapters.

## License

MIT.
