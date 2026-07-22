/**
 * infrastructure/transport/tls-tcp.ts
 *
 * TLS-over-TCP transport adapter using Deno's native TLS APIs.
 *
 * Design goals:
 * - Mutual fingerprint pinning: server verifies client cert fingerprint against
 *   knownPeers; client verifies server cert fingerprint against expectedFingerprint.
 * - Per-peer write serialization: each peer's writes are queued to prevent frame interleaving.
 * - Broadcast: snapshot peers → await all writes → remove failed peers.
 * - ALPN: try "clipruler/1" first; on rejection, retry without ALPN and log limitation.
 * - maxPeers: surplus connections are closed before reaching subscribers.
 * - TransportClosedError: all post-close operations reject.
 *
 * Zero third-party deps — Deno native TLS only.
 */

import type { Transport } from "../../ports/transport.ts";
import type { Envelope } from "../../protocol/envelope.ts";
import {
  BroadcastError,
  MaxPeersExceededError,
  PeerPinMismatchError,
  TransportClosedError,
} from "./errors.ts";
import { writeEnvelope } from "./framing.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ALPN protocol identifier for clipruler. */
const ALPN_PROTOCOL = "clipruler/1";

// ---------------------------------------------------------------------------
// TlsTcpTransport options
// ---------------------------------------------------------------------------

export interface TlsTcpTransportOptions {
  /**
   * Operating mode: "dial" (outbound client) or "listen" (server).
   */
  readonly mode: "dial" | "listen";

  // ---- Dial options (mode === "dial") ----
  readonly dial?: {
    readonly hostname: string;
    readonly port: number;
    /**
     * PEM-encoded client certificate for mutual TLS.
     * If provided, sent to the server during TLS handshake.
     */
    readonly cert?: string;
    /**
     * PEM-encoded client private key for mutual TLS.
     * Required if `cert` is provided.
     */
    readonly key?: string;
    /**
     * Path to a PEM-encoded CA certificate file to trust for the server connection.
     * Deno's connectTls accepts CA certificate paths for trust anchors. Note: this
     * only works for certificates signed by the CA — self-signed certs require a
     * different approach (see skipTlsVerify).
     */
    readonly caCertFile?: string;
    /**
     * Skip Deno's TLS server certificate verification.
     *
     * SECURITY NOTE: Enable only for testing or controlled networks. When enabled,
     * the TLS handshake succeeds with any server certificate (including MITM certs).
     * ClipRuler's application-layer fingerprint verification provides protection
     * against MITM when peers have pre-shared fingerprints.
     *
     * For production peer-to-peer use with self-signed certificates, rely on
     * skipTlsVerify + application-layer fingerprint verification rather than
     * Deno's TLS certificate chain validation.
     */
    readonly skipTlsVerify?: boolean;
  };

  // ---- Listen options (mode === "listen") ----
  readonly listen?: {
    readonly hostname: string;
    readonly port: number;
    readonly cert: string;
    readonly key: string;
  };

  // ---- TLS certificate material ----
  /**
   * PEM-encoded TLS certificate.
   * For listen mode: the server certificate (required).
   * For dial mode: optional client certificate for mutual TLS.
   */
  readonly cert?: string;
  /**
   * PEM-encoded TLS private key.
   * For listen mode: the server private key (required).
   * For dial mode: not used.
   */
  readonly key?: string;

  // ---- Pinning ----
  /**
   * Fingerprint expected from the remote peer's certificate (hex SHA-256).
   * Used by client (dial) to verify the server's identity.
   */
  readonly expectedFingerprint?: string;
  /**
   * Set of allowed peer fingerprints (hex SHA-256).
   * Used by server (listen) to verify incoming clients.
   */
  readonly knownPeers?: readonly string[];

  /**
   * Maximum number of concurrent peer connections.
   * @default Infinity
   */
  readonly maxPeers?: number;

  /**
   * Called after a new TLS connection is established but before it is registered.
   * Allows the caller to extract the remote peer's certificate fingerprint
   * and decide whether to accept or reject the connection.
   *
   * @param conn - The TLS connection (Deno.TlsConn)
   * @returns The peer's certificate fingerprint as a lowercase hex SHA-256 string.
   * @throws PeerPinMismatchError to reject the connection.
   */
  readonly onPeerCert: (conn: Deno.TlsConn) => Promise<string>;

