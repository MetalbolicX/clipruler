/**
 * Unit tests for shells/desktop/bindings.ts — admin bindings
 *
 * Verifies the admin bindings lifecycle (Design #2534, DWB-1.1/1.2/2.3):
 * - registerBindings(webview, adminCommand) populates window.__clipruler
 * - re-registering replaces the previous binding
 * - invoke() returns Promise<unknown> matching adminCommand envelope
 * - calling invoke() after unregisterBindings() rejects
 *
 * Layer: unit — injects a mock adminCommand and verifies bindings lifecycle.
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0";

// ---------------------------------------------------------------------------
// Mock adminCommand
// ---------------------------------------------------------------------------

type AdminEndpoint = { kind: "unix"; path: string } | { kind: "tcp"; port: number };
type AdminResponse<T = unknown> = { status: "ok" | "error"; data?: T; message?: string };

interface MockAdminCommand {
  callCount: number;
  calls: Array<{ endpoint: AdminEndpoint; method: string; params?: unknown }>;
  responses: Map<string, AdminResponse<unknown>>;
}

function makeMockAdminCommand(): MockAdminCommand & {
  (endpoint: AdminEndpoint, method: string, params?: unknown): Promise<AdminResponse<unknown>>;
} {
  // Build the mock object first; the function will close over it directly.
  // Object.assign(fn, mock) copies mock's own enumerable properties onto fn,
  // so fn.callCount starts as 0. Inside fn, we increment mock.callCount
  // (the object fn closes over), not fn.callCount. We also write back to
  // fn.callCount so callers reading .callCount see the updated value.
  const mock: MockAdminCommand = {
    callCount: 0,
    calls: [],
    responses: new Map(),
  };

  const fn = (
    endpoint: AdminEndpoint,
    method: string,
    params?: unknown,
  ): Promise<AdminResponse<unknown>> => {
    mock.callCount++;
    // Keep fn.callCount in sync so tests that read .callCount get the right value
    // deno-lint-ignore no-explicit-any
    (fn as any).callCount = mock.callCount;
    mock.calls.push({ endpoint, method, params });
    const response = mock.responses.get(method);
    return Promise.resolve(response ?? { status: "ok", data: {} });
  };

  return Object.assign(fn, mock);
}

// ---------------------------------------------------------------------------
// Mock webview — plain object with typed globalThis
// ---------------------------------------------------------------------------

/** Minimal webview seam with typed globalThis for unit testing bindings */
interface MockWebview {
  readonly globalThis: Record<string, unknown>;
}

function makeMockWebview(): MockWebview {
  return { globalThis: {} };
}

// ---------------------------------------------------------------------------
// Test helpers — import the module lazily (RED phase: file does not exist yet)
// ---------------------------------------------------------------------------

Deno.test("bindings: registerBindings populates window.__clipruler.invoke", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { registerBindings } = await import("../../../../src/shells/desktop/bindings.ts");

  const mockCmd = makeMockAdminCommand();
  mockCmd.responses.set("admin.list", { status: "ok", data: { devices: [] } });

  const mockWebview = makeMockWebview();
  const win = mockWebview.globalThis;

  const fakeEndpoint: AdminEndpoint = { kind: "unix", path: "/tmp/clipruler-test.sock" };

  // Register bindings with the mock command
  registerBindings(mockWebview as unknown, fakeEndpoint, mockCmd);

  // window.__clipruler must be defined with an invoke function
  const bindings = win.__clipruler as {
    invoke: (method: string, params?: unknown) => Promise<unknown>;
  };
  assertEquals(typeof bindings?.invoke, "function", "window.__clipruler.invoke must be a function");
});

