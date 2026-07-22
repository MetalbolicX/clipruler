/**
 * shells/desktop/bindings.ts — admin bindings for the desktop webview
 *
 * Exposes the admin command interface (adminCommand) to the webview context
 * as window.__clipruler.invoke(method, params?), matching the envelope protocol.
 *
 * Design: #2534 DWB-1.1/1.2
 * Layer:  domain/shell — desktop-specific, no business logic
 */

import type { AdminEndpoint } from "../cli/admin-client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The public bindings surface injected into the webview global scope.
 * Matches window.__clipruler in the renderer.
 */
export interface CliprulerBindings {
  readonly invoke: (method: string, params?: unknown) => Promise<unknown>;
}

/**
 * Admin command function injected from outside (CLI or app context).
 * Resolves the endpoint lazily so we don't require --unstable-desktop at import time.
 */
export type AdminCommandFn = (
  endpoint: AdminEndpoint,
  method: string,
  params?: unknown,
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Internal binding state — stored on the webview object itself as a secret key
// ---------------------------------------------------------------------------

const BINDINGS_KEY = Symbol.for("clipruler.bindings");

interface BindingsRecord {
  invoke: (method: string, params?: unknown) => Promise<unknown>;
}

function _getBindings(webview: unknown): BindingsRecord | undefined {
  if (webview == null || typeof webview !== "object") return undefined;
  return (webview as Record<symbol, BindingsRecord>)[BINDINGS_KEY];
}

function setBindings(webview: unknown, bindings: BindingsRecord): void {
  if (webview == null || typeof webview !== "object") return;
  Object.defineProperty(webview as object, BINDINGS_KEY, {
    value: bindings,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

function deleteBindings(webview: unknown): void {
  if (webview == null || typeof webview !== "object") return;
  // deno-lint-ignore no-explicit-any
  delete (webview as any)[BINDINGS_KEY];
}

// ---------------------------------------------------------------------------
// registerBindings — populate window.__clipruler in the webview
// ---------------------------------------------------------------------------

/**
 * Register the admin command bindings into the webview global scope.
 *
 * @param webview       — BrowserWindow or webview object (must expose a global scope)
 * @param endpoint      — Resolved admin endpoint (unix socket or TCP port)
 * @param adminCommand  — adminCommand implementation (injected from outside)
 */
export function registerBindings(
  webview: unknown,
  endpoint: AdminEndpoint,
  adminCommand: AdminCommandFn,
): CliprulerBindings {
  const invoke: BindingsRecord["invoke"] = (method, params) =>
    adminCommand(endpoint, method, params);

  const bindings: CliprulerBindings = { invoke };

  // Store on the webview object so unregisterBindings can find and delete it
  setBindings(webview, { invoke });

  // Also expose to the webview's global scope via the webview's globalThis
  // We access it via the webview's globalThis.__clipruler surface.
  // Casting through unknown because the webview type is opaque.
  // deno-lint-ignore no-explicit-any
  const global = (webview as any).globalThis ?? (webview as unknown);
  if (global && typeof global === "object") {
    Object.defineProperty(global, "__clipruler", {
      value: bindings,
      writable: false,
      enumerable: true,
      configurable: true,
    });
  }

  return bindings;
}

// ---------------------------------------------------------------------------
// unregisterBindings — remove window.__clipruler from the webview
// ---------------------------------------------------------------------------

/**
 * Unregister the admin command bindings from the webview global scope.
 * After this, any invoke() call from the renderer will reject.
 *
 * @param webview — same BrowserWindow or webview object passed to registerBindings
 */
export function unregisterBindings(webview: unknown): void {
  // Remove from internal symbol store
  deleteBindings(webview);

  // Remove from the webview's global scope — redefine as null so any subsequent
  // invoke() call throws TypeError (null.invoke() → "cannot read property")
  // deno-lint-ignore no-explicit-any
  const global = (webview as any).globalThis ?? (webview as any);
  if (global && typeof global === "object") {
    Object.defineProperty(global, "__clipruler", {
      value: null,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

// ---------------------------------------------------------------------------
// onReload — DWB-2.3 graceful gap handler (no-op; event is cosmetic)
// ---------------------------------------------------------------------------

/**
 * Register a handler to be called when the webview reloads.
 * Deno.BrowserWindow does not expose a 'reload' event in its public API
 * (DWB-2.3 gap). This is a no-op stub kept for API symmetry with webview.ts
 * so the desktop entry point can call it uniformly.
 *
 * @param _webview  — the webview object
 * @param _handler  — callback (unused — gap)
 */
export function onReload(_webview: unknown, _handler: () => void): void {
  // DWB-2.3: BrowserWindow 'reload' event not documented; no-op to avoid
  // crashing the webview process if the event never fires.
}
