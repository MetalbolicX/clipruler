/**
 * shells/desktop/mod.ts
 *
 * Desktop shell entry point — plan 011 slice 4.
 *
 * Design (Plan 011, Design #2534):
 * - desktopMain is testable; does NOT call Deno.exit().
 * - Returns exit code: 0 success, 1 headless/error, 2 usage.
 * - Wires WebviewBridge + DesktopUiPort into buildAndRunDaemon.
 */

import { resolveAppPaths } from "../../infrastructure/persistence/app-paths.ts";
import { buildAndRunDaemon } from "../composition-root.ts";
import { WebviewBridge } from "./webview-bridge.ts";
import { DesktopUiPort } from "./desktop-ui-port.ts";
import { adminCommand } from "../cli/admin-client.ts";
import { headlessGuard } from "./headless-guard.ts";
import type { AdminEndpoint } from "../cli/admin-client.ts";
import type { EnvelopeKind } from "../../protocol/envelope.ts";


/**
 * Adapter: converts AdminCommandFn signature (method + params)
 * to adminCommand signature (EnvelopeKind + payload).
 *
 * The webview bridge uses string method names (e.g., "admin.pair.confirm"),
 * but the admin channel uses typed EnvelopeKind. This adapter bridges the two.
 */
function wrapAdminCommand(
  endpoint: AdminEndpoint,
  method: string,
  // deno-lint-ignore no-explicit-any
  params?: any, // params type depends on the method; use any for flexibility
): Promise<unknown> {
  // Cast method to EnvelopeKind — this is safe because the webview only
  // invokes known admin methods (pair.confirm, pair.cancel, etc.)
  return adminCommand(endpoint, method as EnvelopeKind, params);
}

const HELP = `Usage: clipruler desktop [options]
  --help, -h    Show this help
`;

/**
 * Desktop shell entry point.
 *
 * Wires the desktop composition:
 * 1. headlessGuard — verify display is available
 * 2. build WebviewBridge with adminCommand
 * 3. build DesktopUiPort with bridge
 * 4. pass UiPort to buildAndRunDaemon
 *
 * Returns:
 *   0 — success (display available, desktop shell started)
 *   1 — headless guard refused (no display server)
 *   2 — usage error
 */
export async function desktopMain(args: string[]): Promise<number> {
  // Handle --help / -h first
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  // Empty args → usage error (exit 2)
  if (args.length === 0) {
    console.error("Usage: clipruler desktop [options]\n  --help, -h    Show this help");
    return 2;
  }

  // Headless guard check
  const guard = headlessGuard();
  if (!guard.ok) {
    console.error(guard.reason);
    return 1;
  }

  // Resolve app paths
  const paths = resolveAppPaths();

  // Determine device name
  const deviceName = Deno.env.get("CLIPRULER_DEVICE_NAME") ?? Deno.hostname();

  // Build the desktop composition
  let uiPort: import("../../ports/ui.ts").UiPort;

  if (Deno.build.os === "windows") {
    // Windows: stub UiPort (full Windows desktop support is a follow-up)
    uiPort = {
      presentPairingCode: () => Promise.resolve(),
      confirmPairing: () => Promise.resolve(false),
      notifyPaired: () => Promise.resolve(),
      notifyPairingFailed: () => Promise.resolve(),
    };
  } else {
    // POSIX: Unix socket path is predictable — ${dataDir}/admin.sock
    const adminSockPath = `${paths.dataDir}/admin.sock`;
    const endpoint: AdminEndpoint = { kind: "unix", path: adminSockPath };

    // Create a placeholder webview for the bridge (webview lifecycle is TBD)
    const { Webview: WebviewImpl } = await import("./webview.ts");
    const placeholderWebview = new WebviewImpl("about:blank");

    const bridge = new WebviewBridge(placeholderWebview, {
      endpoint,
      adminCommand: wrapAdminCommand,
    });
    uiPort = new DesktopUiPort(bridge);
  }

  // Start the daemon with the desktop UiPort
  const daemon = await buildAndRunDaemon({ deviceName, uiPort });

  // Keep process alive — wait for shutdown signal.
  // The daemon's stop() is called on SIGINT/SIGTERM.
  await daemon.stop();

  return 0;
}
