/**
 * tests/unit/application/application_index_test.ts
 *
 * Type-check test for application barrel exports.
 * Strict TDD: RED first — verifies ForgetDevice is re-exported from the barrel.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
// Import ForgetDevice as both type and value to verify it's exported
import { ForgetDevice } from "../../../src/application/index.ts";
import type { ForgetDeviceInput, ForgetDeviceOutput } from "../../../src/application/index.ts";

Deno.test("application barrel: exports ForgetDevice class", () => {
  // Verify ForgetDevice is exported as a constructor (class)
  assertEquals(typeof ForgetDevice, "function");
});

Deno.test("application barrel: exports ForgetDeviceInput and ForgetDeviceOutput types", () => {
  // These types should be re-exported from the barrel
  // We verify they exist as non-null types
  const _input: ForgetDeviceInput = { fingerprint: "test-fp" };
  const _output: ForgetDeviceOutput = { devices: [] };
  assertEquals(_input.fingerprint, "test-fp");
  assertEquals(_output.devices.length, 0);
});
