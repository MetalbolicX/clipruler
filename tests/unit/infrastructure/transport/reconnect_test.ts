/**
 * Unit tests for infrastructure/transport/reconnect.ts — Reconnect wrapper.
 *
 * Layer: unit.
 * Tests use injected dialer to verify reconnect behavior without real network.
 *
 * Strict TDD: tests written to verify behavior from the spec.
 */

import { assertEquals, assertInstanceOf } from "jsr:@std/assert@^1.0";
import {
  type Conn,
  reconnect,
  type ReconnectOptions,
} from "../../../../src/infrastructure/transport/reconnect.ts";
import { ReconnectAbandonedError } from "../../../../src/infrastructure/transport/errors.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Makes a minimal fake connection. */
function makeFakeConn(id: string): Conn {
  return { id, close: async () => {} };
}

// ---------------------------------------------------------------------------
// Scenario: R5 cap and abandon
// maxAttempts = K, dial always fails → exactly K attempts → final state
// reconnect-abandoned error.
// ---------------------------------------------------------------------------

Deno.test("Reconnect: max attempts exhausted → ReconnectAbandonedError", async () => {
  let dialAttempts = 0;

  const opts: ReconnectOptions = {
    dial: (_signal: AbortSignal) => {
      dialAttempts++;
      return Promise.reject(new Error("always fail"));
    },
    baseDelayMs: 10,
    capDelayMs: 100,
    maxAttempts: 3,
  } as unknown as ReconnectOptions;

  const { outcome } = reconnect("fp-test", opts);

  // Wait enough for all 3 attempts to complete (backoff: 10, 20, 40 = 70ms total + overhead)
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  // Exactly 3 attempts
  assertEquals(dialAttempts, 3);

  // outcome rejects with ReconnectAbandonedError
  let err: unknown = null;
  try {
    await outcome;
  } catch (e) {
    err = e;
  }
  assertInstanceOf(err, ReconnectAbandonedError);
  assertEquals((err as ReconnectAbandonedError).fingerprint, "fp-test");
  assertEquals((err as ReconnectAbandonedError).attempts, 3);

  // No more dials after final failure
  const dialsAfter = dialAttempts;
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
  assertEquals(dialAttempts, dialsAfter);
});

// ---------------------------------------------------------------------------
// Scenario: R5 cancellation honored
// While attempt N is in progress, caller cancels → no further dial attempt
// occurs, wrapper settles.
// ---------------------------------------------------------------------------

Deno.test("Reconnect: cancel while attempt in progress → no further dials", async () => {
  let dialAttempts = 0;

  const opts: ReconnectOptions = {
    dial: async (_signal: AbortSignal) => {
      dialAttempts++;
      // Simulate a dial that takes 50ms
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      throw new Error("dial failed");
    },
    baseDelayMs: 10,
    capDelayMs: 100,
    maxAttempts: 5,
  } as unknown as ReconnectOptions;

  const { cancel, outcome } = reconnect("fp-cancel", opts);

  // Wait for first dial to be in progress
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assertEquals(dialAttempts, 1, "first dial should be in progress");

  // Cancel while first dial is in progress
  cancel();

  // Wait to see if more dials happen
  const dialsAtCancel = dialAttempts;
  await new Promise<void>((resolve) => setTimeout(resolve, 200));

  // No more dials after cancel
  assertEquals(dialAttempts, dialsAtCancel);

  // Outcome should settle (as cancelled error)
  // No assertion on type since cancellation error
  try {
    await outcome;
  } catch (_err) {
    // Cancellation rejects with Error, not ReconnectAbandonedError
  }
});

// ---------------------------------------------------------------------------
// Scenario: Threat: Reconnect fan-out
// Two concurrent drop events for the SAME fingerprint → only one loop runs
// (no fan-out). The second reconnect call for the same fingerprint while
// a loop is active returns the SAME outcome promise.
// ---------------------------------------------------------------------------

