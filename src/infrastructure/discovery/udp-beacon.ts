/**
 * infrastructure/discovery/udp-beacon.ts
 *
 * UDP multicast beacon adapter — implements Discovery port.
 *
 * Design decisions (locked):
 * - Fixed multicast group: 238.42.42.42:42731
 * - Beacon interval: 2s, prune interval: 4s, peer timeout: 10s
 * - Immediate announce on start() before returning
 * - recvLoop detached with .catch(), self-suppressed, malformed-tolerant
 * - stop() clears timers first, closes socket best-effort, emits empty snapshot
 * - All timestamps driven by injected `now()` seam
 */

import type {
  Discovery,
  PeerAdvertisement,
  PeerSighting,
  UdpBeaconOptions,
} from "../../ports/discovery.ts";
import type { Logger } from "../../ports/logger.ts";
import type { PublicKeyFingerprint } from "../../domain/device.ts";
import { makePublicKeyFingerprint } from "../../domain/device.ts";
import { PROTOCOL_VERSION } from "../../protocol/envelope.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Organization-local multicast address (SSM — source-specific multicast). */
const MULTICAST_ADDRESS = "238.42.42.42";

/** Default discovery port (IANA registered for clipruler). */
const MULTICAST_PORT = 42731;

/** Beacon broadcast interval in milliseconds. */
const BEACON_INTERVAL_MS = 2_000;

/** Peer sighting timeout — peers missing for this long are pruned. */
const PEER_TIMEOUT_MS = 10_000;

/** Prune check interval in milliseconds. */
const PRUNE_INTERVAL_MS = 4_000;

// ---------------------------------------------------------------------------
// UdpBeacon implementation
// ---------------------------------------------------------------------------

/**
 * UDP multicast beacon adapter implementing the Discovery port.
 *
 * @example
 * ```ts
 * const beacon = new UdpBeacon({
 *   self: { name: "my-device", publicKeyFingerprint: myFp, tlsPort: 19201, protocolVersion: 1 },
 *   logger: console,
 * });
 * await beacon.start();
 * beacon.subscribe((peers) => console.log("peers:", peers));
 * // later:
 * await beacon.stop();
 * ```
 */
export class UdpBeacon implements Discovery {
  // ---- constructor options ----
  readonly #self: PeerAdvertisement;
  readonly #logger: Logger;
  /** @internal */
  readonly #testingNow: (() => number) | undefined;
  /** @internal */
  readonly #listenDatagram: typeof Deno.listenDatagram | undefined;

