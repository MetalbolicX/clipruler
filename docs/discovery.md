# Discovery — UDP Multicast Beacon

clipruler discovers peers on the local network using an administratively scoped UDP multicast
beacon. The beacon is an **availability signal only** — it surfaces which peers are present, not
whether they are trusted.

## Multicast endpoint

| Property       | Value                                        |
| -------------- | -------------------------------------------- |
| Group (SSM)    | `238.42.42.42`                               |
| Port           | `42731`                                      |
| Scope          | Administratively scoped (RFC 2365)           |
| Implementation | `src/infrastructure/discovery/udp-beacon.ts` |

The group `238.42.42.42` is in the administratively scoped multicast range (`239.0.0.0/8`) and is
not assigned to any registered service. This makes it a safe, collision-resistant choice for a
private LAN tool.

## Beacon lifecycle

| Parameter       | Value | Description                                           |
| --------------- | ----- | ----------------------------------------------------- |
| Beacon interval | 2 s   | Each peer broadcasts its presence every 2 seconds     |
| Peer timeout    | 10 s  | A peer is removed 10 s after its last beacon was seen |

On first receipt of a beacon from a new fingerprint, the receiving peer immediately emits a
`PeerSighting` event. Subsequent renewals refresh the entry without re-emitting. When a beacon has
not been received from a fingerprint for 10 seconds, the entry is pruned and a `PeerLost` event is
emitted.

## `--unstable-net` requirement

`Deno.listenDatagram` requires the `--unstable-net` flag because the UDP multicast API is not yet
stabilized in `Deno.std`:

```bash
# All discovery tests require --unstable-net
CLIPRULER_NET_TESTS=1 deno task test:discovery
```

This flag is already wired into the `test:discovery` task in `deno.json`.

## Integration test gate

Discovery integration tests are gated by the `CLIPRULER_NET_TESTS` environment variable and are
disabled by default in CI:

```bash
# Run all unit tests (always safe — no network I/O)
deno task test

# Run discovery integration tests on a host with multicast support
CLIPRULER_NET_TESTS=1 deno task test:discovery
```

On a host where the multicast group is unreachable (e.g., some Docker configurations), the tests
will fail or hang and are skipped automatically when the environment variable is not set.

## SO_REUSEADDR on Linux

On Linux, two beacons can coexist on the same host sharing port `42731`. This was verified in the
integration tests: two `UdpBeacon` instances on the same machine successfully see each other's
multicast packets without port conflicts.

## Security boundary

**The beacon is UNSIGNED.** The payload contains only:

- Protocol version (to reject mismatched peers)
- The peer's public key fingerprint (to identify the peer)
- A sequence number (to detect beacon age)

The beacon **MUST NOT** include any trust, pairing, or authentication state. A peer that sends a
beacon is indicating it is available on the network — nothing more. Trust is conferred exclusively
through the **pairing flow (plan 007)**, which involves an out-of-band confirmation step using a
cryptographic code derived from the peer's public key.

In other words:

- Discovery → "this peer exists and is network-reachable"
- Pairing → "I trust this peer's public key"

These are separate concerns. Never conflate availability with trust.

## Future: mDNS

The UDP beacon module is a **temporary implementation for v0.1.0**. In v0.2 it will be replaced by
mDNS (via `jsr:@std/net` or a std-adjacent multicast library) once Deno stabilises the relevant
APIs. The `Discovery` interface and its port (`src/ports/discovery.ts`) are stable and will outlast
the UDP beacon adapter.
