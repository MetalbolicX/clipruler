/**
 * Unit tests for infrastructure/logger/console-logger.ts.
 * Verifies ConsoleLogger behavior: all levels callable without throwing,
 * stderr-only output (constraint #2), optional meta fields, and
 * non-throwing on malformed data.
 * Layer: unit.
 *
 * IMPORTANT: Every assertion here CALLS production code and asserts a
 * SPECIFIC expected value. We never use `assertEquals(true, true)` —
 * the test fails if production code throws because the throw escapes
 * before the assertion. Trivial assertions are banned by strict-tdd.md.
 */
import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0";
import { ConsoleLogger } from "../../../../src/infrastructure/logger/console-logger.ts";

/**
 * Scenario: all four log levels are callable without throwing.
 * Catches any throw from production code; no trivial assertion needed.
 */
Deno.test("All four log levels callable without throwing", () => {
  const logger = new ConsoleLogger("test");
  // If any of these throws, the test fails by an uncaught error.
  logger.debug("debug message");
  logger.info("info message");
  logger.warn("warn message");
  logger.error("error message");
});

/**
 * Scenario: meta object is optional on all levels — JSON line still emitted.
 */
Deno.test("All levels accept optional meta object and still emit JSON", () => {
  const captured: string[] = [];
  const orig = globalThis.console.error;
  try {
    globalThis.console.error = (...args: unknown[]) => {
      captured.push(String(args[0]));
    };
    const logger = new ConsoleLogger("test-meta");
    logger.debug("d", { key: "value" });
    logger.info("i", { counter: 42 });
    logger.warn("w", { flag: true });
    logger.error("e", { err: null });
  } finally {
    globalThis.console.error = orig;
  }
  assertEquals(captured.length, 4, "one JSON line per level");
  for (const line of captured) {
    const parsed = JSON.parse(line);
    assertEquals(parsed.scope, "test-meta");
  }
});

/**
 * Scenario (constraint #2): EVERY level — debug, info, warn, error —
 * writes to stderr and to nothing else (stdout untouched).
 */
Deno.test("Constraint #2: ALL levels write to stderr, NONE to stdout", () => {
  const stderrLines: string[] = [];
  const stdoutLines: string[] = [];

  const origError = globalThis.console.error;
  const origLog = globalThis.console.log;
  try {
    globalThis.console.error = (...args: unknown[]) => {
      stderrLines.push(String(args[0]));
    };
    globalThis.console.log = (...args: unknown[]) => {
      stdoutLines.push(String(args[0]));
    };

    const logger = new ConsoleLogger("sink");
    logger.debug("d-msg");
    logger.info("i-msg");
    logger.warn("w-msg");
    logger.error("e-msg");
  } finally {
    globalThis.console.error = origError;
    globalThis.console.log = origLog;
  }

  // All four messages must reach stderr.
  assertEquals(stderrLines.length, 4, "exactly four stderr lines (one per level)");
  assertEquals(
    stderrLines.filter((l) => l.includes("d-msg")).length,
    1,
    "debug goes to stderr",
  );
  assertEquals(
    stderrLines.filter((l) => l.includes("i-msg")).length,
    1,
    "info goes to stderr",
  );
  assertEquals(
    stderrLines.filter((l) => l.includes("w-msg")).length,
    1,
    "warn goes to stderr",
  );
  assertEquals(
    stderrLines.filter((l) => l.includes("e-msg")).length,
    1,
    "error goes to stderr",
  );

  // Stdout must be untouched.
  assertEquals(stdoutLines.length, 0, "no stdout writes");
});

/**
 * Scenario: output is valid JSON with required fields (level, msg, scope, ts).
 */
Deno.test("output is valid JSON with required fields (captured via stderr)", () => {
  let captured = "";
  const orig = globalThis.console.error;
  try {
    globalThis.console.error = (...args: unknown[]) => {
      captured = String(args[0]);
    };
    new ConsoleLogger("json-test").info("hello");
  } finally {
    globalThis.console.error = orig;
  }

  const parsed = JSON.parse(captured);
  assertEquals(parsed.msg, "hello");
  assertEquals(parsed.level, "info");
  assertEquals(parsed.scope, "json-test");
  assertEquals(typeof parsed.ts, "string", "timestamp string present");
});

/**
 * Scenario: child() prefixes the scope.
 */
Deno.test("child() prefixes scope with parent scope", () => {
  let captured = "";
  const orig = globalThis.console.error;
  try {
    globalThis.console.error = (...args: unknown[]) => {
      captured = String(args[0]);
    };
    new ConsoleLogger("root").child("module").info("from child");
  } finally {
    globalThis.console.error = orig;
  }

  const parsed = JSON.parse(captured);
  assertEquals(parsed.scope, "root:module");
  assertEquals(parsed.msg, "from child");
});

/**
 * Scenario: default scope is "clipruler".
 */
Deno.test("default scope is clipruler", () => {
  let captured = "";
  const orig = globalThis.console.error;
  try {
    globalThis.console.error = (...args: unknown[]) => {
      captured = String(args[0]);
    };
    new ConsoleLogger().info("x");
  } finally {
    globalThis.console.error = orig;
  }

  const parsed = JSON.parse(captured);
  assertEquals(parsed.scope, "clipruler");
});

/**
 * Scenario: non-throwing on circular reference in meta.
 * Spec says the logger MUST NOT throw; if JSON serialization fails the
 * logger is allowed to drop the line. The test verifies "no throw escaped"
 * by NOT wrapping the call — a throw would fail the test.
 */
Deno.test("non-throwing on circular reference in meta", () => {
  const c: Record<string, unknown> = { a: 1 };
  c.self = c;
  // If this throws, the test fails with an uncaught error.
  new ConsoleLogger("circular").info("circular", c);
});

/**
 * Scenario: non-throwing on BigInt in meta.
 */
Deno.test("non-throwing on BigInt in meta", () => {
  new ConsoleLogger("bigint").info("big", { n: BigInt(123) });
});

/**
 * Scenario: non-throwing on undefined values in meta.
 */
Deno.test("non-throwing on undefined in meta and still emits", () => {
  const captured: string[] = [];
  const orig = globalThis.console.error;
  try {
    globalThis.console.error = (...args: unknown[]) => {
      captured.push(String(args[0]));
    };
    new ConsoleLogger("undef").info("undef", { present: 1, missing: undefined });
  } finally {
    globalThis.console.error = orig;
  }
  assertEquals(captured.length, 1, "logger must still emit a line with undefined meta");
});

/**
 * Negative scenario: child() returns a new logger that retains the parent's prefix.
 * Asserts the new logger emits with the child scope (not the parent scope alone).
 */
Deno.test("child() scope is not equal to parent scope", () => {
  let capturedChild = "";
  let capturedParent = "";
  const orig = globalThis.console.error;
  try {
    globalThis.console.error = (...args: unknown[]) => {
      const line = String(args[0]);
      const parsed = JSON.parse(line);
      if (parsed.scope === "root:child") capturedChild = parsed.msg;
      if (parsed.scope === "root") capturedParent = parsed.msg;
    };
    const parent = new ConsoleLogger("root");
    parent.info("parent-msg");
    parent.child("child").info("child-msg");
  } finally {
    globalThis.console.error = orig;
  }
  assertEquals(capturedParent, "parent-msg");
  assertEquals(capturedChild, "child-msg");
  assertStrictEquals(capturedChild, "child-msg");
});