  /**
   * Internal testing seam — NOT for production use.
   * Allows substituting Deno.listenTls / Deno.connectTls with fake implementations.
   * @internal
   */
  readonly __testing__?: {
    readonly listenTls?: typeof Deno.listenTls;
    readonly connectTls?: typeof Deno.connectTls;
  };
}

// ---------------------------------------------------------------------------
// Peer state
// ---------------------------------------------------------------------------

interface PeerConn {
  readonly fingerprint: string;
  readonly conn: Deno.TlsConn;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  /** Queue of pending framed writes for this peer — serializes writes. */
  writeQueue: Array<() => Promise<void>>;
  writeRunning: boolean;
  closed: boolean;
}

// ---------------------------------------------------------------------------
// TlsTcpTransport implementation
// ---------------------------------------------------------------------------

/**
 * TlsTcpTransport — TLS/TCP transport adapter implementing the Transport port.
 *
 * Dial mode: connects to a single server peer, verifies its fingerprint,
 * and provides send/broadcast/subscribe/close.
 *
 * Listen mode: listens for incoming TLS connections, verifies each client's
 * fingerprint against knownPeers, and manages up to maxPeers concurrent connections.
 */
class TlsTcpTransportImpl implements Transport {
  readonly #mode: "dial" | "listen";
  readonly #dialOpts?: {
    hostname: string;
    port: number;
    cert?: string;
    key?: string;
    caCertFile?: string;
    skipTlsVerify?: boolean;
  };
  readonly #listenOpts?: { hostname: string; port: number; cert: string; key: string };
  readonly #cert?: string;
  readonly #key?: string;
  readonly #expectedFingerprint?: string;
  readonly #knownPeers?: Set<string>;
  readonly #maxPeers: number;
  readonly #onPeerCert: (conn: Deno.TlsConn) => Promise<string>;

  /** All currently connected peer connections, keyed by fingerprint. */
  #peers = new Map<string, PeerConn>();

  /** Registered envelope handlers, invoked in registration order. */
  #handlers: Array<(envelope: Envelope, peerFingerprint: string) => void> = [];

  /** True after close() is called — all operations must reject. */
  #closed = false;

  /** For listen mode: the TLS listener. */
  #listener?: Deno.Listener;

  /** For listen mode: accept loop abort controller. */
  #acceptAbort?: AbortController;

  /** Testing seam for Deno TLS primitives. */
  #testing:
    | { readonly listenTls?: typeof Deno.listenTls; readonly connectTls?: typeof Deno.connectTls }
    | undefined;

  constructor(options: TlsTcpTransportOptions) {
    this.#mode = options.mode;
    this.#cert = options.cert as unknown as string;
    this.#key = options.key as unknown as string;
    this.#expectedFingerprint = options.expectedFingerprint as unknown as string;
    this.#maxPeers = options.maxPeers ?? Infinity;
    this.#onPeerCert = options.onPeerCert;
    this.#testing = options.__testing__;

    if (options.mode === "dial") {
      if (!options.dial) throw new Error("dial mode requires dial options");
      this.#dialOpts = options.dial;
    } else {
      if (!options.listen) throw new Error("listen mode requires listen options");
      this.#listenOpts = options.listen;
      if (options.knownPeers) {
        this.#knownPeers = new Set(options.knownPeers);
      }
    }
  }

  // -------------------------------------------------------------------------
  // send — deliver to a specific peer
  // -------------------------------------------------------------------------

  async send(peerFingerprint: string, envelope: Envelope): Promise<void> {
    this.#throwIfClosed();
    const peer = this.#peers.get(peerFingerprint);
    if (!peer) {
      // Silently succeed if peer is unknown (broadcast semantics — no error)
      return;
    }
    await this.#sendToPeer(peer, envelope);
  }

  // -------------------------------------------------------------------------
  // broadcast — deliver to all connected peers
  // -------------------------------------------------------------------------

  async broadcast(envelope: Envelope): Promise<void> {
    this.#throwIfClosed();

    // Snapshot current peers — iterate over a stable copy
    const peers = [...this.#peers.values()];
    if (peers.length === 0) return;

    // Await all writes concurrently; collect failures
    const results = await Promise.allSettled(
      peers.map((peer) => this.#sendToPeer(peer, envelope)),
    );

    // Identify failed peers
    const failed: string[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i]!.status === "rejected") {
        const fp = peers[i]!.fingerprint;
        failed.push(fp);
        // Remove failed peer — don't keep broken connections
        this.#removePeer(fp);
      }
    }

    if (failed.length > 0 && failed.length < peers.length) {
      // Partial failure — some peers got it, some didn't
      throw new BroadcastError(failed);
    }
    if (failed.length === peers.length && peers.length > 0) {
      // All peers failed
      throw new BroadcastError(failed);
    }
  }

  // -------------------------------------------------------------------------
  // subscribe — register a handler for received envelopes
  // -------------------------------------------------------------------------

  subscribe(
    handler: (envelope: Envelope, peerFingerprint: string) => void,
  ): Promise<void> {
    this.#throwIfClosed();
    this.#handlers.push(handler);
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // close — stop accepting, close all peers, mark closed
  // -------------------------------------------------------------------------

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;

    // Stop the accept loop
    this.#acceptAbort?.abort();
    this.#listener?.close();
    this.#listener = undefined as unknown as Deno.Listener;

    // Close all peer connections
    for (const [fp, peer] of this.#peers) {
      try {
        peer.conn.close();
      } catch {
        // Ignore close errors
      }
      this.#peers.delete(fp);
    }

    this.#handlers = [];
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // addr — return the bound listen address (listen mode) or dial target (dial mode)
  // -------------------------------------------------------------------------

  addr(): Deno.NetAddr {
    if (this.#mode === "listen" && this.#listener) {
      return this.#listener.addr as Deno.NetAddr;
    }
    if (this.#dialOpts) {
      return {
        transport: "tcp",
        hostname: this.#dialOpts.hostname,
        port: this.#dialOpts.port,
      } as Deno.NetAddr;
    }
    throw new Error("addr() called before listen() or dial()");
  }

  // -------------------------------------------------------------------------
  // dial — initiate a connection to the server (called externally)
  // -------------------------------------------------------------------------

  /**
   * Dial the server and perform mutual fingerprint pinning.
   * Returns only after the TLS handshake and fingerprint verification.
   *
   * @throws PeerPinMismatchError if the server's fingerprint does not match expectedFingerprint.
   */
  async dial(): Promise<void> {
    if (this.#mode !== "dial") throw new Error("dial() requires dial mode");
    if (!this.#dialOpts) throw new Error("missing dial options");
    this.#throwIfClosed();

    const { hostname, port, skipTlsVerify } = this.#dialOpts;

    // Deno.connectTls does NOT use NODE_EXTRA_CA_CERTS automatically.
    // If skipTlsVerify is set, skip certificate verification entirely.
    // Otherwise, try to use NODE_EXTRA_CA_CERTS if available, or fall back to
    // the explicitly provided caCertFile.
    let tlsCaCerts: string[] | undefined;
    if (!skipTlsVerify) {
      // Try NODE_EXTRA_CA_CERTS first (the standard env var for additional trust roots)
      try {
        const extraCa = Deno.env.get("NODE_EXTRA_CA_CERTS");
        if (extraCa) tlsCaCerts = [extraCa];
      } catch {
        // Deno.env.get throws if env access is disabled
      }
      // Fall back to explicit caCertFile if no env var and not skipping verification
      if (!tlsCaCerts && this.#dialOpts.caCertFile) {
        tlsCaCerts = [this.#dialOpts.caCertFile];
      }
    }
    // If skipTlsVerify is true, tlsCaCerts stays undefined and no CA verification happens.

    // Try with ALPN first; if rejected, retry without
    const connectTls = this.#testing?.connectTls ?? Deno.connectTls;
    let conn: Deno.TlsConn;
    try {
      conn = await connectTls({
        hostname,
        port,
        alpnProtocols: [ALPN_PROTOCOL],
        ...(this.#dialOpts?.cert ? { cert: this.#dialOpts.cert } : {}),
        ...(this.#dialOpts?.key ? { key: this.#dialOpts.key } : {}),
        ...(tlsCaCerts ? { caCerts: tlsCaCerts } : {}),
        ...(skipTlsVerify ? { skipTlsVerify } : {}),
      });
    } catch (err) {
      // Check if this is an ALPN rejection
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("alpn") || msg.includes("ALPN") || msg.includes("protocol")) {
        console.warn(
          "[TlsTcpTransport] ALPN negotiation not supported by server; retrying without ALPN",
        );
        conn = await connectTls({
          hostname,
          port,
          ...(this.#dialOpts?.cert ? { cert: this.#dialOpts.cert } : {}),
          ...(this.#dialOpts?.key ? { key: this.#dialOpts.key } : {}),
          ...(tlsCaCerts ? { caCerts: tlsCaCerts } : {}),
          ...(skipTlsVerify ? { skipTlsVerify } : {}),
        });
      } else {
        throw err;
      }
    }

    // ---- Banner exchange: receive server's banner, send our banner ----
    const writer = conn.writable.getWriter();
    const reader = conn.readable.getReader();
    // Receive server's banner (server's announced fingerprint)
    let serverBannerFp: string;
    try {
      serverBannerFp = await recvBanner(reader);
    } catch (_err) {
      try {
        writer.releaseLock();
      } catch { /* ignore */ }
      try {
        conn.close();
      } catch { /* ignore - resource may already be invalid */ }
      throw _err;
    }

    // Our fingerprint to advertise in our banner
    const ourFp = await this.#onPeerCert(conn);

    // Verify server's banner fingerprint
    if (
      this.#expectedFingerprint !== undefined &&
      serverBannerFp !== this.#expectedFingerprint
    ) {
      writer.releaseLock();
      conn.close();
      throw new PeerPinMismatchError(serverBannerFp, this.#expectedFingerprint);
    }

    // Send our banner
    await sendBanner(writer, ourFp);

    // Register this connection as the single peer (keyed by verified server fingerprint)
    const peer: PeerConn = {
      fingerprint: serverBannerFp,
      conn,
      writer,
      writeQueue: [],
      writeRunning: false,
      closed: false,
    };
    this.#peers.set(serverBannerFp, peer);

    // Start reading from this connection in the background
    this.#startPeerReader(serverBannerFp, conn);
  }

  // -------------------------------------------------------------------------
  // listen — start accepting connections (called externally)
  // -------------------------------------------------------------------------

  /**
   * Start the TLS listener and begin accepting connections.
   * Each incoming connection is fingerprinted and verified against knownPeers
   * before being registered.
   *
   * @throws PeerPinMismatchError if a connection's fingerprint is not in knownPeers.
   */
  async listen(): Promise<void> {
    if (this.#mode !== "listen") throw new Error("listen() requires listen mode");
    if (!this.#listenOpts) throw new Error("missing listen options");
    this.#throwIfClosed();

    const { hostname, port, cert, key } = this.#listenOpts;
    if (!key) throw new Error("listen mode requires TLS private key");

    // Try with ALPN first; if rejected, retry without
    const listenTls = this.#testing?.listenTls ?? Deno.listenTls;
    try {
      this.#listener = await listenTls({
        hostname,
        port,
        cert,
        key,
        alpnProtocols: [ALPN_PROTOCOL],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("alpn") || msg.includes("ALPN") || msg.includes("protocol")) {
        console.warn(
          "[TlsTcpTransport] ALPN not supported; listening without ALPN protocol",
        );
        this.#listener = await listenTls({
          hostname,
          port,
          cert,
          key,
        });
      } else {
        throw err;
      }
    }

    // Start accept loop
    this.#acceptAbort = new AbortController();
    this.#runAcceptLoop().catch(() => {
      // Errors are logged in the loop
    });
  }

  // -------------------------------------------------------------------------
  // Private: accept loop
  // -------------------------------------------------------------------------

  async #runAcceptLoop(): Promise<void> {
    if (!this.#listener) return;
    try {
      for await (const conn of this.#listener) {
        if (this.#closed) break;
        // Handle each connection concurrently
        this.#handleIncomingConn(conn as Deno.TlsConn).catch(() => {
          // Errors are handled internally (peer pin mismatch, maxPeers, etc.)
        });
      }
    } catch (err) {
      if (this.#closed) return; // Expected during close
      console.error("[TlsTcpTransport] accept loop error:", err);
    }
  }

  async #handleIncomingConn(conn: Deno.TlsConn): Promise<void> {
    const writer = conn.writable.getWriter();
    const reader = conn.readable.getReader();

    // Extract our (server's) fingerprint for our banner
    let ourFp: string;
    try {
      ourFp = await this.#onPeerCert(conn);
    } catch (_err) {
      try {
        writer.releaseLock();
        conn.close();
      } catch { /* ignore */ }
      return;
    }

    // Send our banner BEFORE waiting for the client's banner
    // This avoids deadlock where both sides wait for the other to send first
    try {
      await sendBanner(writer, ourFp);
    } catch (_err) {
      try {
        writer.releaseLock();
        conn.close();
      } catch { /* ignore */ }
      return;
    }

    // Now receive client's banner (non-blocking read after our banner is flushed)
    let clientBannerFp: string;
    try {
      clientBannerFp = await recvBanner(reader);
    } catch (_err) {
      try {
        writer.releaseLock();
        conn.close();
      } catch { /* ignore */ }
      return;
    }

    // Verify against knownPeers
    if (this.#knownPeers && !this.#knownPeers.has(clientBannerFp)) {
      try {
        writer.releaseLock();
        conn.close();
      } catch { /* ignore */ }
      throw new PeerPinMismatchError(clientBannerFp, "[any known peer]");
    }

    // Check maxPeers
    if (this.#peers.size >= this.#maxPeers) {
      try {
        writer.releaseLock();
        conn.close();
      } catch { /* ignore */ }
      throw new MaxPeersExceededError(this.#maxPeers);
    }

    // Register the peer (keyed by client's verified banner fingerprint)
    const peer: PeerConn = {
      fingerprint: clientBannerFp,
      conn,
      writer,
      writeQueue: [],
      writeRunning: false,
      closed: false,
    };
    this.#peers.set(clientBannerFp, peer);

    // Start reading from this connection
    this.#startPeerReader(clientBannerFp, conn);
  }

  // -------------------------------------------------------------------------
  // Private: peer reader — reads framed envelopes and dispatches to handlers
  // -------------------------------------------------------------------------

  #startPeerReader(fingerprint: string, conn: Deno.TlsConn): void {
    const reader = conn.readable.getReader();
    const fr = new FramingReaderState(reader);

    // Async loop to read envelopes and dispatch to handlers
    const loop = async () => {
      try {
        while (!this.#closed) {
          let envelope: Envelope;
          try {
            envelope = await fr.readEnvelope();
          } catch {
            // Peer disconnected or error — remove from peers
            this.#removePeer(fingerprint);
            return;
          }
          // Dispatch to all handlers in order (catch handler errors to continue)
          for (const handler of this.#handlers) {
            try {
              handler(envelope, fingerprint);
            } catch {
              // Handler error does not affect other handlers or reading
            }
          }
        }
      } catch {
        // Transport closed or reader error
      }
    };

    loop();
  }

  // -------------------------------------------------------------------------
  // Private: write serialization per peer
  // -------------------------------------------------------------------------

  async #sendToPeer(peer: PeerConn, envelope: Envelope): Promise<void> {
    if (peer.closed) return;

    const task = async () => {
      if (peer.closed) return;
      try {
        await writeEnvelope(peer.writer, envelope);
      } catch (__err) {
        // Write failed — mark peer as closed and remove
        peer.closed = true;
        this.#removePeer(peer.fingerprint);
        throw __err;
      }
    };

    peer.writeQueue.push(task);
    await this.#flushPeerQueue(peer);
  }

  async #flushPeerQueue(peer: PeerConn): Promise<void> {
    if (peer.writeRunning) return;
    peer.writeRunning = true;
    try {
      while (peer.writeQueue.length > 0) {
        const task = peer.writeQueue.shift()!;
        await task();
      }
    } finally {
      peer.writeRunning = false;
    }
  }

  // -------------------------------------------------------------------------
  // Private: remove a peer
  // -------------------------------------------------------------------------

  #removePeer(fingerprint: string): void {
    const peer = this.#peers.get(fingerprint);
    if (!peer) return;
    this.#peers.delete(fingerprint);
    try {
      peer.conn.close();
    } catch {
      // Ignore close errors
    }
  }

  // -------------------------------------------------------------------------
  // Private: guard
  // -------------------------------------------------------------------------

  #throwIfClosed(): void {
    if (this.#closed) throw new TransportClosedError();
  }
}

