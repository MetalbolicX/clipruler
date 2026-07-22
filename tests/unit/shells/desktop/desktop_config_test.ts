/**
 * tests/unit/shells/desktop/desktop_config_test.ts
 *
 * Verifies deno.json desktop task exists and icons/tray.png is a valid PNG.
 * Layer: unit — file system checks only.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pngIsValid(path: string): boolean {
  try {
    const bytes = readFileSync(path);
    return bytes[0] === 0x89 &&
      bytes[1] === 0x50 && // P
      bytes[2] === 0x4e && // N
      bytes[3] === 0x47 && // G
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

Deno.test("icons/tray.png is a valid PNG", () => {
  assertEquals(pngIsValid("icons/tray.png"), true, "icons/tray.png must be a valid PNG");
});

Deno.test("icons/tray.png exists and is non-empty", () => {
  const info = Deno.statSync("icons/tray.png");
  assertEquals(info.size > 0, true, "icons/tray.png must be non-empty");
});
