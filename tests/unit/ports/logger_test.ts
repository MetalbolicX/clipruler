/**
 * Unit tests for ports/logger.ts — interface-shape smoke tests.
 * Verifies the Logger interface contract surface is reachable.
 * Layer: unit.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type { Logger, LogLevel } from "../../../src/ports/logger.ts";

/**
 * Scenario: Logger interface has all required method signatures.
 * Each method is callable with the correct parameter types.
 */
Deno.test("Logger interface: debug method callable with string and optional meta", () => {
  const mock: Logger = {
    debug(_msg: string, _meta?: Record<string, unknown>): void {},
    info(_msg: string, _meta?: Record<string, unknown>): void {},
    warn(_msg: string, _meta?: Record<string, unknown>): void {},
    error(_msg: string, _meta?: Record<string, unknown>): void {},
    child(_scope: string): Logger {
      return this;
    },
  };
  // Verify the mock object satisfies the Logger interface
  assertEquals(typeof mock.debug, "function");
  assertEquals(typeof mock.info, "function");
  assertEquals(typeof mock.warn, "function");
  assertEquals(typeof mock.error, "function");
  assertEquals(typeof mock.child, "function");
});

/**
 * Scenario: LogLevel is a union of the four expected string literals.
 */
Deno.test("LogLevel is the expected four-value union", () => {
  const levels: LogLevel[] = ["debug", "info", "warn", "error"];
  assertEquals(levels.length, 4);
});

/**
 * Scenario: meta parameter is truly optional — calling without it compiles and works.
 */
Deno.test("Logger methods callable without meta argument", () => {
  let called = false;
  const mock: Logger = {
    debug(_msg: string): void {
      called = true;
    },
    info(_msg: string): void {
      called = true;
    },
    warn(_msg: string): void {
      called = true;
    },
    error(_msg: string): void {
      called = true;
    },
    child(_scope: string): Logger {
      return this;
    },
  };
  mock.debug("hello");
  assertEquals(called, true);
});

/**
 * Scenario: child() returns a Logger (sub-type relationship).
 */
Deno.test("child() returns a Logger", () => {
  const root: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child(_scope: string): Logger {
      return {
        debug() {},
        info() {},
        warn() {},
        error() {},
        child(_s: string): Logger {
          return this;
        },
      };
    },
  };
  const child = root.child("sub");
  assertEquals(typeof child.debug, "function");
});
