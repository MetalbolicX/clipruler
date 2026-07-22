/**
 * infrastructure/transport/framing.ts
 *
 * Length-prefixed streaming frame reader/writer.
 *
 * Each Envelope is framed as:
 *   4-byte big-endian uint32 length prefix  +  UTF-8 JSON body
 *
 * This matches the wire format in protocol/envelope.ts exactly.
 * Uses @std/streams for streaming reads/writes.
 */
import { decodeEnvelope, encodeEnvelope } from "../../protocol/envelope.ts";
import type { Envelope } from "../../protocol/envelope.ts";
import { FramingError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum allowed body length in bytes (16 MiB). */
export const MAX_FRAME_BODY_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// writeEnvelope
// ---------------------------------------------------------------------------

/**
 * Write a framed envelope to a writable stream.
 *
 * @param writer - WritableStreamDefaultWriter backed by the transport byte stream
 * @param envelope - The Envelope to frame and write
 * @throws FramingError if the encoded body exceeds MAX_FRAME_BODY_BYTES
 */
export const writeEnvelope = async (
  writer: WritableStreamDefaultWriter<Uint8Array>,
  envelope: Envelope,
): Promise<void> => {
  // encodeEnvelope returns full wire format: [4-byte length prefix][JSON body].
  // We just write it as one chunk so the reader can parse prefix + body without interleaving.
  const wireBytes = encodeEnvelope(envelope);
  await writer.write(wireBytes);
};

// ---------------------------------------------------------------------------
// FramingReader — stateful reader that properly handles chunk boundaries
// ---------------------------------------------------------------------------

/**
 * A stateful envelope reader that properly handles streaming chunk boundaries.
 * Leftover bytes from each read() call are buffered and prepended to the next.
 */
export class FramingReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Buffered bytes from previous reads that have not yet been consumed. */
  #buffer: Uint8Array = new Uint8Array(0);

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.#reader = reader;
  }

  /**
   * Read and decode a single envelope from the stream.
   * Handles chunk boundaries: leftover bytes from each read are buffered
   * and prepended to the next read.
   */
  async readEnvelope(): Promise<Envelope> {
    // ---- PHASE 1: ensure we have at least 4 bytes for the prefix ----

    // First, try to read the 4-byte prefix, prepending any buffered bytes
    let prefixBytes = this.#readPrefixBytes();

    // If buffer doesn't have 4 bytes, read more from the stream
    while (prefixBytes.byteLength < 4) {
      const result = await this.#reader.read();
      if (result.done) {
        // EOF before we had 4 bytes — this is a truncated prefix
        throw new FramingError(
          "truncated",
          `truncated: expected 4-byte prefix, got ${prefixBytes.byteLength} bytes before EOF`,
        );
      }
      // Append the new chunk to our buffer
      prefixBytes = this.#concat(prefixBytes, result.value);
    }

    // Extract the declared body length from the first 4 bytes
    const prefixLen = prefixBytes.subarray(0, 4);
    const bodyLen = new DataView(prefixLen.buffer, prefixLen.byteOffset, 4).getUint32(0, false);

    // ---- PHASE 2: validate declared length BEFORE reading body ----

    if (bodyLen > MAX_FRAME_BODY_BYTES) {
      // Do NOT consume any body bytes — reject before body read
      throw new FramingError(
        "oversize",
        `oversize: frame body length ${bodyLen} exceeds maximum ${MAX_FRAME_BODY_BYTES} bytes`,
      );
    }

    // ---- PHASE 3: read exactly bodyLen bytes for the body ----

    // Any bytes beyond the 4-byte prefix in prefixBytes count toward the body first
    const extraFromPrefix = prefixBytes.byteLength - 4;
    let bodyBytes: Uint8Array;
    let remaining: number;

    if (extraFromPrefix >= bodyLen) {
      // The prefix chunk contains at least bodyLen bytes beyond the 4-byte prefix.
      // Consume exactly bodyLen bytes for the body; put the rest in the buffer.
      bodyBytes = prefixBytes.subarray(4, 4 + bodyLen);
      const leftover = prefixBytes.subarray(4 + bodyLen);
      if (leftover.byteLength > 0) {
        this.#buffer = leftover;
      }
      remaining = 0;
    } else {
      // The prefix chunk has fewer than bodyLen extra bytes.
      // Consume all of them for the body and read the rest from subsequent chunks.
      bodyBytes = prefixBytes.subarray(4);
      remaining = bodyLen - bodyBytes.byteLength;
    }

    // Read more chunks until we have bodyLen bytes
    while (remaining > 0) {
      const result = await this.#reader.read();
      if (result.done) {
        throw new FramingError(
          "truncated",
          `truncated: frame body declared ${bodyLen} bytes, got ${bodyLen - remaining} before EOF`,
        );
      }
      const chunk = result.value;
      if (chunk.byteLength === 0) continue; // skip empty chunks

      if (chunk.byteLength >= remaining) {
        // This chunk completes or overfills the body
        bodyBytes = this.#concat(bodyBytes, chunk.subarray(0, remaining));
        remaining = 0;
        // Leftover bytes from this chunk go back into the buffer for the next call
        const leftover = chunk.subarray(chunk.byteLength - (chunk.byteLength - remaining));
        if (leftover.byteLength > 0) {
          this.#buffer = leftover;
        }
      } else {
        // Chunk is smaller than remaining — consume it all
        bodyBytes = this.#concat(bodyBytes, chunk);
        remaining -= chunk.byteLength;
      }
    }

    // ---- PHASE 4: decode the body ----

    // decodeEnvelope expects full wire format (4-byte prefix + body).
    // Reconstruct it by prepending the original 4-byte prefix to bodyBytes.
    const wire = new Uint8Array(4 + bodyBytes.byteLength);
    wire.set(prefixLen, 0);
    wire.set(bodyBytes, 4);

    try {
      return decodeEnvelope(wire);
    } catch (err) {
      throw new FramingError(
        "invalid-envelope",
        err instanceof Error
          ? `invalid-envelope: ${err.message}`
          : "invalid-envelope: decode failed",
      );
    }
  }

  /**
   * Read exactly 4 bytes for the frame prefix.
   * Returns a Uint8Array with at least 4 bytes (may have more from buffer).
   */
  #readPrefixBytes(): Uint8Array {
    if (this.#buffer.byteLength >= 4) {
      const prefix = this.#buffer.subarray(0, 4);
      // Keep any remaining bytes in the buffer for the next call
      if (this.#buffer.byteLength > 4) {
        this.#buffer = this.#buffer.subarray(4);
      } else {
        this.#buffer = new Uint8Array(0);
      }
      return prefix;
    }
    // Buffer has fewer than 4 bytes — return what we have; caller will read more
    const result = this.#buffer;
    this.#buffer = new Uint8Array(0);
    return result;
  }

  /**
   * Concatenate two Uint8Arrays efficiently.
   */
  #concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const result = new Uint8Array(a.byteLength + b.byteLength);
    result.set(a, 0);
    result.set(b, a.byteLength);
    return result;
  }
}

/**
 * Read a single framed envelope from a readable stream.
 *
 * Streaming: reads exactly 4 bytes for the prefix, validates the length,
 * then reads exactly that many body bytes before returning.
 *
 * @param reader - ReadableStreamDefaultReader<Uint8Array> backed by the transport byte stream
 * @throws FramingError when the frame cannot be fully decoded (oversize, truncated, invalid)
 */
export const readEnvelope = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Envelope> => {
  const fr = new FramingReader(reader);
  return fr.readEnvelope();
};
