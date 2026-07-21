/**
 * Unit tests for protocol/envelope.ts — PROTOCOL_VERSION, makeEnvelope, encode/decode, bounds.
 * @std/assert required.
 *
 * Spec scenarios:
 *   - PROTOCOL_VERSION constant exported
 *   - makeEnvelope(originDeviceId, kind, payload) stamps version and assigns fresh messageId
 *   - Round-trip: encode → decode recovers original envelope
 *   - Length prefix: 4-byte BE prefix; oversize rejected
 *   - Kind discrimination: hello vs pairing vs clipboard
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0";
import {
  decodeEnvelope,
  encodeEnvelope,
  makeEnvelope,
  PROTOCOL_VERSION,
} from "../../../src/protocol/envelope.ts";
import type { ClipboardTextPayload } from "../../../src/protocol/clipboard-payload.ts";
import type { HelloPayload } from "../../../src/protocol/hello.ts";
import type { PairingRequestPayload } from "../../../src/protocol/pairing.ts";

// ---------------------------------------------------------------------------
// PROTOCOL_VERSION constant
// ---------------------------------------------------------------------------

Deno.test("PROTOCOL_VERSION equals 1", () => {
  assertEquals(PROTOCOL_VERSION, 1);
});

// ---------------------------------------------------------------------------
// makeEnvelope — fields populated
// ---------------------------------------------------------------------------

Deno.test("makeEnvelope: envelope has kind, payload, originDeviceId, version, messageId", () => {
  const payload: HelloPayload = { deviceName: "my-device", protocolVersion: 1 };
  const env = makeEnvelope("device-001", "hello", payload);

  assertEquals(env.kind, "hello");
  assertEquals((env.payload as HelloPayload).deviceName, "my-device");
  assertEquals(env.originDeviceId, "device-001");
  assertEquals(env.version, PROTOCOL_VERSION);
  assertEquals(typeof env.messageId, "string");
  assertEquals(env.messageId.length > 0, true);
});

// ---------------------------------------------------------------------------
// makeEnvelope — unique messageIds
// ---------------------------------------------------------------------------

Deno.test("makeEnvelope: two calls produce different messageIds", () => {
  const payload: HelloPayload = { deviceName: "x", protocolVersion: 1 };
  const a = makeEnvelope("device-001", "hello", payload);
  const b = makeEnvelope("device-001", "hello", payload);
  assertEquals(a.messageId !== b.messageId, true);
});

// ---------------------------------------------------------------------------
// Round-trip encode/decode
// ---------------------------------------------------------------------------

Deno.test("encodeEnvelope → decodeEnvelope recovers original envelope (hello)", () => {
  const payload: HelloPayload = { deviceName: "my-device", protocolVersion: 1 };
  const original = makeEnvelope("device-001", "hello", payload);

  const encoded = encodeEnvelope(original);
  const decoded = decodeEnvelope(encoded);

  assertEquals(decoded.kind, original.kind);
  assertEquals(decoded.version, original.version);
  assertEquals(decoded.messageId, original.messageId);
  assertEquals(decoded.originDeviceId, original.originDeviceId);
  assertEquals((decoded.payload as HelloPayload).deviceName, "my-device");
});

Deno.test("encodeEnvelope → decodeEnvelope recovers original envelope (clipboard)", () => {
  const payload: ClipboardTextPayload = { version: 1, counter: 42, content: "hello world" };
  const original = makeEnvelope("device-abc", "clipboard", payload);

  const encoded = encodeEnvelope(original);
  const decoded = decodeEnvelope(encoded);

  assertEquals(decoded.kind, "clipboard");
  assertEquals((decoded.payload as ClipboardTextPayload).content, "hello world");
  assertEquals((decoded.payload as ClipboardTextPayload).counter, 42);
});

Deno.test("encodeEnvelope → decodeEnvelope recovers original envelope (pairing)", () => {
  const payload: PairingRequestPayload = { deviceName: "peer", publicKeyFingerprint: "fp123" };
  const original = makeEnvelope("device-x", "pairing-request", payload);

  const encoded = encodeEnvelope(original);
  const decoded = decodeEnvelope(encoded);

  assertEquals(decoded.kind, "pairing-request");
  assertEquals((decoded.payload as PairingRequestPayload).deviceName, "peer");
});

// ---------------------------------------------------------------------------
// Length prefix
// ---------------------------------------------------------------------------

Deno.test("encodeEnvelope: first 4 bytes are big-endian length", () => {
  const payload: HelloPayload = { deviceName: "x", protocolVersion: 1 };
  const env = makeEnvelope("d", "hello", payload);
  const bytes = encodeEnvelope(env);

  // Extract first 4 bytes as big-endian uint32 via DataView
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, false);
  // The JSON body should be included in the total byte count
  assertEquals(length > 0, true);
  assertEquals(bytes.length, 4 + length);
});

Deno.test("encodeEnvelope: empty payload still produces valid length prefix", () => {
  const env = makeEnvelope("d", "clipboard", { version: 1, counter: 0, content: "" });
  const bytes = encodeEnvelope(env);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, false);
  assertEquals(bytes.length, 4 + length);
});

// ---------------------------------------------------------------------------
// Oversize rejection (16 MiB bound)
// ---------------------------------------------------------------------------

Deno.test("encodeEnvelope: rejects payload exceeding 16 MiB", () => {
  const hugeContent = "x".repeat(16 * 1024 * 1024 + 1);
  const payload: ClipboardTextPayload = { version: 1, counter: 0, content: hugeContent };
  const env = makeEnvelope("d", "clipboard", payload);

  assertThrows(
    () => encodeEnvelope(env),
    Error,
    "oversize",
  );
});

// ---------------------------------------------------------------------------
// Kind discrimination
// ---------------------------------------------------------------------------

Deno.test("Envelope kind discrimination: hello vs pairing vs clipboard have different kinds", () => {
  const hello: HelloPayload = { deviceName: "x", protocolVersion: 1 };
  const pairing: PairingRequestPayload = { deviceName: "x", publicKeyFingerprint: "fp" };
  const clipboard: ClipboardTextPayload = { version: 1, counter: 1, content: "y" };

  const e1 = makeEnvelope("d", "hello", hello);
  const e2 = makeEnvelope("d", "pairing-request", pairing);
  const e3 = makeEnvelope("d", "clipboard", clipboard);

  assertEquals(e1.kind, "hello");
  assertEquals(e2.kind, "pairing-request");
  assertEquals(e3.kind, "clipboard");

  // Kinds are distinct (cast to string to satisfy strict literal comparison lint)
  assertEquals((e1.kind as string) !== (e2.kind as string), true);
  assertEquals((e2.kind as string) !== (e3.kind as string), true);
});