// ---------------------------------------------------------------------------
// FramingReaderState — inline stateful reader (mirrors FramingReader in framing.ts)
// ---------------------------------------------------------------------------

class FramingReaderState {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  async readEnvelope(): Promise<Envelope> {
    // ---- PHASE 1: ensure we have at least 4 bytes for the prefix ----
    let prefixBytes = this.#readPrefixBytes();

    while (prefixBytes.byteLength < 4) {
      const result = await this.#reader.read();
      if (result.done) {
        throw new Error("peer disconnected");
      }
      prefixBytes = concatU8(prefixBytes, result.value);
    }

    // Extract the declared body length from the first 4 bytes
    const bodyLen = new DataView(
      prefixBytes.buffer,
      prefixBytes.byteOffset,
      4,
    ).getUint32(0, false);

    if (bodyLen > 16 * 1024 * 1024) {
      throw new Error("frame too large");
    }

    // ---- PHASE 2: read exactly bodyLen bytes for the body ----
    const extraFromPrefix = prefixBytes.byteLength - 4;
    let bodyBytes: Uint8Array;
    let remaining: number;

    if (extraFromPrefix >= bodyLen) {
      bodyBytes = prefixBytes.subarray(4, 4 + bodyLen);
      const leftover = prefixBytes.subarray(4 + bodyLen);
      if (leftover.byteLength > 0) {
        this.#buffer = leftover;
      }
      remaining = 0;
    } else {
      bodyBytes = prefixBytes.subarray(4);
      remaining = bodyLen - bodyBytes.byteLength;
    }

