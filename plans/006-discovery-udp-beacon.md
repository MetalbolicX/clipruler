# Plan 006: Discovery — UDP beacon

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 004
- **Category**: feature

## Why this matters

Discovery is what turns clipboard sync from "share IP:port manually" (uniclip) into "see all devices
on the LAN". A UDP beacon avoids mDNS libraries while still letting peers find each other in
seconds.

## Current state

After 004: TLS transport with framing and reconnect. No discovery code. The application has no way
to know which peers exist on the LAN.

## Commands you will need

| Purpose           | Command                                       |
| ----------------- | --------------------------------------------- |
| Check             | `deno task check`                             |
| Test              | `deno task test --allow-net`                  |
| Two-instance test | `deno test --allow-net --filter "udp beacon"` |

## Scope

**In scope**:

- `src/ports/discovery.ts`
- `src/infrastructure/discovery/udp-beacon.ts`
- `tests/integration/discovery_udp_test.ts`

**Out of scope**:

- mDNS (post-MVP).
- Pairing (Plan 007).
- The "available" UI surface (Plan 011).

## Dependency note (ROI)

- No third-party deps. `Deno.listenDatagram` covers UDP multicast.
- Considered and rejected: `@hello-pangea/dns`, `multicast-dns` npm. mDNS is heavier than needed and
  would force a non-std dependency. UDP beacon is ~150 lines.

## Architecture constraints

- Discovery announces identity (name, fingerprint, TLS port) on a fixed multicast group + port. It
  does NOT announce trust state — pairing is a separate step.
- Discovery MUST NOT trust a peer just because it received a beacon. The receiver surfaces the peer
  as `available` and waits for explicit pairing.

## Steps

### Step 1: Port — discovery

Create `src/ports/discovery.ts`:

```ts
export interface PeerAdvertisement {
  readonly name: string;
  readonly publicKeyFingerprint: string;
  readonly tlsPort: number;
  readonly protocolVersion: number;
}

export interface PeerSighting {
  readonly advertisement: PeerAdvertisement;
  readonly remoteAddress: string;
  readonly firstSeenAt: number; // epoch ms
  readonly lastSeenAt: number;
}

export interface Discovery {
  /** Start announcing and listening. Returns once sockets are bound. */
  start(): Promise<void>;
  /** Subscribe to the current set of visible peers (called on every change). */
  subscribe(listener: (peers: ReadonlyMap<string, PeerSighting>) => void): () => void;
  /** Snapshot of currently visible peers (keyed by publicKeyFingerprint). */
  visible(): ReadonlyMap<string, PeerSighting>;
  /** Graceful shutdown. */
  stop(): Promise<void>;
}
```

### Step 2: UDP beacon implementation

Create `src/infrastructure/discovery/udp-beacon.ts`:

