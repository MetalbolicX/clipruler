/**
 * infrastructure/transport/index.ts
 *
 * Barrel — re-exports all transport infrastructure types and classes.
 */

// Typed error variants (type-only exports for the kind union)
export type { FramingErrorKind } from "./errors.ts";

// Error classes (these also export their types)
export { FramingError } from "./errors.ts";
export { TransportClosedError } from "./errors.ts";
export { PeerPinMismatchError } from "./errors.ts";
export { MaxPeersExceededError } from "./errors.ts";
export { BroadcastError } from "./errors.ts";
export { ReconnectAbandonedError } from "./errors.ts";

// Streaming frame reader/writer
export { FramingReader, MAX_FRAME_BODY_BYTES, readEnvelope, writeEnvelope } from "./framing.ts";

// TLS-over-TCP transport
export { makeTlsTcpTransport } from "./tls-tcp.ts";
export type { TlsTcpTransport, TlsTcpTransportOptions } from "./tls-tcp.ts";

// Reconnect wrapper with exponential backoff and fan-out deduplication
export { reconnect } from "./reconnect.ts";
export type { Clock, Conn, ReconnectOptions } from "./reconnect.ts";
