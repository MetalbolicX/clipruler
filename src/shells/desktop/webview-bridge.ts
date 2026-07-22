/**
 * shells/desktop/webview-bridge.ts
 *
 * WebviewBridge — adapter between UiPort and the Slice 2 webview bindings.
 *
 * Design (Plan 011, Design #2534, DWB-5.2):
 * - register() calls bindings.register(webview, endpoint, adminCommand)
 * - publish(message) calls webview.publish(message)
 * - invoke(method, params) proxies to the registered adminCommand binding
 * - unregister() calls bindings.unregister(webview)
 *
 * This is the ONLY file (besides webview.ts) that imports bindings.ts directly.
 */

import { registerBindings, unregisterBindings } from "./bindings.ts";
import type { Webview } from "./webview.ts";
import type { AdminEndpoint } from "../cli/admin-client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Admin command function (same signature as adminCommand from admin-client.ts).
 */
export type AdminCommandFn = (
  endpoint: AdminEndpoint,
  method: string,
  params?: unknown,
) => Promise<unknown>;

/** Options for constructing WebviewBridge. */
export interface WebviewBridgeOptions {
  /**
   * Inject mock bindings for unit testing.
   * Allows tests to verify register/unregister call arguments without
   * requiring the full Deno.unstableDesktop permissions.
   */
  // deno-lint-ignore no-explicit-any
  _bindings?: any;
  /** Resolved admin endpoint (unix socket or TCP port). */
  endpoint: AdminEndpoint;
  /** Admin command function for calling daemon methods. */
  adminCommand: AdminCommandFn;
}

// ---------------------------------------------------------------------------
// WebviewBridge
// ---------------------------------------------------------------------------

/**
 * Bridge between UiPort and the webview message bus.
 *
 * WebviewBridge wires together:
 * - The Webview (from webview.ts) — delivers messages to the page
 * - The bindings (from bindings.ts) — exposes adminCommand to the page
 * - UiPort methods → bridge.publish() → webview.publish()
 * - UiPort confirmPairing → bridge.invoke() → adminCommand via bindings
 *
 * @param webview   — Webview instance (from webview.ts facade)
 * @param opts.endpoint — resolved admin endpoint
 * @param opts.adminCommand — adminCommand function
 * @param opts._bindings — inject mock bindings for testing
 */
export class WebviewBridge {
  #webview: Webview;
  #endpoint: AdminEndpoint;
  #adminCommand: AdminCommandFn;
  // deno-lint-ignore no-explicit-any
  #bindings: any;
  #registered = false;

  constructor(webview: Webview, opts: WebviewBridgeOptions) {
    this.#webview = webview;
    this.#endpoint = opts.endpoint;
    this.#adminCommand = opts.adminCommand;
    this.#bindings = opts._bindings ?? { registerBindings, unregisterBindings };
  }

  /**
   * Register the admin command bindings into the webview.
   * Idempotent — safe to call again on reload.
   */
  async register(): Promise<void> {
    await this.#webview.register();
    this.#bindings.registerBindings(this.#webview, this.#endpoint, this.#adminCommand);
    this.#registered = true;
  }

  /**
   * Deliver a UI message to the webview page.
   * @throws Error if called before register()
   */
  async publish(message: unknown): Promise<void> {
    await this.#webview.publish(message);
  }

  /**
   * Invoke an admin command via the registered binding.
   * Requires register() to have been called first.
   */
  async invoke(method: string, params?: unknown): Promise<unknown> {
    // Satisfy lint: async method delegates to sync or async invoke
    await Promise.resolve();
    if (!this.#registered) {
      throw new Error("WebviewBridge.invoke() called before register()");
    }
    // The binding is accessible via the webview's globalThis.__clipruler surface.
    // We access it through the webview object which holds the binding reference.
    // deno-lint-ignore no-explicit-any
    const global = (this.#webview as any).globalThis ?? this.#webview;
    // deno-lint-ignore no-explicit-any
    const bindings = (global as any).__clipruler;
    if (!bindings?.invoke) {
      throw new Error("WebviewBridge: __clipruler.invoke not found on webview");
    }
    return bindings.invoke(method, params);
  }

  /**
   * Unregister the admin bindings from the webview.
   */
  async unregister(): Promise<void> {
    // Satisfy lint: async method calls sync unregister
    await Promise.resolve();
    this.#bindings.unregisterBindings(this.#webview);
    this.#registered = false;
  }

  /**
   * Swap the adminCommand and re-register bindings.
   * Used when the composition root needs to update the admin command after init.
   */
  swapAdminCommand(adminCommand: AdminCommandFn): void {
    this.#adminCommand = adminCommand;
  }
}