  // ---- runtime state ----
  #listener: Deno.DatagramConn | undefined;
  #stopped = false;
  #peers = new Map<PublicKeyFingerprint, PeerSighting>();
  #subscribers = new Set<(peers: ReadonlyMap<PublicKeyFingerprint, PeerSighting>) => void>();
  #announceTimer: ReturnType<typeof setInterval> | undefined;
  #pruneTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: UdpBeaconOptions) {
    this.#self = options.self;
    this.#logger = options.logger;
    this.#testingNow = options.__testing?.now;
    this.#listenDatagram = options.__testing?.listenDatagram;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Return the current timestamp (injected seam for testing). */
  #now(): number {
    return this.#testingNow?.() ?? Date.now();
  }

  // -------------------------------------------------------------------------
  // Discovery — public API
  // -------------------------------------------------------------------------

  /**
   * Bind the UDP socket, join the multicast group, start loops, and broadcast
   * one immediate beacon before returning.
   */
  async start(): Promise<void> {
    const listenDatagram = this.#listenDatagram ?? Deno.listenDatagram;

    if (listenDatagram === undefined) {
      this.#logger.warn("[UdpBeacon] Deno.listenDatagram is not available — UDP discovery disabled");
      this.#stopped = true;
      return;
    }

    this.#listener = await listenDatagram({
      port: MULTICAST_PORT,
      hostname: "0.0.0.0",
      transport: "udp",
    }) as Deno.DatagramConn;

    // Join the multicast group so we receive broadcast datagrams
    try {
      await this.#listener.joinMulticastV4(MULTICAST_ADDRESS, "0.0.0.0");
    } catch (err) {
      this.#logger.warn(`[UdpBeacon] joinMulticastV4 failed: ${err}`);
    }

    // Detach receive loop — unexpected errors are caught and logged
    this.#runRecvLoop().catch((err) => {
      this.#logger.warn("[UdpBeacon] recvLoop exited unexpectedly", { error: String(err) });
    });

    // Start periodic announce and prune timers
    this.#announceTimer = setInterval(() => this.announce(), BEACON_INTERVAL_MS);
    this.#pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);

    // Send one immediate beacon before returning
    this.announce();
  }

  /**
   * Send a JSON-encoded PeerAdvertisement to the multicast group.
   * Failures are logged at warn level and do not propagate.
   */
  announce(): void {
    if (this.#stopped || !this.#listener) return;
    try {
      const json = JSON.stringify(this.#self);
      const data = new TextEncoder().encode(json);
      this.#listener.send(data, {
        hostname: MULTICAST_ADDRESS,
        port: MULTICAST_PORT,
        transport: "udp",
      });
    } catch (err) {
      this.#logger.warn("[UdpBeacon] announce send failed", { error: String(err) });
    }
  }

  /**
   * Async iterator receive loop — validates and processes incoming datagrams.
   * Runs detached from start(); errors are caught and logged without propagating.
   */
  async #runRecvLoop(): Promise<void> {
    if (!this.#listener) return;
    if (this.#stopped) return;

    // Manual async iteration — allows the recvLoop to keep polling when the
    // iterator signals done (important for test fakes that inject datagrams
    // in batches rather than streaming continuously).
    const iter = this.#listener[Symbol.asyncIterator]();
    while (!this.#stopped) {
      const { value, done } = await iter.next();
      if (done) {
        // Yield to event loop so injected datagrams can be picked up
        await new Promise((resolve) => setTimeout(resolve, 1));
        continue;
      }
      const [data, _addr] = value;

      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
      } catch {
        this.#logger.debug("[UdpBeacon] received non-JSON packet, ignoring", {});
        continue;
      }

      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        this.#logger.debug("[UdpBeacon] malformed advertisement (not an object)", {});
        continue;
      }

      const obj = raw as Record<string, unknown>;

      // Validate required fields
      if (
        typeof obj.name !== "string" ||
        typeof obj.publicKeyFingerprint !== "string" ||
        typeof obj.tlsPort !== "number" ||
        !Number.isInteger(obj.tlsPort) ||
        obj.tlsPort < 1 ||
        obj.tlsPort > 65535 ||
        typeof obj.protocolVersion !== "number" ||
        obj.protocolVersion !== PROTOCOL_VERSION
      ) {
        this.#logger.debug("[UdpBeacon] advertisement missing or invalid fields, ignoring", {});
        continue;
      }

      // Cast fingerprint to brand at the wire boundary
      const fingerprint = obj.publicKeyFingerprint as string;
      const fingerprintBrand = makePublicKeyFingerprint(fingerprint);

      // Self-suppression
      if (fingerprintBrand === this.#self.publicKeyFingerprint) continue;

      const now = this.#now();

      // Upsert — preserve firstSeenAt on refresh
      const existing = this.#peers.get(fingerprintBrand);
      if (existing) {
        this.#peers.set(fingerprintBrand, {
          ...existing,
          lastSeenAt: now,
        });
      } else {
        this.#peers.set(fingerprintBrand, {
          advertisement: {
            name: obj.name as string,
            publicKeyFingerprint: fingerprintBrand,
            tlsPort: obj.tlsPort as number,
            protocolVersion: obj.protocolVersion as number,
          },
          remoteAddress: fingerprintBrand, // no peer address in recvLoop yet
          firstSeenAt: now,
          lastSeenAt: now,
        });
      }

      this.#emit();
    }
  }

  /**
   * Remove peers whose lastSeenAt is older than PEER_TIMEOUT_MS.
   * Called periodically by the prune timer.
   */
  prune(): void {
    if (this.#stopped) return;
    const cutoff = this.#now() - PEER_TIMEOUT_MS;
    let changed = false;
    for (const [fp, sighting] of this.#peers) {
      if (sighting.lastSeenAt < cutoff) {
        this.#peers.delete(fp);
        changed = true;
      }
    }
    if (changed) this.#emit();
  }

  /**
   * Take a defensive snapshot and notify all subscribers.
   */
  #emit(): void {
    const snapshot = new Map<PublicKeyFingerprint, PeerSighting>(this.#peers);
    for (const listener of this.#subscribers) {
      try {
        listener(snapshot);
      } catch {
        // Subscriber error — do not affect other subscribers
      }
    }
  }

  /**
   * Register a listener for peer-map snapshots.
   * @returns an unsubscribe function.
   */
  subscribe(
    listener: (peers: ReadonlyMap<PublicKeyFingerprint, PeerSighting>) => void,
  ): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  /**
   * Return a defensive copy of the current peer map.
   */
  visible(): ReadonlyMap<PublicKeyFingerprint, PeerSighting> {
    return new Map<PublicKeyFingerprint, PeerSighting>(this.#peers);
  }

  /**
   * Stop timers, close the socket, clear all state, and emit an empty
   * snapshot to all subscribers. Idempotent — safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    // Satisfy require-await: all async work is best-effort (socket close, timers)
    await Promise.resolve();

    // Clear timers FIRST before doing anything async
    if (this.#announceTimer !== undefined) {
      clearInterval(this.#announceTimer);
      this.#announceTimer = undefined;
    }
    if (this.#pruneTimer !== undefined) {
      clearInterval(this.#pruneTimer);
      this.#pruneTimer = undefined;
    }

    // Close socket best-effort
    try {
      this.#listener?.close();
    } catch {
      // Swallow close errors
    }
    this.#listener = undefined;

    // Clear all peers and emit empty snapshot
    this.#peers.clear();
    this.#emit();
  }
}
