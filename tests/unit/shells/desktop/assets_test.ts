/**
 * Unit tests for assets/desktop/index.html and main.js
 *
 * Verifies the single-page invariant (Design #2534, DWB-2.2):
 * - main.js does NOT use location.reload(, location.href =, or navigate(
 * - index.html does NOT load external CDN scripts
 * - main.js DOES call window.__clipruler.invoke for all rendering
 * - main.js DOES clear window.__clipruler on beforeunload (bindings loss trap)
 *
 * Layer: unit — reads raw file content, no network access.
 */

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0";
import { resolve } from "@std/path";

const ASSETS_DIR = resolve(String(import.meta.dirname), "../../../../assets/desktop");
const INDEX_HTML = await Deno.readTextFile(resolve(ASSETS_DIR, "index.html"));
const MAIN_JS = await Deno.readTextFile(resolve(ASSETS_DIR, "main.js"));

Deno.test("assets: main.js does NOT call location.reload(", () => {
  // location.reload() loses bindings — forbidden after startup
  const reloadPattern = /location\.reload\s*\(/;
  assertEquals(
    reloadPattern.test(MAIN_JS),
    false,
    `main.js must not call location.reload() — bindings are lost after reload`,
  );
});

Deno.test("assets: main.js does NOT assign location.href", () => {
  // location.href = ... navigates and loses bindings — forbidden
  const assignmentPattern = /location\.href\s*=\s*[^=]/;
  assertEquals(
    assignmentPattern.test(MAIN_JS),
    false,
    `main.js must not assign location.href — use hash navigation instead`,
  );
});

Deno.test("assets: main.js does NOT call navigate(", () => {
  // Any navigate(...) call is forbidden — the facade does not expose a navigate API
  const navigatePattern = /\bnavigate\s*\(/;
  assertEquals(
    navigatePattern.test(MAIN_JS),
    false,
    `main.js must not call navigate(...) — use hash routing instead`,
  );
});

Deno.test("assets: index.html does NOT load external CDN scripts", () => {
  // Allow http:// and // for other purposes, but <script src="http or // is forbidden
  const cdnPattern = /<script\s+src=["']https?:\/\//;
  const protocollessPattern = /<script\s+src=["']?\/\//;
  assertEquals(
    cdnPattern.test(INDEX_HTML),
    false,
    `index.html must not load external CDN scripts`,
  );
  assertEquals(
    protocollessPattern.test(INDEX_HTML),
    false,
    `index.html must not use protocol-relative script URLs`,
  );
});

Deno.test("assets: main.js DOES use globalThis.__clipruler.invoke", () => {
  assertStringIncludes(
    MAIN_JS,
    "__clipruler.invoke",
    `main.js must call __clipruler.invoke for all daemon communication`,
  );
});

Deno.test("assets: main.js DOES clear globalThis.__clipruler on beforeunload", () => {
  // The bindings loss trap requires re-registering on reload; clearing the
  // reference on beforeunload lets the facade re-register cleanly.
  assertStringIncludes(
    MAIN_JS,
    "beforeunload",
    `main.js must handle beforeunload to clear the bindings reference`,
  );
  // The specific clearing: globalThis.__clipruler = undefined
  const clearPattern = /globalThis\.__clipruler\s*=\s*undefined/;
  assertEquals(
    clearPattern.test(MAIN_JS),
    true,
    `main.js must set globalThis.__clipruler = undefined on beforeunload`,
  );
});

Deno.test("assets: main.js uses hash-only routing", () => {
  // Must use location.hash for routing (no location.pathname or location.search)
  assertStringIncludes(
    MAIN_JS,
    "location.hash",
    `main.js must use location.hash for routing`,
  );
});

Deno.test("assets: index.html references main.js", () => {
  assertStringIncludes(
    INDEX_HTML,
    "./main.js",
    `index.html must load main.js via a relative script tag`,
  );
});
