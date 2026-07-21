/**
 * tests/unit/infrastructure/clock/persistent_clock_test.ts
 *
 * Unit tests for infrastructure/clock/persistent-clock.ts.
 *
 * Verifies:
 * - Clock initialises with the given clockCounter and deviceId
 * - tick() increments counter and calls sink with the new value
 * - observe(remote) advances to max(local, remote) and calls sink only on advancement
 * - observe(remote) where remote <= local does NOT call sink (no-op)
 *
 * Layer: unit — pure clock logic, no mocks or network needed.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type { DeviceId } from "../../../../src/domain/device.ts";
import { makeDeviceId } from "../../../../src/domain/device.ts";
import type { Logger } from "../../../../src/ports/logger.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDeviceIdForTest(entropy: string): DeviceId {
  return makeDeviceId(entropy);
}

/**
 * Creates a spy sink that records every value passed to it.
 * Returns { sink, calledWith } where sink is ClockSink-compatible.
 */
function makeSpySink(): { sink: (value: number) => void; calledWith: number[] } {
  const calledWith: number[] = [];
  const sink = (value: number): void => {
    calledWith.push(value);
  };
  return { sink, calledWith };
}

class StubLoggerForTest implements Logger {
  debug(_msg: string, _meta?: Record<string, unknown>): void {}
  info(_msg: string, _meta?: Record<string, unknown>): void {}
  warn(_msg: string, _meta?: Record<string, unknown>): void {}
  error(_msg: string, _meta?: Record<string, unknown>): void {}
  child(_scope: string): Logger {
    return this;
  }
}

// ---------------------------------------------------------------------------
// Tests: initial state
// ---------------------------------------------------------------------------

Deno.test("PersistentClock initialises with the given clockCounter", async () => {
  const { PersistentClock } = await import(
    "../../../../src/infrastructure/clock/persistent-clock.ts"
  );
  const deviceId = makeDeviceIdForTest("dev-alpha");
  const { sink, calledWith } = makeSpySink();
  const logger = new StubLoggerForTest();

  const clock = new PersistentClock(deviceId, 42, sink, logger);
  // Sink not called yet
  assertEquals(calledWith, []);
  // First tick from 42 -> 43
  assertEquals(await clock.tick(), 43);
});

Deno.test("PersistentClock exposes the bound deviceId", async () => {
  const { PersistentClock } = await import(
    "../../../../src/infrastructure/clock/persistent-clock.ts"
  );
  const deviceId = makeDeviceIdForTest("dev-beta");
  const { sink, calledWith } = makeSpySink();
  const logger = new StubLoggerForTest();

  const clock = new PersistentClock(deviceId, 0, sink, logger);
  assertEquals(clock.deviceId, deviceId);
  // No sink calls yet
  assertEquals(calledWith, []);
});

// ---------------------------------------------------------------------------
// Tests: tick()
// ---------------------------------------------------------------------------

Deno.test("tick() increments counter and calls sink with next value", async () => {
  const { PersistentClock } = await import(
    "../../../../src/infrastructure/clock/persistent-clock.ts"
  );
  const deviceId = makeDeviceIdForTest("dev-gamma");
  const { sink, calledWith } = makeSpySink();
  const logger = new StubLoggerForTest();

  const clock = new PersistentClock(deviceId, 5, sink, logger);

  const result = await clock.tick();

  // Counter advanced
  assertEquals(result, 6);
  // Sink called with 6
  assertEquals(calledWith, [6]);
});

Deno.test("tick() called twice produces sequential values and sinks each", async () => {
  const { PersistentClock } = await import(
    "../../../../src/infrastructure/clock/persistent-clock.ts"
  );
  const deviceId = makeDeviceIdForTest("dev-delta");
  const { sink, calledWith } = makeSpySink();
  const logger = new StubLoggerForTest();

  const clock = new PersistentClock(deviceId, 0, sink, logger);

  await clock.tick();
  await clock.tick();

  assertEquals(calledWith, [1, 2]);
});

// ---------------------------------------------------------------------------
// Tests: observe()
// ---------------------------------------------------------------------------

Deno.test("observe(remote) advances to max(local, remote) and sinks on advancement", async () => {
  const { PersistentClock } = await import(
    "../../../../src/infrastructure/clock/persistent-clock.ts"
  );
  const deviceId = makeDeviceIdForTest("dev-epsilon");
  const { sink, calledWith } = makeSpySink();
  const logger = new StubLoggerForTest();

  // Start at counter 3
  const clock = new PersistentClock(deviceId, 3, sink, logger);

  // Remote is 7 — local should advance to 7
  await clock.observe(7);

  // tick() after observe should return 8
  const next = await clock.tick();
  assertEquals(next, 8);
  // Sink was called with 7 (observe) and 8 (tick)
  assertEquals(calledWith, [7, 8]);
});

Deno.test("observe(remote) where remote <= local is a no-op and does not call sink", async () => {
  const { PersistentClock } = await import(
    "../../../../src/infrastructure/clock/persistent-clock.ts"
  );
  const deviceId = makeDeviceIdForTest("dev-zeta");
  const { sink, calledWith } = makeSpySink();
  const logger = new StubLoggerForTest();

  // Start at counter 9
  const clock = new PersistentClock(deviceId, 9, sink, logger);

  // Remote is 4 — less than local, should be ignored
  await clock.observe(4);

  // tick() should still return 10 (no advancement from observe)
  const next = await clock.tick();
  assertEquals(next, 10);
  // Sink called only once: for tick() returning 10. NOT for observe.
  assertEquals(calledWith, [10]);
});

Deno.test("observe(remote) where remote equals local is a no-op", async () => {
  const { PersistentClock } = await import(
    "../../../../src/infrastructure/clock/persistent-clock.ts"
  );
  const deviceId = makeDeviceIdForTest("dev-eta");
  const { sink, calledWith } = makeSpySink();
  const logger = new StubLoggerForTest();

  // Start at counter 7
  const clock = new PersistentClock(deviceId, 7, sink, logger);

  // Remote equals local — no advancement
  await clock.observe(7);

  // tick() should return 8
  const next = await clock.tick();
  assertEquals(next, 8);
  // Sink called only for tick()
  assertEquals(calledWith, [8]);
});

Deno.test("observe(remote) with larger remote is idempotent", async () => {
  const { PersistentClock } = await import(
    "../../../../src/infrastructure/clock/persistent-clock.ts"
  );
  const deviceId = makeDeviceIdForTest("dev-theta");
  const { sink, calledWith } = makeSpySink();
  const logger = new StubLoggerForTest();

  const clock = new PersistentClock(deviceId, 1, sink, logger);

  // Advance to 10
  await clock.observe(10);
  // Advance again to 10 (same) — should be no-op
  await clock.observe(10);

  // tick() should return 11
  const next = await clock.tick();
  assertEquals(next, 11);
  // Sink: [10] from first observe, [11] from tick — second observe is no-op
  assertEquals(calledWith, [10, 11]);
});
