/**
 * protocol/envelope.ts
 *
 * Versioned wire envelope with UTF-8 JSON framing.
 * Web-standard TextEncoder/TextDecoder only — no Deno.* imports.
 *
 * PROTOCOL_VERSION = 1
 * Length prefix: 4-byte big-endian uint32
 * MAX_ENVELOPE_BYTES = 16 MiB
 */

import { makeMessageId } from "../domain/device.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 1;

const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024; // 16 MiB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Wire protocol envelope kinds. */
export type EnvelopeKind =
  | "hello"
  | "pairing-request"
  | "pairing-confirm"
  | "clipboard";

/** Payload correlation map — used for discriminated union narrowing. */
export type PayloadByKind<K extends EnvelopeKind> = K extends "hello"
  ? { deviceName: string; protocolVersion: number }
  : K extends "pairing-request" ? { deviceName: string; publicKeyFingerprint: string }
  : K extends "pairing-confirm" ? { status: "accepted" | "rejected"; peerDeviceId?: string }
  : K extends "clipboard" ? { version: number; counter: number; content: string }
  : never;

/**
 * Discriminated envelope — `kind` property narrows `payload` type.
 * Generic over envelope kind so consumers get typed payloads.
 */
export type Envelope<K extends EnvelopeKind = EnvelopeKind> = {
  readonly version: number;
  readonly messageId: ReturnType<typeof makeMessageId>;
  readonly originDeviceId: string;
  readonly kind: K;
  readonly payload: PayloadByKind<K>;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Construct a fresh envelope with a unique messageId.
 * Uses `globalThis.crypto.randomUUID()` for entropy.
 */
export function makeEnvelope<
  K extends EnvelopeKind,
>(
  originDeviceId: string,
  kind: K,
  payload: PayloadByKind<K>,
): Envelope<K> {
  return {
    version: PROTOCOL_VERSION,
    messageId: makeMessageId(globalThis.crypto.randomUUID()),
    originDeviceId,
    kind,
    payload,
  };
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

/**
 * Encode an envelope to UTF-8 wire format:
 *   4-byte big-endian length prefix (uint32) + UTF-8 JSON body
 *
 * @throws Error with "oversize" if encoded body exceeds MAX_ENVELOPE_BYTES
 */
export function encodeEnvelope<K extends EnvelopeKind>(env: Envelope<K>): Uint8Array {
  const json = JSON.stringify(env);
  const body = new TextEncoder().encode(json);

  if (body.byteLength > MAX_ENVELOPE_BYTES) {
    throw new Error(`Envelope payload exceeds ${MAX_ENVELOPE_BYTES} bytes (oversize)`);
  }

  const length = body.byteLength;
  const result = new Uint8Array(4 + length);

  // 4-byte big-endian length via DataView
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  view.setUint32(0, length, false); // big-endian

  result.set(body, 4);

  return result;
}

/**
 * Decode a wire-format envelope from UTF-8 bytes.
 * Validates version and reconstructs the discriminated Envelope type.
 *
 * @throws Error if decoding fails (invalid JSON, wrong version, etc.)
 */
export function decodeEnvelope(bytes: Uint8Array): Envelope {
  if (bytes.byteLength < 4) {
    throw new Error("Envelope bytes too short for length prefix");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, false); // big-endian

  if (length > MAX_ENVELOPE_BYTES) {
    throw new Error(`Envelope payload exceeds ${MAX_ENVELOPE_BYTES} bytes (oversize)`);
  }

  if (bytes.byteLength !== 4 + length) {
    throw new Error(
      `Envelope length mismatch: prefix says ${length}, got ${bytes.byteLength - 4}`,
    );
  }

  const body = bytes.slice(4);
  const json = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const parsed = JSON.parse(json) as Envelope;

  if (typeof parsed.version !== "number" || parsed.version !== PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported protocol version: ${parsed.version} (expected ${PROTOCOL_VERSION})`,
    );
  }

  return parsed;
}
