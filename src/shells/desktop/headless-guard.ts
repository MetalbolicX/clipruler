/**
 * shells/desktop/headless-guard.ts
 *
 * Headless environment guard for the desktop shell.
 *
 * Design (Plan 011, Design #2534):
 * - On Linux: check WAYLAND_DISPLAY and DISPLAY env vars.
 *   Precedence: trimmed nonblank WAYLAND_DISPLAY → trimmed nonblank DISPLAY → fail.
 * - On non-Linux (darwin/windows): always ok (no display env check needed).
 * - Failure reason: "No display server found. Use 'clipruler daemon' + 'clipruler list' instead."
 *
 * The `getBuildOs` parameter enables unit testing without cross-compiling.
 */

const HEADLESS_REASON =
  "No display server found. Use 'clipruler daemon' + 'clipruler list' instead.";

function readEnv(key: string): string | undefined {
  return Deno.env.get(key);
}

function isNonBlank(s: string | undefined): boolean {
  return s !== undefined && s.trim() !== "";
}

/**
 * Check whether the current environment has a display server available.
 *
 * Returns:
 *   { ok: true }  — display is available (or non-Linux platform)
 *   { ok: false, reason: string } — no display server found
 */
export function headlessGuard(
  getBuildOs: () => string = () => Deno.build.os,
): { ok: boolean; reason?: string } {
  const os = getBuildOs();

  // Non-Linux platforms are always fine — desktop environments are expected.
  if (os !== "linux") {
    return { ok: true };
  }

  // Linux: check WAYLAND_DISPLAY first, then DISPLAY.
  const wayland = readEnv("WAYLAND_DISPLAY");
  if (isNonBlank(wayland)) {
    return { ok: true };
  }

  const display = readEnv("DISPLAY");
  if (isNonBlank(display)) {
    return { ok: true };
  }

  return { ok: false, reason: HEADLESS_REASON };
}
