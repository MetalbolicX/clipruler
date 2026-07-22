/**
 * Unit tests for shells/desktop/webview-bridge.ts — WebviewBridge adapter
 *
 * Verifies the bridge between UiPort and webview message bus (Design #2534, DWB-5.2):
 * - register() calls bindings.register with webview, endpoint, adminCommand
 * - publish(message) delivers to webview via webview.publish
 * - invoke(method, params) proxies to the registered adminCommand via bindings
 * - Re-register replaces previous binding
 * - Unregister clears the message bus
 *
 * Layer: unit — injects mock webview; uses real bindings module.
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0";

// ---------------------------------------------------------------------------
// Mock types
// ---------------------------------------------------------------------------

type AdminEndpoint = { kind: "unix"; path: string } | { kind: "tcp"; port: number };

interface PublishedMessage {
  type: string;
  [key: string]: unknown;
}

interface MockWebview {
  registered: boolean;
  publishedMessages: PublishedMessage[];
  globalThis: Record<string, unknown>;
  register(): Promise<void>;
  publish(message: unknown): Promise<void>;
  close(): Promise<void>;
  onReload(handler: () => void): void;
}

function makeMockWebview(): MockWebview {
  return {
    registered: false,
    publishedMessages: [],
    globalThis: {},
    async register() { this.registered = true; },
    async publish(message: unknown) {
      if (!this.registered) {
        throw new Error("Webview.publish() called before register(). Register the webview first.");
      }
      this.publishedMessages.push(message as PublishedMessage);
    },
    async close() { this.registered = false; },
    onReload(_handler) {},
  };
}

interface MockAdminCommand {
  callCount: number;
  calls: Array<{ method: string; params?: unknown }>;
  // deno-lint-ignore no-explicit-any
  responses: Map<string, any>;
  // deno-lint-ignore no-explicit-any
  (endpoint: AdminEndpoint, method: string, params?: any): Promise<any>;
}

function makeMockAdminCommand(): MockAdminCommand {
  // Use a state object so callCount/calls/responses are live references
  // (avoids Object.assign copying primitives by value)
  const state = {
    callCount: 0,
    calls: [] as Array<{ method: string; params?: unknown }>,
    responses: new Map<string, unknown>(),
  };

  const fn = (
    endpoint: AdminEndpoint,
    method: string,
    params?: unknown,
  ): Promise<unknown> => {
    state.callCount++;
    state.calls.push({ method, params });
    return Promise.resolve(state.responses.get(method) ?? { status: "ok" });
  };

  // Use defineProperties so properties are live references to state
  Object.defineProperties(fn, {
    callCount: {
      get: () => state.callCount,
      set: (v) => { state.callCount = v; },
      enumerable: true,
      configurable: true,
    },
    calls: {
      get: () => state.calls,
      set: (v) => { state.calls = v; },
      enumerable: true,
      configurable: true,
    },
    responses: {
      get: () => state.responses,
      set: (v) => { state.responses = v; },
      enumerable: true,
      configurable: true,
    },
  });

  return fn as unknown as MockAdminCommand;
}

// ---------------------------------------------------------------------------
// Test helpers — import the class lazily (RED phase: file does not exist yet)
// ---------------------------------------------------------------------------

Deno.test("webview-bridge: register() wires __clipruler.invoke into webview globalThis", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { WebviewBridge } = await import("../../../../src/shells/desktop/webview-bridge.ts");

  const webview = makeMockWebview();
  const adminCmd = makeMockAdminCommand();
  const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/test.sock" };

  const bridge = new WebviewBridge(webview as unknown as MockWebview, {
    endpoint,
    adminCommand: adminCmd,
  });

  await bridge.register();

  // The webview's globalThis should have __clipruler bound
  const bindings = webview.globalThis["__clipruler"] as {
    invoke: (method: string, params?: unknown) => Promise<unknown>;
  } | undefined;
  assertEquals(typeof bindings?.invoke, "function", "__clipruler.invoke must be bound on webview globalThis");
});

Deno.test("webview-bridge: publish(message) delivers to webview", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { WebviewBridge } = await import("../../../../src/shells/desktop/webview-bridge.ts");

  const webview = makeMockWebview();
  const adminCmd = makeMockAdminCommand();
  const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/test.sock" };

  const bridge = new WebviewBridge(webview as unknown as MockWebview, {
    endpoint,
    adminCommand: adminCmd,
  });

  await bridge.register();
  await bridge.publish({ type: "pairing-code", code: "ABC-123" });

  assertEquals(webview.publishedMessages.length, 1, "webview.publish must be called once");
  assertEquals(webview.publishedMessages[0]?.type, "pairing-code");
  assertEquals(webview.publishedMessages[0]?.code, "ABC-123");
});

Deno.test("webview-bridge: invoke(method, params) proxies to adminCommand via bindings", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { WebviewBridge } = await import("../../../../src/shells/desktop/webview-bridge.ts");

  const webview = makeMockWebview();
  const adminCmd = makeMockAdminCommand();
  adminCmd.responses.set("admin.list", { status: "ok", data: { devices: [] } });
  const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/test.sock" };

  const bridge = new WebviewBridge(webview as unknown as MockWebview, {
    endpoint,
    adminCommand: adminCmd,
  });

  await bridge.register();

  // Call via the bound __clipruler.invoke (mirrors how the webview page calls it)
  // deno-lint-ignore no-explicit-any
  const bindings = webview.globalThis["__clipruler"] as any;
  const result = await bindings.invoke("admin.list", { foo: "bar" });

  assertEquals(adminCmd.callCount, 1, "adminCommand must be called once via bindings.invoke");
  assertEquals(adminCmd.calls[0]?.method, "admin.list");
  assertEquals(adminCmd.calls[0]?.params, { foo: "bar" });
  assertEquals((result as { status: string }).status, "ok");
});

Deno.test("webview-bridge: re-register replaces previous binding", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { WebviewBridge } = await import("../../../../src/shells/desktop/webview-bridge.ts");

  const webview = makeMockWebview();
  const adminCmd1 = makeMockAdminCommand();
  adminCmd1.responses.set("admin.list", { status: "ok", data: { devices: ["A"] } });
  const adminCmd2 = makeMockAdminCommand();
  adminCmd2.responses.set("admin.list", { status: "ok", data: { devices: ["B"] } });
  const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/test.sock" };

  const bridge = new WebviewBridge(webview as unknown as MockWebview, {
    endpoint,
    adminCommand: adminCmd1,
  });

  await bridge.register();

  // Verify first binding works
  // deno-lint-ignore no-explicit-any
  const bindings1 = webview.globalThis["__clipruler"] as any;
  await bindings1.invoke("admin.list", {});
  assertEquals(adminCmd1.callCount, 1);

  // Re-register with different adminCommand
  bridge.swapAdminCommand(adminCmd2);
  await bridge.register();

  // deno-lint-ignore no-explicit-any
  const bindings2 = webview.globalThis["__clipruler"] as any;
  await bindings2.invoke("admin.list", {});

  assertEquals(adminCmd1.callCount, 1, "first adminCommand not called again after re-register");
  assertEquals(adminCmd2.callCount, 1, "second adminCommand called once after re-register");
});

Deno.test("webview-bridge: unregister() calls bindings.unregister", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { WebviewBridge } = await import("../../../../src/shells/desktop/webview-bridge.ts");

  const webview = makeMockWebview();
  const adminCmd = makeMockAdminCommand();
  const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/test.sock" };

  const bridge = new WebviewBridge(webview as unknown as MockWebview, {
    endpoint,
    adminCommand: adminCmd,
  });

  await bridge.register();
  await bridge.unregister();

  // After unregister, __clipruler should be null (from bindings.ts)
  assertEquals(webview.globalThis["__clipruler"], null, "__clipruler must be set to null after unregister");
});

Deno.test("webview-bridge: publish before register() rejects", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { WebviewBridge } = await import("../../../../src/shells/desktop/webview-bridge.ts");

  const webview = makeMockWebview();
  const adminCmd = makeMockAdminCommand();
  const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/test.sock" };

  const bridge = new WebviewBridge(webview as unknown as MockWebview, {
    endpoint,
    adminCommand: adminCmd,
  });

  // webview.publish without register throws "before register"
  await assertRejects(
    async () => bridge.publish({ type: "test" }),
    Error,
    "Webview.publish() called before register()",
  );
});
