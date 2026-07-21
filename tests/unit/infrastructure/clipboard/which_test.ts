/**
 * Unit tests for infrastructure/clipboard/which.ts.
 *
 * Verifies:
 * - which("nonexistent-binary") returns false when binary not on PATH
 * - which("deno") returns true when binary is on PATH
 *
 * Layer: unit — uses Deno.Command but tests its exit-code logic.
 * Strict TDD: test written BEFORE implementation.
 */
import { assertEquals, assertFalse } from "jsr:@std/assert@^1.0";
import { which } from "../../../../src/infrastructure/clipboard/which.ts";

Deno.test("which: returns false for nonexistent binary", async () => {
  const result = await which("__clipruler_nonexistent_binary_12345__");
  assertFalse(result);
});

Deno.test("which: returns true for deno (always on PATH in test env)", async () => {
  const result = await which("deno");
  assertEquals(result, true);
});