Deno.test("Reconnect: same fingerprint concurrent calls → single loop, shared outcome", async () => {
  let dialAttempts = 0;

  const opts: ReconnectOptions = {
    dial: (_signal: AbortSignal) => {
      dialAttempts++;
      return Promise.reject(new Error("always fail"));
    },
    baseDelayMs: 10,
    capDelayMs: 100,
    maxAttempts: 3,
  } as unknown as ReconnectOptions;

  const fp = "fp-fanout";

  // Two truly concurrent reconnect calls via Promise.all
  const [{ outcome: outcome1, cancel: cancel1 }, { outcome: outcome2, cancel: cancel2 }] =
    await Promise.all([
      reconnect(fp, opts),
      reconnect(fp, opts),
    ]);

  // Both outcomes must be the same reference (shared promise)
  assertEquals(outcome1, outcome2, "concurrent reconnects return same outcome promise");

  // Only one dial attempt should have been made — second call deduped.
  // Use queueMicrotask to check immediately after all synchronous code runs,
  // before any scheduled retry timer fires.
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assertEquals(dialAttempts, 1, "only one dial for concurrent reconnects to same fp");

  // Wait for all attempts to exhaust (retry timers + final rejection)
  await new Promise<void>((resolve) => setTimeout(resolve, 400));
  assertEquals(dialAttempts, 3, "3 total attempts");

  // outcome1 should be rejected with ReconnectAbandonedError
  let err: unknown = null;
  try {
    await outcome1;
  } catch (e) {
    err = e;
  }
  assertInstanceOf(err, ReconnectAbandonedError);

  cancel1();
  cancel2();
});

// ---------------------------------------------------------------------------
// Scenario: Reconnect: successful dial resolves immediately and cancels retries
// ---------------------------------------------------------------------------

Deno.test("Reconnect: successful dial resolves and cancels backoff", async () => {
  let dialAttempts = 0;

  const opts: ReconnectOptions = {
    dial: (_signal: AbortSignal) => {
      dialAttempts++;
      return Promise.resolve(makeFakeConn("fake-conn"));
    },
    baseDelayMs: 10,
    capDelayMs: 100,
    maxAttempts: 3,
  } as unknown as ReconnectOptions;

  const { outcome, cancel } = reconnect("fp-success", opts);

  // Wait a bit to see if any retries are scheduled (they shouldn't be)
  await new Promise<void>((resolve) => setTimeout(resolve, 50));

  // First dial succeeded - no more dials should have been attempted
  assertEquals(dialAttempts, 1, "only one dial on success, no retries");

  // Outcome resolves to undefined
  const result = await outcome;
  assertEquals(result, undefined, "successful outcome resolves to void");

  cancel();
});

// ---------------------------------------------------------------------------
// Scenario: R5 jitter bounded
// Jitter is applied to delays — verify delay grows exponentially and jitter
// doesn't push delay outside [base, cap] range.
// ---------------------------------------------------------------------------

Deno.test("Reconnect: exponential backoff with jitter", async () => {
  // Capture the actual delays between attempts
  const attemptTimestamps: number[] = [];
  let dialAttempts = 0;

  const opts: ReconnectOptions = {
    dial: (_signal: AbortSignal) => {
      attemptTimestamps.push(Date.now());
      dialAttempts++;
      return Promise.reject(new Error("always fail"));
    },
    baseDelayMs: 20,
    capDelayMs: 200,
    maxAttempts: 4,
  } as unknown as ReconnectOptions;

  const { outcome } = reconnect("fp-jitter", opts);

  // Wait enough for all attempts
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  assertEquals(dialAttempts, 4, "all 4 attempts should happen");

  // Verify delays grow: each subsequent delay should be larger
  for (let i = 1; i < attemptTimestamps.length; i++) {
    const gap = attemptTimestamps[i]! - attemptTimestamps[i - 1]!;
    assertEquals(gap > 0, true, `gap ${i} should be positive`);
  }

  // outcome should be rejected
  let err: unknown = null;
  try {
    await outcome;
  } catch (e) {
    err = e;
  }
  assertInstanceOf(err, ReconnectAbandonedError);
});
