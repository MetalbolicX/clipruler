/**
 * protocol/index.ts
 *
 * Curated public exports for the protocol layer.
 * Consumers import from here — never from internal module files directly.
 */

// Envelope
export { decodeEnvelope, encodeEnvelope, makeEnvelope, PROTOCOL_VERSION } from "./envelope.ts";
export type { Envelope, EnvelopeKind } from "./envelope.ts";

// Payloads
export type { ClipboardTextPayload } from "./clipboard-payload.ts";
export type { HelloPayload } from "./hello.ts";
export type { PairingConfirmPayload, PairingRequestPayload } from "./pairing.ts";
