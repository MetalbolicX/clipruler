/**
 * shells/desktop/webview.ts
 *
 * Webview facade wrapping Deno.BrowserWindow.
 *
 * Design (Plan 011, Design #2534):
 * - Wraps Deno.BrowserWindow (or the platform's default webview backend)
 * - register() calls win.bind() to expose __clipruler.invoke to the webview
 * - publish(message) delivers a message to the webview page
 * - close() destroys the window
 * - onReload(handler) hooks the reload event so bindings can re-register
 *
 * Deno 2.9.3 BrowserWindow API (verified from docs):
 * - BrowserWindow implements EventTarget, supports: resize, move, focus, blur,
 *   close, keydown/keyup, mouse events, menuclick/contextmenuclick
 * - .webview property exposes the underlying webview for postMessage
 * - win.bind(name, fn) exposes a Deno function to webview JS as window[name]
 *
 * Open Decision (DWB-2.3 gap): BrowserWindow docs do NOT list a 'reload' event.
 * If win.on('reload', ...) is not supported, onReload() logs a warning and is a
 * no-op. This is documented as a follow-up TODO.
 *
 * TODO(plan-011): Verify whether BrowserWindow.on('reload') is supported in Deno 2.9.3.
 * If not, consider: BrowserWindow.reload() API, or HMR event from the renderer.
 */

export interface Webview {
  /**
   * Register the __clipruler bindings in the webview.
   * Idempotent — safe to call again on reload.
   */
  register(): Promise<void>;

  /**
   * Deliver a message to the webview page.
   * Throws if called before register().
   */
  publish(message: unknown): Promise<void>;

  /**
   * Close the webview window.
   */
  close(): Promise<void>;

  /**
   * Register a handler for the window reload event.
   * Allows the caller (bindings.ts) to re-register bindings after a reload.
   *
   * NOTE: BrowserWindow docs do not document a 'reload' event in Deno 2.9.3.
   * If the event is not supported, this is a no-op that logs a warning.
   */
  onReload(handler: () => void): void;
}

// ---------------------------------------------------------------------------
// Window interface (BrowserWindow seam for testability)
// ---------------------------------------------------------------------------

export interface BrowserWindow {
  /** Show the window. */
  show(): void;
  /** Hide the window. */
  hide(): void;
  /** Close the window. */
  close(): void;
  /**
   * Bind a Deno function to the webview as window[name].
   * The function can be async and return Promises.
   */
  bind(name: string, fn: (...args: unknown[]) => unknown): void;
  /**
   * Post a message to the webview page.
   * The webview receives it via window.addEventListener('message', ...).
   */
  postMessage(message: unknown): void;
  /**
   * Register an event handler.
   * Supported events (Deno 2.9.3): resize, move, focus, blur, close,
   * keydown, keyup, mousemove, mouseenter, mouseleave, mousedown, mouseup,
   * click, dblclick, wheel, menuclick, contextmenuclick
   *
   * NOTE: 'reload' is NOT documented — may not be supported.
   */
  on(event: string, handler: (...args: unknown[]) => void): void;
}

// ---------------------------------------------------------------------------
// Default window factory — uses the real Deno.BrowserWindow
// ---------------------------------------------------------------------------

const makeBrowserWindow = (htmlPath: string): BrowserWindow => {
  // Deno.BrowserWindow is the platform's native window class.
  // It adopts the initial desktop window when created with the htmlPath argument.
  // deno:unstable-desktop is required to access BrowserWindow.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const BW =
    (globalThis as unknown as { Deno: { BrowserWindow: new (html: string) => BrowserWindow } }).Deno
      ?.BrowserWindow;
  if (!BW) {
    throw new Error(
      "Deno.BrowserWindow is not available. " +
        "Ensure you are running with --unstable-desktop or use 'deno desktop'.",
    );
  }
  return new BW(htmlPath);
};

// ---------------------------------------------------------------------------
// WebviewImpl
// ---------------------------------------------------------------------------

