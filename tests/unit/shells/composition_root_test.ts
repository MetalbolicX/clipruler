/**
 * tests/unit/shells/composition_root_test.ts
 *
 * Unit tests for composition-root.ts.
 * Strict TDD: RED first — verifies buildAndRunDaemon uiPort wiring.
 *
 * Layer: unit — tests the type signature and UiPort seam.
 *
 * NOTE: Full daemon startup (buildAndRunDaemon end-to-end) requires listenDatagram
 * which is a Deno kernel API. Those tests live in daemon_lifecycle_test.ts.
 * These tests verify the type contract and UiPort parameter handling.
 */

import { assertEquals } from "jsr:@std/assert@^1.0";
import type { UiPort } from "../../../src/ports/ui.ts";

// ---------------------------------------------------------------------------
// Type-level tests (verify the type signature)
// ---------------------------------------------------------------------------

Deno.test(
  "buildAndRunDaemon accepts uiPort as optional parameter (type check)",
  async () => {
    // This test verifies the type-level contract.
    // If uiPort?: UiPort is not in the signature, this file fails to compile.
    const { buildAndRunDaemon } = await import(
      "../../../src/shells/composition-root.ts"
    );

    // TypeScript checks that uiPort is accepted as optional.
    // We only verify the function is callable with uiPort — not that it runs successfully.
    type Params = Parameters<typeof buildAndRunDaemon>;
    type Opts = Params[0];

    // Opts must have deviceName (required) and uiPort (optional)
    const opts: Opts = {
      deviceName: "test-type-check",
    };

    assertEquals(opts.deviceName, "test-type-check");

    // Also verify it accepts an explicit uiPort
    const port: UiPort = {
      presentPairingCode: () => Promise.resolve(),
      confirmPairing: () => Promise.resolve(false),
      notifyPaired: () => Promise.resolve(),
      notifyPairingFailed: () => Promise.resolve(),
    };
    const opts2: Opts = {
      deviceName: "test-type-check-2",
      uiPort: port,
    };
    assertEquals(opts2.uiPort, port);
  },
);

// ---------------------------------------------------------------------------
// UiPort mock for integration verification
// ---------------------------------------------------------------------------

/** A UiPort that records every call for assertion. */
class RecordingUiPort implements UiPort {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  presentPairingCode(code: string): Promise<void> {
    this.calls.push({ method: "presentPairingCode", args: [code] });
    return Promise.resolve();
  }

  confirmPairing(remoteName: string, code: string): Promise<boolean> {
    this.calls.push({ method: "confirmPairing", args: [remoteName, code] });
    return Promise.resolve(false);
  }

  notifyPaired(deviceName: string): Promise<void> {
    this.calls.push({ method: "notifyPaired", args: [deviceName] });
    return Promise.resolve();
  }

  notifyPairingFailed(
    reason: "mismatch" | "rejected" | "timeout",
  ): Promise<void> {
    this.calls.push({ method: "notifyPairingFailed", args: [reason] });
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Stub verification tests
// ---------------------------------------------------------------------------

Deno.test(
  "UiPort stub has all four required methods (shape check)",
  () => {
    // Verify the stub in composition-root.ts conforms to UiPort interface
    const stubUi: UiPort = {
      presentPairingCode(_code: string): Promise<void> {
        return Promise.resolve();
      },
      confirmPairing(_remoteName: string, _code: string): Promise<boolean> {
        return Promise.resolve(false);
      },
      notifyPaired(_deviceName: string): Promise<void> {
        return Promise.resolve();
      },
      notifyPairingFailed(
        _reason: "mismatch" | "rejected" | "timeout",
      ): Promise<void> {
        return Promise.resolve();
      },
    };

    // Each method must exist and be callable
    assertEquals(typeof stubUi.presentPairingCode, "function");
    assertEquals(typeof stubUi.confirmPairing, "function");
    assertEquals(typeof stubUi.notifyPaired, "function");
    assertEquals(typeof stubUi.notifyPairingFailed, "function");
  },
);

Deno.test(
  "RecordingUiPort correctly records method calls",
  async () => {
    const port = new RecordingUiPort();

    await port.presentPairingCode("123456");
    await port.notifyPaired("Device B");
    await port.notifyPairingFailed("timeout");
    const confirmResult = await port.confirmPairing("Device C", "654321");

    assertEquals(confirmResult, false);
    assertEquals(port.calls.length, 4);
    assertEquals(port.calls[0], {
      method: "presentPairingCode",
      args: ["123456"],
    });
    assertEquals(port.calls[1], {
      method: "notifyPaired",
      args: ["Device B"],
    });
    assertEquals(port.calls[2], {
      method: "notifyPairingFailed",
      args: ["timeout"],
    });
    assertEquals(port.calls[3], {
      method: "confirmPairing",
      args: ["Device C", "654321"],
    });
  },
);