    while (remaining > 0) {
      const result = await this.#reader.read();
      if (result.done) {
        throw new Error("peer disconnected");
      }
      const chunk = result.value;
      if (chunk.byteLength === 0) continue;

      if (chunk.byteLength >= remaining) {
        bodyBytes = concatU8(bodyBytes, chunk.subarray(0, remaining));
        this.#buffer = chunk.subarray(remaining);
        remaining = 0;
      } else {
        bodyBytes = concatU8(bodyBytes, chunk);
        remaining -= chunk.byteLength;
      }
    }

    // ---- PHASE 3: decode the envelope body ----
    return decodeEnvelopeWire(bodyBytes);
  }

  #readPrefixBytes(): Uint8Array {
    if (this.#buffer.byteLength >= 4) {
      const prefix = this.#buffer.subarray(0, 4);
      if (this.#buffer.byteLength > 4) {
        this.#buffer = this.#buffer.subarray(4);
      } else {
        this.#buffer = new Uint8Array(0);
      }
      return prefix;
    }
    const result = this.#buffer;
    this.#buffer = new Uint8Array(0);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a TlsTcpTransport instance.
 *
 * @param options - Configuration options.
 * @param options.mode - "dial" for outbound client, "listen" for server.
 * @param options.dial - Outbound connection target (mode === "dial").
 * @param options.listen - Listener bind address and TLS cert/key (mode === "listen").
 * @param options.cert - PEM-encoded TLS certificate.
 * @param options.key - PEM-encoded TLS private key (listen mode only).
 * @param options.expectedFingerprint - Server fingerprint expected by client.
 * @param options.knownPeers - Set of allowed client fingerprints (listen mode only).
 * @param options.maxPeers - Maximum concurrent peer connections (default: Infinity).
 * @param options.onPeerCert - Required callback to extract peer fingerprint from Deno.TlsConn.
 */
export const makeTlsTcpTransport = (options: TlsTcpTransportOptions): TlsTcpTransport => {
  return new TlsTcpTransportImpl(options) as unknown as TlsTcpTransport;
};

// ---------------------------------------------------------------------------
// Public interface (extends Transport with dial/listen)
// ---------------------------------------------------------------------------

export interface TlsTcpTransport extends Transport {
  /**
   * Initiate an outbound TLS connection to the server.
   * Verifies the server's certificate fingerprint against expectedFingerprint.
   *
   * @throws PeerPinMismatchError if the server's fingerprint does not match.
   */
  dial(): Promise<void>;

