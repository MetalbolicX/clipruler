/**
 * Unit tests for shells/desktop/desktop-ui-port.ts — DesktopUiPort adapter
 *
 * Verifies the UiPort adapter for desktop (Design #2534, DWB-5.1/5.2):
 * - presentPairingCode(code) emits {type:"pairing-code", code} to the bridge
 * - confirmPairing(remoteName, code) returns Promise<boolean> driven by the bridge
 * - notifyPaired(deviceName) emits {type:"paired", deviceName}
 * - notifyPairingFailed(reason) emits {type:"pairing-failed", reason}
 *
 * Layer: unit — injects a mock WebviewBridge to verify message contract.
 */

import { assertEquals } from "jsr:@std/assert@^1.0";

// ---------------------------------------------------------------------------
// Mock WebviewBridge
// ---------------------------------------------------------------------------

interface PublishedMessage {
  type: string;
  code?: string;
  deviceName?: string;
  reason?: string;
}

interface MockBridge {
  published: PublishedMessage[];
  confirmResolver: ((value: boolean) => void) | null;
  publish(msg: PublishedMessage): Promise<void>;
  // deno-lint-ignore no-explicit-any
  invoke(method: string, params?: any): Promise<any>;
  // deno-lint-ignore no-explicit-any
  invokeResult: any;
  invokeCalls: Array<{ method: string; params?: unknown }>;
}

function makeMockBridge(): MockBridge {
  const mock: MockBridge = {
    published: [],
    confirmResolver: null,
    publish: async (msg: PublishedMessage): Promise<void> => {
      mock.published.push(msg);
    },
    invoke: (method: string, params?: unknown): Promise<unknown> => {
      mock.invokeCalls.push({ method, params });
      if (method === "admin.pair.confirm") {
        return new Promise((resolve) => {
          mock.confirmResolver = resolve as (value: boolean) => void;
        });
      }
      return Promise.resolve(mock.invokeResult);
    },
    invokeResult: undefined,
    invokeCalls: [],
  };

  return mock;
}

// ---------------------------------------------------------------------------
// Test helpers — import the class lazily (RED phase: file does not exist yet)
// ---------------------------------------------------------------------------

Deno.test("DesktopUiPort: presentPairingCode emits {type:'pairing-code', code}", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { DesktopUiPort } = await import(
    "../../../../src/shells/desktop/desktop-ui-port.ts"
  );

  const bridge = makeMockBridge();
  // @ts-ignore — bridge seam for test injection
  const port = new DesktopUiPort(bridge);

  await port.presentPairingCode("ABC-123");

  assertEquals(bridge.published.length, 1, "must publish exactly one message");
  const msg = bridge.published[0]!;
  assertEquals(msg.type, "pairing-code");
  assertEquals(msg.code, "ABC-123");
});

Deno.test("DesktopUiPort: confirmPairing returns Promise<boolean> resolved by bridge", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { DesktopUiPort } = await import(
    "../../../../src/shells/desktop/desktop-ui-port.ts"
  );

  const bridge = makeMockBridge();
  // @ts-ignore — bridge seam for test injection
  const port = new DesktopUiPort(bridge);

  // Kick off confirmPairing — it should be pending
  const confirmPromise = port.confirmPairing("remote-device", "XYZ-789");

  // Bridge must have received an invoke call
  assertEquals(bridge.invokeCalls.length, 1, "confirmPairing must invoke the bridge");
  const call = bridge.invokeCalls[0]!;
  assertEquals(call.method, "admin.pair.confirm");

  // Resolve the confirm dialog with true
  const resolver = bridge.confirmResolver;
  assertEquals(resolver !== null, true, "confirmPairing must provide a resolver to the bridge");
  resolver!(true);

  const result = await confirmPromise;
  assertEquals(result, true, "confirmPairing must resolve to the user's choice");
});

Deno.test("DesktopUiPort: confirmPairing resolves false when user rejects", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { DesktopUiPort } = await import(
    "../../../../src/shells/desktop/desktop-ui-port.ts"
  );

  const bridge = makeMockBridge();
  // @ts-ignore — bridge seam for test injection
  const port = new DesktopUiPort(bridge);

  const confirmPromise = port.confirmPairing("remote-device", "XYZ-789");
  const resolver = bridge.confirmResolver!;
  resolver(false);

  const result = await confirmPromise;
  assertEquals(result, false, "confirmPairing must resolve false when user rejects");
});

Deno.test("DesktopUiPort: notifyPaired emits {type:'paired', deviceName}", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { DesktopUiPort } = await import(
    "../../../../src/shells/desktop/desktop-ui-port.ts"
  );

  const bridge = makeMockBridge();
  // @ts-ignore — bridge seam for test injection
  const port = new DesktopUiPort(bridge);

  await port.notifyPaired("My Phone");

  assertEquals(bridge.published.length, 1);
  const msg = bridge.published[0]!;
  assertEquals(msg.type, "paired");
  assertEquals(msg.deviceName, "My Phone");
});

Deno.test("DesktopUiPort: notifyPairingFailed emits {type:'pairing-failed', reason}", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { DesktopUiPort } = await import(
    "../../../../src/shells/desktop/desktop-ui-port.ts"
  );

  const bridge = makeMockBridge();
  // @ts-ignore — bridge seam for test injection
  const port = new DesktopUiPort(bridge);

  await port.notifyPairingFailed("mismatch");

  assertEquals(bridge.published.length, 1);
  const msg = bridge.published[0]!;
  assertEquals(msg.type, "pairing-failed");
  assertEquals(msg.reason, "mismatch");
});

Deno.test("DesktopUiPort: notifyPairingFailed accepts all three reason variants", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { DesktopUiPort } = await import(
    "../../../../src/shells/desktop/desktop-ui-port.ts"
  );

  for (const reason of ["mismatch", "rejected", "timeout"] as const) {
    const bridge = makeMockBridge();
    // @ts-ignore — bridge seam for test injection
    const port = new DesktopUiPort(bridge);

    await port.notifyPairingFailed(reason);

    assertEquals(bridge.published.length, 1);
    const msg = bridge.published[0]!;
    assertEquals(msg.reason, reason, `reason '${reason}' must be passed through`);
  }
});
