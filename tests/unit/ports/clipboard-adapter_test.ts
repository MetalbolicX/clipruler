/**
 * Unit tests for ports/clipboard-adapter.ts and the NullClipboardAdapter.
 *
 * Verifies:
 * - NullClipboardAdapter satisfies the ClipboardAdapter port interface
 * - read() returns empty content { text: "", isPassword: false }
 * - write() is a no-op and resolves immediately
 * - subscribe() never fires its handler; unsubscribe is a no-op
 *
 * Layer: unit — no subprocesses, no timers, pure assertions.
 *
 * Strict TDD: tests written BEFORE implementation.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type { ClipboardAdapter } from "../../../src/ports/clipboard-adapter.ts";
import { NullClipboardAdapter } from "../../../src/infrastructure/clipboard/null-adapter.ts";

// ---------------------------------------------------------------------------
// Port conformance: type assignment proving NullClipboardAdapter satisfies
// the ClipboardAdapter interface.
// ---------------------------------------------------------------------------

Deno.test("NullClipboardAdapter satisfies ClipboardAdapter port", () => {
  // Type-level assertion: if NullClipboardAdapter did not implement all
  // members of ClipboardAdapter, TypeScript would reject this assignment.
  const _adapter: ClipboardAdapter = new NullClipboardAdapter();
});

// ---------------------------------------------------------------------------
// Scenario: null read returns empty content
// ---------------------------------------------------------------------------

Deno.test("NullClipboardAdapter: read() returns empty text and isPassword=false", async () => {
  const adapter = new NullClipboardAdapter();
  const content = await adapter.read();

  assertEquals(content.text, "");
  assertEquals(content.isPassword, false);
});

// ---------------------------------------------------------------------------
// Scenario: null write is a no-op
// ---------------------------------------------------------------------------

Deno.test("NullClipboardAdapter: write() resolves immediately without side effects", async () => {
  const adapter = new NullClipboardAdapter();

  // write() should resolve, not reject, and do so without throwing.
  await adapter.write({ text: "any content", isPassword: false });
  await adapter.write({ text: "", isPassword: false });
  await adapter.write({ text: "multi-line\ncontent\nhere", isPassword: false });
});

// ---------------------------------------------------------------------------
// Scenario: null subscribe never fires and unsubscribe is a no-op
// ---------------------------------------------------------------------------

Deno.test("NullClipboardAdapter: subscribe() handler never fires", async () => {
  const adapter = new NullClipboardAdapter();
  let callCount = 0;

  const unsubscribe = adapter.subscribe(() => {
    callCount++;
  });

  // Wait enough time for any polling adapter to have fired at least once.
  // Null adapter has no polling, so callCount MUST remain 0.
  await new Promise<void>((resolve) => setTimeout(resolve, 150));

  assertEquals(callCount, 0);

  // Calling unsubscribe must not throw (it is a no-op).
  unsubscribe();
  unsubscribe(); // Idempotent — calling twice should not throw.
});

// ---------------------------------------------------------------------------
// Scenario: adapter reports its name
// ---------------------------------------------------------------------------

Deno.test("NullClipboardAdapter: name is 'null'", () => {
  const adapter = new NullClipboardAdapter();
  assertEquals(adapter.name, "null");
});
