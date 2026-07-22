/**
 * tests/unit/shells/desktop/composition_wiring_test.ts
 *
 * Unit tests for desktop shell composition wiring.
 * Strict TDD: RED first — verifies DesktopUiPort is correctly wired to WebviewBridge.
 *
 * Layer: unit — UiBridge mock, no Deno runtime required.
 */

import { assertEquals } from "jsr:@std/assert@^1.0";
import { DesktopUiPort } from "../../../../src/shells/desktop/desktop-ui-port.ts";
import type { UiBridge, UiMessage } from "../../../../src/shells/desktop/desktop-ui-port.ts";

// ---------------------------------------------------------------------------
// Mock UiBridge
// ---------------------------------------------------------------------------

interface BridgeCall {
  method: "publish" | "invoke";
  args: unknown[];
}

class MockUiBridge implements UiBridge {
  readonly calls: BridgeCall[] = [];
  private invokeResult: unknown = false; // default: pairing rejected

  /** Set the result that invoke() should return. */
  setInvokeResult(result: unknown): void {
    this.invokeResult = result;
  }

  publish(message: UiMessage): Promise<void> {
    this.calls.push({ method: "publish", args: [message] });
    return Promise.resolve();
  }

  invoke(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method: "invoke", args: [method, params] });
    return Promise.resolve(this.invokeResult);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "DesktopUiPort.presentPairingCode calls bridge.publish with correct message",
  async () => {
    const bridge = new MockUiBridge();
    const port = new DesktopUiPort(bridge);

    await port.presentPairingCode("123456");

    assertEquals(bridge.calls.length, 1);
    const call0 = bridge.calls[0]!;
    assertEquals(call0.method, "publish");
    assertEquals(call0.args, [{ type: "pairing-code", code: "123456" }]);
  },
);

Deno.test(
  "DesktopUiPort.confirmPairing calls bridge.invoke with admin.pair.confirm",
  async () => {
    const bridge = new MockUiBridge();
    bridge.setInvokeResult(true); // override to return true (accepted pairing)
    const port = new DesktopUiPort(bridge);

    const result = await port.confirmPairing("Device B", "789012");

    assertEquals(result, true);
    assertEquals(bridge.calls.length, 1);
    const call0 = bridge.calls[0]!;
    assertEquals(call0.method, "invoke");
    assertEquals(call0.args, ["admin.pair.confirm", { remoteName: "Device B", code: "789012" }]);
  },
);

Deno.test(
  "DesktopUiPort.notifyPaired calls bridge.publish with correct message",
  async () => {
    const bridge = new MockUiBridge();
    const port = new DesktopUiPort(bridge);

    await port.notifyPaired("Device B");

    assertEquals(bridge.calls.length, 1);
    const call0 = bridge.calls[0]!;
    assertEquals(call0.method, "publish");
    assertEquals(call0.args, [{ type: "paired", deviceName: "Device B" }]);
  },
);

Deno.test(
  "DesktopUiPort.notifyPairingFailed calls bridge.publish with correct message",
  async () => {
    const bridge = new MockUiBridge();
    const port = new DesktopUiPort(bridge);

    await port.notifyPairingFailed("timeout");

    assertEquals(bridge.calls.length, 1);
    const call0 = bridge.calls[0]!;
    assertEquals(call0.method, "publish");
    assertEquals(call0.args, [{ type: "pairing-failed", reason: "timeout" }]);
  },
);

Deno.test(
  "DesktopUiPort.all methods delegate to bridge (full round-trip)",
  async () => {
    const bridge = new MockUiBridge();
    bridge.setInvokeResult(false); // default: rejected
    const port = new DesktopUiPort(bridge);

    await port.presentPairingCode("111222");
    await port.confirmPairing("Device C", "333444");
    await port.notifyPaired("Device C");
    await port.notifyPairingFailed("rejected");

    assertEquals(bridge.calls.length, 4);
    const call0 = bridge.calls[0]!;
    const call1 = bridge.calls[1]!;
    const call2 = bridge.calls[2]!;
    const call3 = bridge.calls[3]!;
    assertEquals(call0.method, "publish");
    assertEquals(call0.args, [{ type: "pairing-code", code: "111222" }]);
    assertEquals(call1.method, "invoke");
    assertEquals(call1.args, ["admin.pair.confirm", { remoteName: "Device C", code: "333444" }]);
    assertEquals(call2.method, "publish");
    assertEquals(call2.args, [{ type: "paired", deviceName: "Device C" }]);
    assertEquals(call3.method, "publish");
    assertEquals(call3.args, [{ type: "pairing-failed", reason: "rejected" }]);
  },
);
