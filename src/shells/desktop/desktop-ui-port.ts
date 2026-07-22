/**
 * shells/desktop/desktop-ui-port.ts
 *
 * DesktopUiPort — UiPort adapter for the desktop shell.
 *
 * Design (Plan 011, Design #2534, DWB-5.1/5.2):
 * - Implements the 4-method UiPort interface
 * - Bridges to the webview via WebviewBridge
 * - presentPairingCode / notifyPaired / notifyPairingFailed → bridge.publish()
 * - confirmPairing → bridge.invoke("admin.pair.confirm")
 */

import type { UiPort } from "../../ports/ui.ts";

/**
 * Bridge interface between DesktopUiPort and the webview message bus.
 * The concrete WebviewBridge is implemented in webview-bridge.ts.
 */
export interface UiBridge {
  /**
   * Publish a UI event message to the webview page.
   */
  publish(message: UiMessage): Promise<void>;

  /**
   * Invoke an admin command and return the result.
   * Used by confirmPairing to drive the confirm dialog via the webview.
   */
  invoke(method: string, params?: unknown): Promise<unknown>;
}

/** UI message types published to the webview. */
export type UiMessage =
  | { type: "pairing-code"; code: string }
  | { type: "paired"; deviceName: string }
  | { type: "pairing-failed"; reason: "mismatch" | "rejected" | "timeout" };

/**
 * DesktopUiPort — implements UiPort for the desktop shell.
 *
 * All four methods delegate to the WebviewBridge:
 * - presentPairingCode / notifyPaired / notifyPairingFailed use publish()
 * - confirmPairing uses invoke() to drive the webview confirm dialog
 *
 * @param bridge — WebviewBridge instance (injected; enables unit testing)
 */
export class DesktopUiPort implements UiPort {
  constructor(private readonly bridge: UiBridge) {}

  async presentPairingCode(code: string): Promise<void> {
    await this.bridge.publish({ type: "pairing-code", code });
  }

  async confirmPairing(remoteName: string, code: string): Promise<boolean> {
    const result = await this.bridge.invoke("admin.pair.confirm", { remoteName, code });
    return result as boolean;
  }

  async notifyPaired(deviceName: string): Promise<void> {
    await this.bridge.publish({ type: "paired", deviceName });
  }

  async notifyPairingFailed(
    reason: "mismatch" | "rejected" | "timeout",
  ): Promise<void> {
    await this.bridge.publish({ type: "pairing-failed", reason });
  }
}