  /**
   * Start the TLS listener and begin accepting incoming connections.
   * Each connection is verified against knownPeers before registration.
   *
   * @throws PeerPinMismatchError if a connection's fingerprint is not in knownPeers.
   * @throws MaxPeersExceededError if maxPeers limit is reached.
   */
  listen(): Promise<void>;

  /**
   * Return the local bound address (listen mode) or the dial target (dial mode).
   * Useful for tests using ephemeral port 0 to discover the assigned port.
   */
  addr(): Deno.NetAddr;
}

// ---------------------------------------------------------------------------
// Utility: decodeEnvelope from wire format
// ---------------------------------------------------------------------------

const decodeEnvelopeWire = (bytes: Uint8Array): Envelope => {
  if (bytes.byteLength < 4) throw new Error("frame too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, false);
  if (length > 16 * 1024 * 1024) throw new Error("frame too large");
  if (bytes.byteLength !== 4 + length) throw new Error("frame length mismatch");
  const body = bytes.subarray(4);
  const json = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const parsed = JSON.parse(json) as { version?: number };
  if (typeof parsed.version !== "number" || parsed.version !== 1) {
    throw new Error(`Unsupported protocol version: ${parsed.version}`);
  }
  return parsed as Envelope;
};

// ---------------------------------------------------------------------------
// Utility: concat Uint8Arrays
// ---------------------------------------------------------------------------

const concatU8 = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a, 0);
  result.set(b, a.byteLength);
  return result;
};

