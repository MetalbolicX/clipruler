/**
 * shells/desktop/mod.ts
 *
 * Desktop shell entry point — plan 011 slice 1.
 *
 * Design (Plan 011, Design #2534):
 * - desktopMain is testable; does NOT call Deno.exit().
 * - Returns exit code: 0 success, 1 headless/error, 2 usage.
 * - For Slice 1: calls headlessGuard(), returns appropriate exit code,
 *   prints usage for --help/-h/empty args.
 */

import { headlessGuard } from "./headless-guard.ts";

const HELP = `Usage: clipruler desktop [options]
  --help, -h    Show this help
`;

/**
 * Desktop shell entry point.
 *
 * Returns:
 *   0 — success (display available, skeleton started)
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

  // Slice 1 skeleton: just return 0 (daemon + tray come in later slices)
  return 0;
}
