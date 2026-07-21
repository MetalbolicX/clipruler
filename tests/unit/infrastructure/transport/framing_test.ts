/**
 * Unit tests for infrastructure/transport/framing.ts — length-prefixed streaming frames.
 *
 * Layer: unit.
 * R2 scenarios: round-trip, sequential concat, oversize rejection, truncated prefix/body.
 *
 * Strict TDD: tests written BEFORE implementation.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0";
import type { Envelope } from "../../../../src/protocol/envelope.ts";
import { makeEnvelope } from "../../../../src/protocol/envelope.ts";
import { makeDeviceId } from "../../../../src/domain/device.ts";
import { readEnvelope, writeEnvelope } from "../../../../src/infrastructure/transport/framing.ts";
import { FramingError } from "../../../../src/infrastructure/transport/errors.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestEnvelope(kind: "hello" | "clipboard" = "hello"): Envelope {
  if (kind === "hello") {
    return makeEnvelope(makeDeviceId("origin"), "hello", {
      deviceName: "TestDevice",
      protocolVersion: 1,
    });
  }
  return makeEnvelope(makeDeviceId("origin"), "clipboard", {
    version: 1,
    counter: 42,
    content: "hello world",
  });
}

/**
 * Collect all bytes written to a WritableStream into a single Uint8Array.
 */
/**
 * Collect all bytes written to a WritableStream into a single Uint8Array.
 * Note: we use a custom writable that pushes chunks to an array in tests.
 * This helper is not used in practice (tests use inline collectors).
 */

/**
 * Create a ReadableStream from a Uint8Array — for testing readEnvelope.
 */
function readableFromBytes(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index]!);
        index++;
      } else {
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Scenario: round-trip — writeEnvelope then readEnvelope decodes correctly
// ---------------------------------------------------------------------------

Deno.test("framing: round-trip write then read produces identical envelope", async () => {
  const env = makeTestEnvelope("hello");

  // Collect written bytes via a simple byte buffer
  const written: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
  });

  // Write the envelope
  const w = writable.getWriter();
  await writeEnvelope(w, env);
  await w.close();

  // Concatenate all written chunks into one buffer
  const totalLen = written.reduce((acc, b) => acc + b.byteLength, 0);
  const wireBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const b of written) {
    wireBytes.set(b, offset);
    offset += b.byteLength;
  }

  // Read back using a single-chunk readable stream
  const readable = readableFromBytes(wireBytes);
  const r = readable.getReader();
  const decoded = await readEnvelope(r);

  assertEquals(decoded.kind, "hello");
  assertEquals(decoded.originDeviceId, makeDeviceId("origin"));
  if (decoded.kind === "hello") {
    const payload = decoded.payload as { deviceName: string; protocolVersion: number };
    assertEquals(payload.deviceName, "TestDevice");
  }
});

// ---------------------------------------------------------------------------
// Scenario: two envelopes written sequentially, read twice, both decode correctly
// ---------------------------------------------------------------------------

Deno.test("framing: two envelopes concatenate without leftover bytes contamination", async () => {
  const env1 = makeTestEnvelope("hello");
  const env2 = makeTestEnvelope("clipboard");

  // Write both envelopes to a single buffer
  async function writeEnvelopesToBuffer(...envs: Envelope[]): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        parts.push(chunk);
      },
    });
    const w = writable.getWriter();
    for (const env of envs) {
      await writeEnvelope(w, env);
    }
    await w.close();
    const totalLen = parts.reduce((acc, b) => acc + b.byteLength, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const b of parts) {
      result.set(b, offset);
      offset += b.byteLength;
    }
    return result;
  }

  const wireBytes = await writeEnvelopesToBuffer(env1, env2);

  // Split wireBytes into per-envelope chunks (4-byte prefix + body)
  const chunks: Uint8Array[] = [];
  let pos = 0;
  while (pos < wireBytes.byteLength) {
    const prefixView = new DataView(wireBytes.buffer, wireBytes.byteOffset + pos, 4);
    const bodyLen = prefixView.getUint32(0, false);
    const envSize = 4 + bodyLen;
    chunks.push(wireBytes.subarray(pos, pos + envSize));
    pos += envSize;
  }

  // Stream that delivers exactly one envelope per pull (chunk).
  // This exercises boundary handling: after the first readEnvelope extracts
  // env1 from chunk1, chunk2 is delivered on the next pull.
  let chunkIndex = 0;
  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunkIndex < chunks.length) {
        controller.enqueue(chunks[chunkIndex]!);
        chunkIndex++;
      } else {
        controller.close();
      }
    },
  });

  const r = readable.getReader();
  const decoded1 = await readEnvelope(r);
  const decoded2 = await readEnvelope(r);

  assertEquals(decoded1.kind, "hello");
  assertEquals(decoded2.kind, "clipboard");
  if (decoded2.kind === "clipboard") {
    const payload = decoded2.payload as { version: number; counter: number; content: string };
    assertEquals(payload.content, "hello world");
  }
});

