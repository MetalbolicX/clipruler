/**
 * Unit tests for protocol/clipboard-payload.ts — ClipboardTextPayload shape.
 * @std/assert required.
 *
 * Spec: ClipboardPayload serializes version, counter, and content fields.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type { ClipboardTextPayload } from "../../../src/protocol/clipboard-payload.ts";

Deno.test("ClipboardTextPayload has version, counter, and content fields", () => {
  const payload: ClipboardTextPayload = {
    version: 1,
    counter: 42,
    content: "hello world",
  };
  assertEquals(payload.version, 1);
  assertEquals(payload.counter, 42);
  assertEquals(payload.content, "hello world");
});

Deno.test("ClipboardTextPayload content can be empty string", () => {
  const payload: ClipboardTextPayload = {
    version: 1,
    counter: 0,
    content: "",
  };
  assertEquals(payload.content, "");
  assertEquals(payload.counter, 0);
});
