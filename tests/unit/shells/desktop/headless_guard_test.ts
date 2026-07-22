/**
 * Unit tests for shells/desktop/headless-guard.ts
 *
 * Verifies headlessGuard() exit-code semantics:
 * - Linux + WAYLAND_DISPLAY set → ok
 * - Linux + DISPLAY set (no WAYLAND_DISPLAY) → ok
 * - Linux + neither set → not ok with reason
 * - Non-Linux (darwin/windows) → ok regardless of env
 *
 * Layer: unit — uses the getBuildOs seam to avoid cross-compilation.
 */

import { assertEquals, assertObjectMatch } from "jsr:@std/assert@^1.0";
import { headlessGuard } from "../../../../src/shells/desktop/headless-guard.ts";

Deno.test("headlessGuard: WAYLAND_DISPLAY set on Linux → ok", () => {
  Deno.env.set("WAYLAND_DISPLAY", "wayland-0");
  Deno.env.delete("DISPLAY");
  try {
    const result = headlessGuard(() => "linux");
    assertObjectMatch(result, { ok: true });
  } finally {
    Deno.env.delete("WAYLAND_DISPLAY");
  }
});

Deno.test("headlessGuard: DISPLAY set (no WAYLAND_DISPLAY) on Linux → ok", () => {
  Deno.env.delete("WAYLAND_DISPLAY");
  Deno.env.set("DISPLAY", ":0");
  try {
    const result = headlessGuard(() => "linux");
    assertObjectMatch(result, { ok: true });
  } finally {
    Deno.env.delete("DISPLAY");
  }
});

Deno.test("headlessGuard: WAYLAND_DISPLAY set with whitespace → ok (trimmed)", () => {
  Deno.env.set("WAYLAND_DISPLAY", "  wayland-0  ");
  Deno.env.delete("DISPLAY");
  try {
    const result = headlessGuard(() => "linux");
    assertObjectMatch(result, { ok: true });
  } finally {
    Deno.env.delete("WAYLAND_DISPLAY");
  }
});

Deno.test("headlessGuard: DISPLAY set but empty string → not ok (blank)", () => {
  Deno.env.delete("WAYLAND_DISPLAY");
  Deno.env.set("DISPLAY", "   ");
  try {
    const result = headlessGuard(() => "linux");
    assertObjectMatch(result, { ok: false });
    assertEquals(result.reason?.includes("display server"), true);
  } finally {
    Deno.env.delete("DISPLAY");
  }
});

Deno.test("headlessGuard: neither env var on Linux → not ok with reason", () => {
  Deno.env.delete("WAYLAND_DISPLAY");
  Deno.env.delete("DISPLAY");
  const result = headlessGuard(() => "linux");
  assertObjectMatch(result, { ok: false });
  assertEquals(
    result.reason,
    "No display server found. Use 'clipruler daemon' + 'clipruler list' instead.",
  );
});

Deno.test("headlessGuard: darwin → ok regardless of env", () => {
  Deno.env.delete("WAYLAND_DISPLAY");
  Deno.env.delete("DISPLAY");
  const result = headlessGuard(() => "darwin");
  assertObjectMatch(result, { ok: true });
});

Deno.test("headlessGuard: windows → ok regardless of env", () => {
  Deno.env.delete("WAYLAND_DISPLAY");
  Deno.env.delete("DISPLAY");
  const result = headlessGuard(() => "windows");
  assertObjectMatch(result, { ok: true });
});

Deno.test("headlessGuard: linux + both vars set → WAYLAND_DISPLAY wins", () => {
  Deno.env.set("WAYLAND_DISPLAY", "wayland-0");
  Deno.env.set("DISPLAY", ":0");
  try {
    const result = headlessGuard(() => "linux");
    assertObjectMatch(result, { ok: true });
  } finally {
    Deno.env.delete("WAYLAND_DISPLAY");
    Deno.env.delete("DISPLAY");
  }
});

Deno.test("headlessGuard: freebsd → ok regardless of env", () => {
  Deno.env.delete("WAYLAND_DISPLAY");
  Deno.env.delete("DISPLAY");
  const result = headlessGuard(() => "freebsd");
  assertObjectMatch(result, { ok: true });
});
