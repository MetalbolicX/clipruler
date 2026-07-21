/**
 * Unit tests for infrastructure/clipboard/detector.ts.
 *
 * Verifies:
 * - detectBackend() returns windows-powershell on Windows hosts
 * - detectBackend() returns macos-pbcopy on Darwin hosts
 * - detectBackend() returns linux-wl when WAYLAND_DISPLAY is set on Linux
 * - detectBackend() returns linux-xclip when only DISPLAY is set on Linux
 * - detectBackend() prefers Wayland over X11 when both WAYLAND_DISPLAY and DISPLAY are set
 * - detectBackend() returns null on headless Linux (neither env var set)
 *
 * Layer: unit — all cases are pure function calls, no environment I/O.
 */
import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0";
import { detectBackend } from "../../../src/infrastructure/clipboard/detector.ts";

Deno.test("detectBackend: windows host returns windows-powershell", () => {
  const result = detectBackend({
    WAYLAND_DISPLAY: undefined,
    DISPLAY: undefined,
    os: "windows",
  });
  assertEquals(result.backend, "windows-powershell");
  assertEquals(result.reason, "Deno.build.os === 'windows'");
});

Deno.test("detectBackend: darwin host returns macos-pbcopy", () => {
  const result = detectBackend({
    WAYLAND_DISPLAY: undefined,
    DISPLAY: undefined,
    os: "darwin",
  });
  assertEquals(result.backend, "macos-pbcopy");
  assertEquals(result.reason, "Deno.build.os === 'darwin'");
});

Deno.test("detectBackend: linux with WAYLAND_DISPLAY returns linux-wl", () => {
  const result = detectBackend({
    WAYLAND_DISPLAY: "wayland-0",
    DISPLAY: undefined,
    os: "linux",
  });
  assertEquals(result.backend, "linux-wl");
  assertEquals(result.reason, "WAYLAND_DISPLAY=wayland-0");
});

Deno.test("detectBackend: linux with only DISPLAY returns linux-xclip", () => {
  const result = detectBackend({
    WAYLAND_DISPLAY: undefined,
    DISPLAY: ":0",
    os: "linux",
  });
  assertEquals(result.backend, "linux-xclip");
  assertEquals(result.reason, "DISPLAY=:0");
});

Deno.test("detectBackend: linux with both WAYLAND_DISPLAY and DISPLAY prefers wayland", () => {
  const result = detectBackend({
    WAYLAND_DISPLAY: "wayland-0",
    DISPLAY: ":0",
    os: "linux",
  });
  // Wayland takes precedence over X11
  assertEquals(result.backend, "linux-wl");
  assertEquals(result.reason, "WAYLAND_DISPLAY=wayland-0");
});

Deno.test("detectBackend: headless linux returns null", () => {
  const result = detectBackend({
    WAYLAND_DISPLAY: undefined,
    DISPLAY: undefined,
    os: "linux",
  });
  assertStrictEquals(result.backend, "null");
  assertEquals(result.reason, "no WAYLAND_DISPLAY or DISPLAY on a non-Windows/darwin host");
});
