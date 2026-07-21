/**
 * ports/discovery.ts
 *
 * Discovery port — exposes LAN peers by their public-key fingerprint.
 * All types are interface-only; no Deno.* runtime imports.
 *
 * Design (R1): Discovery interface with start/subscribe/visible/stop,
 * PeerAdvertisement (branded fingerprint), PeerSighting (first/last seen).
 */

import type { PublicKeyFingerprint } from "../domain/device.ts";
import type { Logger } from "./logger.ts";

// ---------------------------------------------------------------------------
// Peer advertisement — what a peer broadcasts on the LAN
// ---------------------------------------------------------------------------

/**
 * Local advertisement broadcast via UDP multicast.
 * Carries only availability information — NO trust/pairing state.
 */
export interface PeerAdvertisement {
  /** Human-readable device name (e.g. hostname). */
  readonly name: string;
  /** Canonical public-key fingerprint — used as peer identity key. */
  readonly publicKeyFingerprint: PublicKeyFingerprint;
  /** TLS port the peer is listening on for encrypted clipboard traffic. */
  readonly tlsPort: number;
  /** Wire protocol version — must equal PROTOCOL_VERSION. */
  readonly protocolVersion: number;
}

// ---------------------------------------------------------------------------
// Peer sighting — a received advertisement with metadata
// ---------------------------------------------------------------------------

/**
 * A peer advertisement received from the network, enriched with metadata.
 * All timestamps are milliseconds since epoch (Date.now-compatible).
 */
export interface PeerSighting {
  /** The advertised peer identity and capabilities. */
  readonly advertisement: PeerAdvertisement;
  /** Remote address the beacon was received from (hostname:port). */
  readonly remoteAddress: string;
  /** Epoch ms when this peer was first sighted. */
  readonly firstSeenAt: number;
  /** Epoch ms when this peer was last confirmed active. */
  readonly lastSeenAt: number;
}

// ---------------------------------------------------------------------------
// Discovery port
// ---------------------------------------------------------------------------

/**
 * Discovery port — discovers LAN peers via UDP multicast beaconing.
 *
 * Implementations MUST:
 * - Exclude self from visible peers.
 * - Prune peers after PEER_TIMEOUT_MS of silence.
 * - Return immutable snapshots from `visible()` and on each subscriber call.
 * - Support multiple concurrent subscribers.
 */
export interface Discovery {
  /**
   * Bind the UDP socket, join the multicast group, and broadcast the first
   * beacon immediately (before resolving).
   *
   * @throws Error if the socket cannot be bound or multicast join fails.
   */
  start(): Promise<void>;

  /**
   * Register a listener for peer-map snapshots.
   * The listener is called with a fresh `ReadonlyMap` on every change:
   * - a new peer is sighted
   * - an existing peer's lastSeenAt is refreshed
   * - a peer is pruned
   * - stop() is called (empty snapshot)
   *
   * @param listener - called with an immutable snapshot of currently visible peers.
   * @returns an unsubscribe function — safe to call even after stop().
   */
  subscribe(
    listener: (peers: ReadonlyMap<PublicKeyFingerprint, PeerSighting>) => void,
  ): () => void;

  /**
   * Return a defensive copy of the current peer map.
   * Mutations to the returned map do NOT affect internal state.
   */
  visible(): ReadonlyMap<PublicKeyFingerprint, PeerSighting>;

  /**
   * Stop all timers, close the socket, clear all sightings, and emit an
   * empty snapshot to all subscribers.
   * Idempotent: safe to call multiple times.
   */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// UdpBeacon options
// ---------------------------------------------------------------------------

/**
 * Options for constructing a UdpBeacon adapter.
 */
export interface UdpBeaconOptions {
  /** Our own advertisement — broadcast on start and used for self-suppression. */
  readonly self: PeerAdvertisement;
  /** Logger instance for debug/warn/error events. */
  readonly logger: Logger;
  /**
   * Internal testing seam — NOT for production use.
   * Allows injecting a fake clock and/or a fake listenDatagram factory.
   * @internal
   */
  readonly __testing?: {
    /** Override `Date.now()` for deterministic prune tests. */
    readonly now?: () => number;
    /** Override `Deno.listenDatagram` for network-free unit tests. */
    readonly listenDatagram?: typeof Deno.listenDatagram;
  };
}
