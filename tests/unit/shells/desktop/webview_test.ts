/**
 * Unit tests for shells/desktop/webview.ts — Webview facade
 *
 * Verifies the webview lifecycle (Design #2534, DWB-2.1):
 * - register() wraps BrowserWindow.bind() to expose __clipruler.invoke
 * - publish(message) queues until registered, then delivers via the binding
 * - close() destroys the window
 * - error if registered twice
 * - error if published before registered
 *
 * Layer: unit — injects a mock BrowserWindow-like object via _window seam.
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0";

// ---------------------------------------------------------------------------
// Mock BrowserWindow
// ---------------------------------------------------------------------------

/** Minimal mock for BrowserWindow — covers the methods used by WebviewImpl. */
type MockWindow = Record<string, unknown>;

/** Creates a mock BrowserWindow for test injection. */
function makeMockWindow() {
  let closed = false;
  let registeredBindings: Record<string, unknown> | null = null;
  const publishedMessages: unknown[] = [];
  let _onReloadHandler: (() => void) | null = null;
  const _eventHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  return {
    get closed() {
      return closed;
    },
    get registeredBindings() {
      return registeredBindings;
    },
    get publishedMessages() {
      return publishedMessages;
    },
    get _onReloadHandler() {
      return _onReloadHandler;
    },
    get _eventHandlers() {
      return _eventHandlers;
    },
    close() {
      closed = true;
    },
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!_eventHandlers[event]) _eventHandlers[event] = [];
      _eventHandlers[event].push(handler);
      if (event === "reload") _onReloadHandler = handler as () => void;
    },
    bind(name: string, fn: (...args: unknown[]) => unknown) {
      if (closed) throw new Error("Cannot bind on closed window");
      registeredBindings = { [name]: fn };
    },
    postMessage(msg: unknown) {
      if (closed) throw new Error("Cannot postMessage on closed window");
      publishedMessages.push(msg);
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers — import the class lazily (RED phase: file does not exist yet)
// ---------------------------------------------------------------------------

Deno.test("webview: register() populates window.__clipruler", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { Webview } = await import("../../../../src/shells/desktop/webview.ts");

  const mock = makeMockWindow();
  // @ts-ignore — _win seam for test injection
  const wv = new Webview("/tmp/test.html", { _win: mock as unknown as MockWindow });

  await wv.register();

  assertEquals(
    typeof (mock.registeredBindings ?? {})["__clipruler"],
    "function",
    "register() must call win.bind('__clipruler', fn)",
  );
});

Deno.test("webview: publish() delivers to webview after register", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { Webview } = await import("../../../../src/shells/desktop/webview.ts");

  const mock = makeMockWindow();
  // @ts-ignore — _win seam for test injection
  const wv = new Webview("/tmp/test.html", { _win: mock as unknown as MockWindow });

  await wv.register();

  // After register, publish should deliver via postMessage
  await wv.publish({ type: "test" });
  assertEquals(
    mock.publishedMessages.length,
    1,
    "publish() after register() should deliver via postMessage",
  );
  assertEquals(mock.publishedMessages[0], { type: "test" });
});

Deno.test("webview: register() twice throws", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { Webview } = await import("../../../../src/shells/desktop/webview.ts");

  const mock = makeMockWindow();
  // @ts-ignore — _win seam for test injection
  const wv = new Webview("/tmp/test.html", { _win: mock as unknown as MockWindow });

  await wv.register();
  await wv.register(); // must throw — already registered
});

Deno.test("webview: publish() before register() rejects", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { Webview } = await import("../../../../src/shells/desktop/webview.ts");

  const mock = makeMockWindow();
  // @ts-ignore — _win seam for test injection
  const wv = new Webview("/tmp/test.html", { _win: mock as unknown as MockWindow });

  // Cannot publish before registering — not ready
  await assertRejects(
    () => wv.publish({ type: "test" }),
    Error,
    "Webview.publish() called before register(). Register the webview first.",
  );
});

Deno.test("webview: close() marks window as closed", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { Webview } = await import("../../../../src/shells/desktop/webview.ts");

  const mock = makeMockWindow();
  // @ts-ignore — _win seam for test injection
  const wv = new Webview("/tmp/test.html", { _win: mock as unknown as MockWindow });

  assertEquals(mock.closed, false, "window starts open");
  await wv.close();
  assertEquals(mock.closed, true, "close() must call win.close()");
});

Deno.test("webview: onReload(handler) registers the reload event", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { Webview } = await import("../../../../src/shells/desktop/webview.ts");

  const mock = makeMockWindow();
  // @ts-ignore — _win seam for test injection
  const wv = new Webview("/tmp/test.html", { _win: mock as unknown as MockWindow });

  let reloadCount = 0;
  wv.onReload(() => {
    reloadCount++;
  });

  // Simulate a reload event
  const handlers = mock._eventHandlers["reload"] ?? [];
  assertEquals(handlers.length > 0, true, "onReload must register a reload event handler");
  (mock._onReloadHandler as (() => void))?.();

  assertEquals(reloadCount, 1, "reload handler must be called once");
});