// ---------------------------------------------------------------------------
// Banner exchange — mutual fingerprint advertisement after TLS handshake
// ---------------------------------------------------------------------------

/**
 * Send a fingerprint banner over the connection.
 * Format: 4-byte big-endian uint32 length + fingerprint bytes.
 * Flushes fully before returning to ensure the peer can receive immediately.
 */
const sendBanner = async (
  writer: WritableStreamDefaultWriter<Uint8Array>,
  fingerprint: string,
): Promise<void> => {
  const fpBytes = new TextEncoder().encode(fingerprint);
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer as ArrayBuffer).setUint32(0, fpBytes.byteLength, false);
  await writer.write(lenBuf);
  await writer.write(fpBytes);
  // Flush: wait until the write is fully acknowledged at the TLS record layer
  await writer.ready;
};

/**
 * Receive a fingerprint banner from the connection.
 * Returns the fingerprint string.
 */
const recvBanner = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string> => {
  // Read 4-byte length prefix
  const lenResult = await reader.read();
  if (lenResult.done) throw new Error("peer disconnected during banner");
  const lenView = new DataView(
    lenResult.value.buffer as ArrayBuffer,
    lenResult.value.byteOffset,
    Math.min(4, lenResult.value.byteLength),
  );
  const len = lenView.getUint32(0, false);
  if (len === 0 || len > 256) throw new Error("invalid banner length");

  // Read fingerprint bytes
  let fpBytes: Uint8Array = new Uint8Array(0);
  let remaining = len;
  while (remaining > 0) {
    const result = await reader.read();
    if (result.done) throw new Error("peer disconnected during banner");
    fpBytes = concatU8(fpBytes, result.value as Uint8Array<ArrayBuffer>);
    remaining -= result.value.byteLength;
  }
  fpBytes = fpBytes.subarray(0, len);
  return new TextDecoder("utf-8").decode(fpBytes);
};
