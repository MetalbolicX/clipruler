/**
 * ports/transport.ts
 *
 * Transport port — isolates the application from raw sockets, TLS, and buffers.
 * Callers receive only Envelope objects; infrastructure owns the wire.
 *
 * Design (R1): send/broadcast/subscribe/close, post-close rejection,
 * ordered handlers, opaque Envelope-only surface.
 */
import type { Envelope } from "../protocol/envelope.ts";

/**
 * Transport port — async send/broadcast to one or all peers.
 * All methods reject with Error "transport closed" after close().
 */
export interface Transport {
  /**
   * Deliver an envelope to exactly one peer by fingerprint.
   * @param peerFingerprint - the target peer's certificate fingerprint
   * @param envelope - the Envelope to deliver
   * @throws Error "transport closed" if called after close()
   */
  send(peerFingerprint: string, envelope: Envelope): Promise<void>;

  /**
   * Deliver an envelope to every connected peer.
   * @param envelope - the Envelope to broadcast
   * @throws Error "transport closed" if called after close()
   */
  broadcast(envelope: Envelope): Promise<void>;

  /**
   * Register a handler for received Envelopes.
   * Handlers are invoked in registration order.
   * @param handler - called for each received Envelope
   * @throws Error "transport closed" if called after close()
   */
  subscribe(
    handler: (envelope: Envelope, peerFingerprint: string) => void,
  ): Promise<void>;

  /**
   * Close the transport — drain peers and reject subsequent operations.
   * Idempotent: calling close() multiple times does not throw.
   */
  close(): Promise<void>;
}
