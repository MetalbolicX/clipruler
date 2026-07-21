/**
 * Unit tests for ports/ui.ts — UiPort interface contract.
 *
 * Verifies:
 * - UiPort interface has exactly four methods with correct signatures
 * - Each method has the correct parameter types and return type
 *
 * Layer: unit — type-level assertions via structural typing.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type { UiPort } from "../../../src/ports/ui.ts";

/**
 * Scenario: UiPort interface has exactly four required method signatures.
 *
 * This test uses TypeScript's structural type compatibility to verify the
 * interface contract. A mock that satisfies UiPort proves the shape is correct.
 */
Deno.test("UiPort has exactly four methods with correct signatures", () => {
  const mock: UiPort = {
    presentPairingCode(code: string): Promise<void> {
      void code;
      return Promise.resolve();
    },
    confirmPairing(remoteName: string, code: string): Promise<boolean> {
      void remoteName;
      void code;
      return Promise.resolve(false);
    },
    notifyPaired(deviceName: string): Promise<void> {
      void deviceName;
      return Promise.resolve();
    },
    notifyPairingFailed(
      reason: "mismatch" | "rejected" | "timeout",
    ): Promise<void> {
      void reason;
      return Promise.resolve();
    },
  };

  // Assert all four methods exist and are callable
  assertEquals(typeof mock.presentPairingCode, "function");
  assertEquals(typeof mock.confirmPairing, "function");
  assertEquals(typeof mock.notifyPaired, "function");
  assertEquals(typeof mock.notifyPairingFailed, "function");

  // Verify method signatures by checking arity (number of declared parameters)
  assertEquals(mock.presentPairingCode.length, 1);
  assertEquals(mock.confirmPairing.length, 2);
  assertEquals(mock.notifyPaired.length, 1);
  assertEquals(mock.notifyPairingFailed.length, 1);
});
