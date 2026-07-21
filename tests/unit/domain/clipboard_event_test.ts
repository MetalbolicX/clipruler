/**
 * Unit tests for domain/clipboard-event.ts — ClipboardEvent shape and version comparison.
 * @std/assert required.
 *
 * compareVersions(a, b) total order:
 *   - counter first (higher counter → newer → greater)
 *   - tie-break: lexicographic deviceId on the branded string value
 *   - same exact Version → 0
 * Returns: -1 (a < b) | 0 (a == b) | 1 (a > b)
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import {
  type ClipboardEvent,
  compareVersions,
  makeDeviceId,
  type Version,
} from "../../../src/domain/clipboard-event.ts";

// ---------------------------------------------------------------------------
// compareVersions — counter primary
// ---------------------------------------------------------------------------

Deno.test("compareVersions: greater by counter returns 1", () => {
  const a: Version = { counter: 1, deviceId: makeDeviceId("device-a") };
  const b: Version = { counter: 0, deviceId: makeDeviceId("device-a") };
  assertEquals(compareVersions(a, b), 1);
});

Deno.test("compareVersions: less by counter returns -1", () => {
  const a: Version = { counter: 0, deviceId: makeDeviceId("device-a") };
  const b: Version = { counter: 1, deviceId: makeDeviceId("device-a") };
  assertEquals(compareVersions(a, b), -1);
});

// ---------------------------------------------------------------------------
// compareVersions — tie-break by lexicographic deviceId
// ---------------------------------------------------------------------------

Deno.test("compareVersions: same counter, tie-break by deviceId ascending", () => {
  // "device-a" < "device-b" lexicographically → a < b → -1
  const a: Version = { counter: 5, deviceId: makeDeviceId("device-a") };
  const b: Version = { counter: 5, deviceId: makeDeviceId("device-b") };
  assertEquals(compareVersions(a, b), -1);
});

Deno.test("compareVersions: same counter, tie-break deviceId descending", () => {
  // "device-z" > "device-a" → a > b → 1
  const a: Version = { counter: 5, deviceId: makeDeviceId("device-z") };
  const b: Version = { counter: 5, deviceId: makeDeviceId("device-a") };
  assertEquals(compareVersions(a, b), 1);
});

// ---------------------------------------------------------------------------
// compareVersions — exact equality
// ---------------------------------------------------------------------------

Deno.test("compareVersions: fully equal versions return 0", () => {
  const id = makeDeviceId("device-xyz");
  const a: Version = { counter: 42, deviceId: id };
  const b: Version = { counter: 42, deviceId: id };
  assertEquals(compareVersions(a, b), 0);
});

// ---------------------------------------------------------------------------
// ClipboardEvent shape
// ---------------------------------------------------------------------------

Deno.test("ClipboardEvent stores sourceDeviceId, counter, timestamp, and text", () => {
  const id = makeDeviceId("device-clip");
  const event: ClipboardEvent = {
    sourceDeviceId: id,
    counter: 7,
    timestamp: 1_700_000_000_000,
    text: "hello world",
  };
  assertEquals(event.sourceDeviceId, id);
  assertEquals(event.counter, 7);
  assertEquals(event.timestamp, 1_700_000_000_000);
  assertEquals(event.text, "hello world");
});
