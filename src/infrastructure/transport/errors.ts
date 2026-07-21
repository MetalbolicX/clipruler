/**
 * infrastructure/transport/errors.ts
 *
 * Typed error variants for the transport infrastructure layer.
 * Framing errors are: oversize, truncated, invalid-envelope.
 */

// ---------------------------------------------------------------------------
// FramingError
// ---------------------------------------------------------------------------

/** Framing error kinds for length-prefixed frame parsing. */
export type FramingErrorKind = "oversize" | "truncated" | "invalid-envelope";

/**
 * Error thrown by readEnvelope when a frame cannot be decoded.
 * The kind field allows callers to branch on the error type without
 * parsing the message string.
 */
export class FramingError extends Error {
  readonly kind: FramingErrorKind;

  constructor(kind: FramingErrorKind, message: string) {
    super(message);
    this.name = "FramingError";
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Transport closed error
// ---------------------------------------------------------------------------

/** Error thrown by Transport operations after close(). */
export class TransportClosedError extends Error {
  constructor(message = "transport closed") {
    super(message);
    this.name = "TransportClosedError";
  }
}

// ---------------------------------------------------------------------------
// Peer errors
// ---------------------------------------------------------------------------

/** Error thrown when a peer's certificate fingerprint does not match the pin. */
export class PeerPinMismatchError extends Error {
  readonly receivedFingerprint: string;
  readonly expectedFingerprint: string;

  constructor(receivedFingerprint: string, expectedFingerprint: string) {
    super(
      `Peer fingerprint mismatch: received ${receivedFingerprint}, expected ${expectedFingerprint}`,
    );
    this.name = "PeerPinMismatchError";
    this.receivedFingerprint = receivedFingerprint;
    this.expectedFingerprint = expectedFingerprint;
  }
}

/** Error thrown when a peer is rejected due to maxPeers limit. */
export class MaxPeersExceededError extends Error {
  readonly maxPeers: number;

  constructor(maxPeers: number) {
    super(`Max peers (${maxPeers}) exceeded`);
    this.name = "MaxPeersExceededError";
    this.maxPeers = maxPeers;
  }
}

// ---------------------------------------------------------------------------
// Broadcast error
// ---------------------------------------------------------------------------

/**
 * Error thrown when a broadcast fails to deliver to some (but not all) peers.
 * The failedPeers field identifies which peers could not be reached.
 */
export class BroadcastError extends Error {
  readonly failedPeers: readonly string[];

  constructor(failedPeers: readonly string[]) {
    super(`Broadcast failed for ${failedPeers.length} peer(s)`);
    this.name = "BroadcastError";
    this.failedPeers = failedPeers;
  }
}

// ---------------------------------------------------------------------------
// Reconnect error
// ---------------------------------------------------------------------------

/** Error thrown when all reconnect attempts have been exhausted. */
export class ReconnectAbandonedError extends Error {
  readonly fingerprint: string;
  readonly attempts: number;

  constructor(fingerprint: string, attempts: number) {
    super(`Reconnect abandoned for ${fingerprint} after ${attempts} attempts`);
    this.name = "ReconnectAbandonedError";
    this.fingerprint = fingerprint;
    this.attempts = attempts;
  }
}
