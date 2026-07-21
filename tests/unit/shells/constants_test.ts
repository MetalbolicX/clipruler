/**
 * tests/unit/shells/constants_test.ts
 *
 * Verifies shell constants.
 *
 * Layer: unit.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import { SHUTDOWN_TIMEOUT_MS } from "../../../src/shells/constants.ts";

Deno.test("SHUTDOWN_TIMEOUT_MS is 5000", () => {
  assertEquals(SHUTDOWN_TIMEOUT_MS, 5_000);
});