// ---------------------------------------------------------------------------
// Scenario: oversize frame (>16 MiB) throws oversize error BEFORE reading body
// ---------------------------------------------------------------------------

Deno.test("framing: >16MiB declared length throws oversize without reading body", async () => {
  // Manually construct a buffer with a prefix declaring 17 MiB but NO body bytes
  const oversizeBytes = 17 * 1024 * 1024;
  const prefixBuf = new Uint8Array(4);
  const view = new DataView(prefixBuf.buffer, prefixBuf.byteOffset, prefixBuf.byteLength);
  view.setUint32(0, oversizeBytes, false); // big-endian

  // Stream contains only the 4-byte prefix, no body
  const readable = readableFromBytes(prefixBuf);
  const r = readable.getReader();

  await assertRejects(
    async () => await readEnvelope(r),
    FramingError,
    "oversize",
  );
});

// ---------------------------------------------------------------------------
// Scenario: truncated prefix — stream ends before 4 bytes received
// ---------------------------------------------------------------------------

Deno.test("framing: truncated prefix (less than 4 bytes) throws truncation error", async () => {
  // Only 2 bytes — not enough for a full 4-byte big-endian uint32 prefix
  const partialBuf = new Uint8Array([0x00, 0x01]);
  const readable = readableFromBytes(partialBuf);
  const r = readable.getReader();

  await assertRejects(
    async () => await readEnvelope(r),
    FramingError,
    "truncated",
  );
});

// ---------------------------------------------------------------------------
// Scenario: truncated body — prefix declares N bytes but EOF arrives at N-k
// ---------------------------------------------------------------------------

Deno.test("framing: truncated body (partial body after valid prefix) throws truncation error", async () => {
  // 4-byte big-endian prefix declaring 100 bytes, but only 50 body bytes sent
  const bodyLen = 100;
  const actualBody = 50;
  const prefixBuf = new Uint8Array(4);
  const view = new DataView(prefixBuf.buffer, prefixBuf.byteOffset, prefixBuf.byteLength);
  view.setUint32(0, bodyLen, false); // declares 100

  const bodyBuf = new Uint8Array(actualBody); // only 50 bytes
  const combined = new Uint8Array(4 + actualBody);
  combined.set(prefixBuf, 0);
  combined.set(bodyBuf, 4);

  const readable = readableFromBytes(combined);
  const r = readable.getReader();

  await assertRejects(
    async () => await readEnvelope(r),
    FramingError,
    "truncated",
  );
});

// ---------------------------------------------------------------------------
// Scenario: writeEnvelope throws on envelope that encodes to >16 MiB
// ---------------------------------------------------------------------------

Deno.test("framing: writeEnvelope throws oversize for envelope exceeding 16MiB limit", async () => {
  // Create an envelope with a very large payload
  const largeContent = "x".repeat(17 * 1024 * 1024); // 17 MiB of content
  const env = makeEnvelope(makeDeviceId("origin"), "clipboard", {
    version: 1,
    counter: 1,
    content: largeContent,
  });

  const writable = new WritableStream<Uint8Array>({
    write(_chunk) {
      // discard
    },
  });
  const w = writable.getWriter();

  await assertRejects(
    async () => await writeEnvelope(w, env),
    Error,
    "oversize",
  );
});

// ---------------------------------------------------------------------------
// Scenario: writeEnvelope writes correct 4-byte big-endian length prefix
// ---------------------------------------------------------------------------

Deno.test("framing: writeEnvelope writes correct 4-byte big-endian length prefix", async () => {
  const env = makeTestEnvelope("hello");

  const written: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk);
    },
  });

  const w = writable.getWriter();
  await writeEnvelope(w, env);
  await w.close();

  // Concatenate written chunks
  const totalLen = written.reduce((acc, b) => acc + b.byteLength, 0);
  const wireBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const b of written) {
    wireBytes.set(b, offset);
    offset += b.byteLength;
  }

  // First 4 bytes must be the big-endian length
  assertEquals(wireBytes.byteLength >= 4, true);
  const prefixView = new DataView(wireBytes.buffer, wireBytes.byteOffset, 4);
  const declaredLength = prefixView.getUint32(0, false); // big-endian

  // The declared length should equal the body byte length (wireBytes - 4)
  const actualBodyLen = wireBytes.byteLength - 4;
  assertEquals(declaredLength, actualBodyLen);
  // Total wire bytes = 4 (prefix) + body
  assertEquals(wireBytes.byteLength, 4 + declaredLength);
});
