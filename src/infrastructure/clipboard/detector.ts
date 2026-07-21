/**
 * infrastructure/clipboard/detector.ts
 *
 * Pure backend detector for clipboard access.
 * detectBackend(env) is a pure function over WAYLAND_DISPLAY, DISPLAY, and os.
 * detectFromEnv() is the production entry point that reads Deno.env and Deno.build.os.
 *
 * Detection priority:
 *   Windows → Darwin → Wayland → X11 → null
 *
 * Wayland takes precedence over X11 when both WAYLAND_DISPLAY and DISPLAY are set
 * (modern Wayland distros often set DISPLAY for X11 compat layers).
 */

export type DetectedBackend =
  | "windows-powershell"
  | "linux-wl"
  | "linux-xclip"
  | "macos-pbcopy"
  | "null";

export interface DetectionResult {
  readonly backend: DetectedBackend;
  readonly reason: string;
}

/**
 * Pure backend detection over an explicit environment snapshot.
 * All inputs are explicit — this function is fully unit-testable without env I/O.
 *
 * Note: env.WAYLAND_DISPLAY and env.DISPLAY are typed as `string | undefined`
 * (not the `?` absent-only form) so that detectFromEnv can pass Deno.env.get()
 * results directly without casting, while satisfying exactOptionalPropertyTypes.
 */
export function detectBackend(env: {
  WAYLAND_DISPLAY?: string | undefined;
  DISPLAY?: string | undefined;
  os: typeof Deno.build.os;
}): DetectionResult {
  if (env.os === "windows") {
    return { backend: "windows-powershell", reason: "Deno.build.os === 'windows'" };
  }

  if (env.os === "darwin") {
    return { backend: "macos-pbcopy", reason: "Deno.build.os === 'darwin'" };
  }

  // linux (or any non-Windows/non-Darwin host)
  if (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY.trim() !== "") {
    return {
      backend: "linux-wl",
      reason: `WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY.trim()}`,
    };
  }

  if (env.DISPLAY !== undefined && env.DISPLAY.trim() !== "") {
    return {
      backend: "linux-xclip",
      reason: `DISPLAY=${env.DISPLAY.trim()}`,
    };
  }

  return {
    backend: "null",
    reason: "no WAYLAND_DISPLAY or DISPLAY on a non-Windows/darwin host",
  };
}

/**
 * Production entry point — reads real environment from Deno.env.
 * Wraps detectBackend so the pure function remains testable.
 */
export function detectFromEnv(): DetectionResult {
  return detectBackend({
    WAYLAND_DISPLAY: Deno.env.get("WAYLAND_DISPLAY"),
    DISPLAY: Deno.env.get("DISPLAY"),
    os: Deno.build.os,
  });
}