Deno.test("bindings: invoke() proxies to adminCommand with correct method", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { registerBindings } = await import("../../../../src/shells/desktop/bindings.ts");

  const mockCmd = makeMockAdminCommand();
  mockCmd.responses.set("admin.list", {
    status: "ok",
    data: { devices: [{ id: "1", name: "Device1" }] },
  });

  const mockWebview = makeMockWebview();
  const win = mockWebview.globalThis;

  const fakeEndpoint: AdminEndpoint = { kind: "unix", path: "/tmp/clipruler-test.sock" };
  await registerBindings(mockWebview as unknown, fakeEndpoint, mockCmd);

  const bindings = win.__clipruler as { invoke: (m: string, p?: unknown) => Promise<unknown> };
  const result = await bindings.invoke("admin.list", {}) as AdminResponse<unknown>;

  assertEquals(mockCmd.callCount, 1, "adminCommand must be called once");
  assertEquals(mockCmd.calls[0]?.method, "admin.list", "must call admin.list");
  assertEquals(result.status, "ok", "response status must be 'ok'");
});

Deno.test("bindings: re-registering replaces the previous binding", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { registerBindings } = await import("../../../../src/shells/desktop/bindings.ts");

  const mockCmd1 = makeMockAdminCommand();
  mockCmd1.responses.set("admin.list", { status: "ok", data: { devices: [] } });
  const mockCmd2 = makeMockAdminCommand();
  mockCmd2.responses.set("admin.list", { status: "ok", data: { devices: [{ id: "X" }] } });

  const mockWebview = makeMockWebview();
  const win = mockWebview.globalThis;

  const fakeEndpoint: AdminEndpoint = { kind: "unix", path: "/tmp/clipruler-test.sock" };
  registerBindings(mockWebview as unknown, fakeEndpoint, mockCmd1);
  registerBindings(mockWebview as unknown, fakeEndpoint, mockCmd2);

  // Only the second binding should be active
  const bindings = win.__clipruler as { invoke: (m: string) => Promise<unknown> };
  await bindings.invoke("admin.list");

  assertEquals(mockCmd1.callCount, 0, "first binding must no longer be called");
  assertEquals(mockCmd2.callCount, 1, "second binding must be called");
});

Deno.test("bindings: invoke() returns Promise<unknown> matching adminCommand envelope", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { registerBindings } = await import("../../../../src/shells/desktop/bindings.ts");

  const mockCmd = makeMockAdminCommand();
  mockCmd.responses.set("admin.list", {
    status: "ok",
    data: { devices: [{ id: "1", name: "TestDevice" }] },
  });

  const mockWebview = makeMockWebview();
  const win = mockWebview.globalThis;

  const fakeEndpoint: AdminEndpoint = { kind: "unix", path: "/tmp/clipruler-test.sock" };
  await registerBindings(mockWebview as unknown, fakeEndpoint, mockCmd);

  const bindings = win.__clipruler as { invoke: (m: string, p?: unknown) => Promise<unknown> };
  const result = await bindings.invoke("admin.list", {});

  // Verify the response matches AdminResponse envelope shape
  assertEquals(typeof result, "object", "invoke must return an object");
  const response = result as AdminResponse<unknown>;
  assertEquals(response.status, "ok");
  assertEquals(
    Array.isArray(response.data && (response.data as { devices: unknown }).devices),
    true,
  );
});

Deno.test("bindings: calling invoke() after unregisterBindings() rejects", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { registerBindings, unregisterBindings } = await import(
    "../../../../src/shells/desktop/bindings.ts"
  );

  const mockCmd = makeMockAdminCommand();
  mockCmd.responses.set("admin.list", { status: "ok", data: { devices: [] } });

  const mockWebview = makeMockWebview();
  const win = mockWebview.globalThis;

  const fakeEndpoint: AdminEndpoint = { kind: "unix", path: "/tmp/clipruler-test.sock" };
  await registerBindings(mockWebview as unknown, fakeEndpoint, mockCmd);
  unregisterBindings(mockWebview as unknown);

  const bindings = win.__clipruler as { invoke: (m: string) => Promise<unknown> | undefined };

  await assertRejects(
    async () => {
      await bindings.invoke("admin.list");
    },
    Error,
    "Cannot read properties of null",
  );
});