```ts
import type { Logger } from "../../ports/logger.ts";
import type { Discovery, PeerAdvertisement, PeerSighting } from "../../ports/discovery.ts";

// Fixed multicast group and port. Both are part of the v1 wire contract.
const MULTICAST_ADDRESS = "238.42.42.42"; // administratively scoped, not registered
const MULTICAST_PORT = 42731;
const BEACON_INTERVAL_MS = 2_000;
const PEER_TIMEOUT_MS = 10_000;

export class UdpBeacon implements Discovery {
  private listener: Deno.DatagramConn | null = null;
  private peers = new Map<string, PeerSighting>();
  private listeners = new Set<(p: ReadonlyMap<string, PeerSighting>) => void>();
  private announceTimer: number | null = null;
  private pruneTimer: number | null = null;

  constructor(
    private readonly self: PeerAdvertisement,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.listener = Deno.listenDatagram({
      port: MULTICAST_PORT,
      hostname: "0.0.0.0",
      transport: "udp",
    });
    // Join the multicast group on all non-loopback IPv4 interfaces.
    // (Deno's network API does not expose interface enumeration; listen on
    // 0.0.0.0 and rely on the OS to deliver multicast.)
    this.recvLoop();
    this.announceTimer = setInterval(() => void this.announce(), BEACON_INTERVAL_MS);
    this.pruneTimer = setInterval(() => this.prune(), BEACON_INTERVAL_MS * 2);
    // Fire one announce immediately so peers see us fast.
    await this.announce();
  }

  private async announce(): Promise<void> {
    const payload = new TextEncoder().encode(JSON.stringify(this.self));
    try {
      await this.listener?.send(payload, {
        hostname: MULTICAST_ADDRESS,
        port: MULTICAST_PORT,
        transport: "udp",
      });
    } catch (err) {
      this.logger.warn("announce failed", { err: String(err) });
    }
  }

  private async recvLoop(): Promise<void> {
    if (!this.listener) return;
    for await (const [data, remote] of this.listener) {
      try {
        const adv = JSON.parse(new TextDecoder().decode(data)) as PeerAdvertisement;
        if (adv.publicKeyFingerprint === this.self.publicKeyFingerprint) continue;
        const now = Date.now();
        const prev = this.peers.get(adv.publicKeyFingerprint);
        this.peers.set(adv.publicKeyFingerprint, {
          advertisement: adv,
          remoteAddress: (remote as Deno.NetAddr).hostname,
          firstSeenAt: prev?.firstSeenAt ?? now,
          lastSeenAt: now,
        });
        this.emit();
      } catch (err) {
        this.logger.debug("ignoring malformed beacon", { err: String(err) });
      }
    }
  }

  private prune(): void {
    const cutoff = Date.now() - PEER_TIMEOUT_MS;
    let changed = false;
    for (const [fp, s] of this.peers) {
      if (s.lastSeenAt < cutoff) {
        this.peers.delete(fp);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  private emit(): void {
    const snapshot = new Map(this.peers);
    for (const l of this.listeners) l(snapshot);
  }

  subscribe(listener: (p: ReadonlyMap<string, PeerSighting>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  visible(): ReadonlyMap<string, PeerSighting> {
    return new Map(this.peers);
  }

  async stop(): Promise<void> {
    if (this.announceTimer) clearInterval(this.announceTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    try {
      await this.listener?.close();
    } catch { /* ignore */ }
    this.listener = null;
  }
}
```

### Step 3: Integration test

Create `tests/integration/discovery_udp_test.ts`:

- Build two `PeerAdvertisement` instances with different fingerprints.
- Start a `UdpBeacon` for each.
- Wait up to 5 seconds for each to see the other via a subscriber.
- Assert both see exactly one peer with the other's fingerprint.
- Stop both; assert `visible()` is empty within 15 seconds (timeout-based prune).

> If multicast is unavailable in CI, gate the test on `Deno.env.get("CLIPRULER_NET_TESTS") === "1"`
> so CI can skip it.

**Verify**: `deno test --allow-net --filter "udp beacon"` passes locally.

## Test plan

- 1 integration test that confirms two beacons see each other.
- (Optional) unit test for `prune()` by injecting fake timestamps via a test-only seam.

## Done criteria

ALL must hold:

- [ ] `deno task check` exits 0
- [ ] `deno lint` exits 0
- [ ] The UDP beacon integration test passes on at least one developer machine (document the env var
      that gates CI)
- [ ] `visible()` returns the peer within 5s of the peer starting
- [ ] `visible()` drops the peer within 15s of the peer stopping
- [ ] No third-party deps
- [ ] `plans/README.md` status row for 006 updated

## STOP conditions

Stop and report if:

- The chosen multicast address is claimed by another application on the dev machine. Pick another
  administratively-scoped address (238.x.x.x) and update both the source and this plan.
- Multicast is blocked in the CI container. Gate the test behind an env var and document the skip —
  do not delete the test.
- `Deno.listenDatagram` rejects the multicast `send` destination; fall back to UDP broadcast
  (`255.255.255.255`) and note the change.

## Maintenance notes

- The beacon interval (2s) and timeout (10s) are constants; move them to configuration once we have
  a settings file.
- mDNS in v0.2 will replace this module; the `Discovery` port stays.
- The beacon never includes trust state. Pairing is a separate handshake (Plan 007) — never leak "I
  am paired with X" on the LAN.
