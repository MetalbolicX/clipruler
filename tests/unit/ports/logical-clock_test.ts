/**
 * Unit tests for ports/logical-clock.ts — interface-shape smoke tests.
 * Verifies the LogicalClock interface contract surface is reachable.
 * Layer: unit.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type { LogicalClock } from "../../../src/ports/logical-clock.ts";
import { makeDeviceId } from "../../../src/domain/device.ts";

/**
 * Scenario: LogicalClock interface has tick, observe, and deviceId.
 */
Deno.test("LogicalClock interface: tick and observe are callable, deviceId is readable", () => {
  const mock: LogicalClock = {
    tick(): Promise<number> {
      return Promise.resolve(0);
    },
    observe(_remote: number): Promise<void> {
      return Promise.resolve();
    },
    deviceId: makeDeviceId("dev-clock"),
  };
  assertEquals(typeof mock.tick, "function");
  assertEquals(typeof mock.observe, "function");
  assertEquals(typeof mock.deviceId, "string"); // branded string
});

/**
 * Scenario: tick() returns a number (LogicalCounter per Plan 002).
 */
Deno.test("tick() returns a number counter", async () => {
  let counter = 0;
  const mock: LogicalClock = {
    tick(): Promise<number> {
      return Promise.resolve(++counter);
    },
    observe(_remote: number): Promise<void> {
      return Promise.resolve();
    },
    deviceId: makeDeviceId("dev-001"),
  };
  const result = await mock.tick();
  assertEquals(typeof result, "number");
  assertEquals(result, 1);
});

/**
 * Scenario: tick() is monotonic — successive calls return increasing values.
 */
Deno.test("tick() is monotonic: successive calls increase", async () => {
  let counter = 0;
  const mock: LogicalClock = {
    tick(): Promise<number> {
      return Promise.resolve(++counter);
    },
    observe(_remote: number): Promise<void> {
      return Promise.resolve();
    },
    deviceId: makeDeviceId("dev-001"),
  };
  const first = await mock.tick();
  const second = await mock.tick();
  const third = await mock.tick();
  assertEquals(second > first, true);
  assertEquals(third > second, true);
});

/**
 * Scenario: observe() accepts a LogicalCounter and returns void.
 */
Deno.test("observe() accepts a counter and returns void", async () => {
  const mock: LogicalClock = {
    tick(): Promise<number> {
      return Promise.resolve(1);
    },
    observe(_remote: number): Promise<void> {
      return Promise.resolve();
    },
    deviceId: makeDeviceId("dev-001"),
  };
  const result = await mock.observe(5);
  assertEquals(result, undefined);
});

/**
 * Scenario: deviceId is a DeviceId branded string.
 */
Deno.test("deviceId is a DeviceId branded string", () => {
  const id = makeDeviceId("clock-device-001");
  const mock: LogicalClock = {
    tick(): Promise<number> {
      return Promise.resolve(0);
    },
    observe(_remote: number): Promise<void> {
      return Promise.resolve();
    },
    deviceId: id,
  };
  assertEquals(mock.deviceId, id);
});