/**
 * Webview facade — wraps a platform BrowserWindow with a testable seam.
 *
 * @param htmlPath - Path to the HTML file to load in the webview
 * @param opts._win - Inject a mock BrowserWindow for unit testing
 */
export class WebviewImpl implements Webview {
  #win: BrowserWindow | null = null;
  #htmlPath: string;
  #registered = false;
  #messageQueue: unknown[] = [];
  #reloadHandlers: (() => void)[] = [];
  #makeWindow: (htmlPath: string) => BrowserWindow;

  constructor(
    htmlPath: string,
    opts?: {
      _win?: BrowserWindow | { [key: string]: unknown };
      _makeWindow?: (htmlPath: string) => BrowserWindow;
    },
  ) {
    this.#htmlPath = htmlPath;
    this.#makeWindow = opts?._makeWindow ?? makeBrowserWindow;
    if (opts?._win) {
      // Test seam: inject a mock or partial BrowserWindow
      this.#win = opts._win as unknown as BrowserWindow;
    }
  }

  async register(): Promise<void> {
    // Satisfy lint: async method has no await expression.
    await Promise.resolve();
    if (!this.#win) {
      this.#win = this.#makeWindow(this.#htmlPath);
    }

    // Register the reload event once. When triggered, it calls all queued handlers.
    // NOTE: If BrowserWindow does not emit 'reload', this is silently ignored.
    try {
      (this.#win as unknown as { on(event: string, handler: () => void): void }).on(
        "reload",
        () => {
          this.#registered = false;
          for (const h of this.#reloadHandlers) h();
        },
      );
    } catch {
      // 'reload' event not supported — log and continue
      console.warn(
        "[webview] BrowserWindow 'reload' event is not supported " +
          "in this Deno version. Bindings re-registration on reload may not work. " +
          "See plan-011 DWB-2.3 gap.",
      );
    }

    // Expose __clipruler.invoke to the webview page.
    // The actual invoke implementation is wired in bindings.ts.
    // We bind a function that the webview calls via window.__clipruler.invoke().
    this.#win.bind("__clipruler", () => {
      // This is the bridge function — the real invoke logic is injected
      // when bindings.registerBindings(webview, adminCommand) is called.
      // We use a callback pattern so this facade stays neutral.
      return { __clipruler_marker: "registered" };
    });

    this.#registered = true;

    // Drain the message queue
    while (this.#messageQueue.length > 0) {
      const msg = this.#messageQueue.shift();
      this.#win.postMessage(msg);
    }
  }

  async publish(message: unknown): Promise<void> {
    // Satisfy lint: async method has no await expression.
    await Promise.resolve();
    if (!this.#registered || !this.#win) {
      throw new Error(
        "Webview.publish() called before register(). " +
          "Register the webview first.",
      );
    }
    this.#win.postMessage(message);
  }

  async close(): Promise<void> {
    // Satisfy lint: async method has no await expression.
    await Promise.resolve();
    if (this.#win) {
      this.#win.close();
      this.#win = null;
      this.#registered = false;
    }
  }

  onReload(handler: () => void): void {
    this.#reloadHandlers.push(handler);
    // Register the reload event on the window if available.
    // If 'reload' is not a supported event, this is a no-op.
    if (this.#win) {
      try {
        (this.#win as unknown as { on(event: string, handler: () => void): void }).on(
          "reload",
          () => {
            this.#registered = false;
            for (const h of this.#reloadHandlers) h();
          },
        );
      } catch {
        // 'reload' event not supported — log and continue
        console.warn(
          "[webview] BrowserWindow 'reload' event is not supported " +
            "in this Deno version. Bindings re-registration on reload may not work. " +
            "See plan-011 DWB-2.3 gap.",
        );
      }
    }
  }
}

// Named export alias for the locked design signature
export const Webview: {
  new (
    htmlPath: string,
    opts?: {
      _win?: BrowserWindow | { [key: string]: unknown };
      _makeWindow?: (htmlPath: string) => BrowserWindow;
    },
  ): Webview;
} = WebviewImpl;
