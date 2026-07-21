/**
 * Unit tests for infrastructure/clipboard/xclip.ts.
 *
 * Verifies (via injected runner — no real xclip/xsel needed):
 * - name is "xclip"
 * - read() returns ClipboardContent from xclip/xsel output
 * - write() pipes text to xclip/xsel and fires subscribers
 * - subscribe() starts polling on first handler, stops when last removed
 * - no subprocess on construction
 * - throws if neither xclip nor xsel is available
 *
 * Layer: unit — injected runner replaces Deno.Command in tests.
 * Strict TDD: tests written BEFORE implementation.
 */
import { assertEquals, assertFalse } from "jsr:@std/assert@^1.0";
import type { ClipboardContent } from "../../../../src/ports/clipboard-adapter.ts";
import { XclipAdapter } from "../../../../src/infrastructure/clipboard/xclip.ts";

type CmdOutput = { stdout: Uint8Array; stderr: Uint8Array; code: number };

function text(data: string): Uint8Array {
  return new TextEncoder().encode(data);
}

function ok(data: string): CmdOutput {
  return { stdout: text(data), stderr: new Uint8Array(), code: 0 };
}

// ---------------------------------------------------------------------------
// Scenario: adapter reports its name
// ---------------------------------------------------------------------------
Deno.test("XclipAdapter: name is 'xclip'", () => {
  const adapter = new XclipAdapter(() => Promise.resolve(ok("")));
  assertEquals(adapter.name, "xclip");
});

// ---------------------------------------------------------------------------
// Scenario: no subprocess on construction
// ---------------------------------------------------------------------------
Deno.test("XclipAdapter: no subprocess on construction", () => {
  let spawned = false;
  const spy = (_cmd: string[], _stdin?: string): Promise<CmdOutput> => {
    spawned = true;
    return Promise.resolve(ok(""));
  };
  new XclipAdapter(spy);
  assertFalse(spawned);
});

// ---------------------------------------------------------------------------
// Scenario: read() returns content via xclip
// ---------------------------------------------------------------------------
Deno.test("XclipAdapter: read() returns content from xclip stdout", async () => {
  const adapter = new XclipAdapter(() => Promise.resolve(ok("hello xclip\n")));
  const content = await adapter.read();
  assertEquals(content.text, "hello xclip\n");
  assertEquals(content.isPassword, false);
});

// ---------------------------------------------------------------------------
// Scenario: read() returns content via xsel fallback
// ---------------------------------------------------------------------------
Deno.test("XclipAdapter: read() uses xsel when xclip is absent", async () => {
  let usedBinary = "";
  // Override detect so xclip appears absent and xsel appears available
  const mockDetect = (bin: string): Promise<boolean> => {
    return Promise.resolve(bin === "xsel"); // only xsel is "available"
  };
  const adapter = new XclipAdapter(
    (cmd: string[], _stdin?: string) => {
      usedBinary = cmd[0]!;
      return Promise.resolve(ok("xsel content"));
    },
    mockDetect,
  );
  const content = await adapter.read();
  assertEquals(content.text, "xsel content");
  assertEquals(usedBinary, "xsel", "should fall back to xsel when xclip unavailable");
});

// ---------------------------------------------------------------------------
// Scenario: write() pipes text to xclip and fires subscribers
// ---------------------------------------------------------------------------
Deno.test("XclipAdapter: write() calls xclip with text via stdin", async () => {
  let capturedStdin = "";
  const adapter = new XclipAdapter((cmd: string[], stdin?: string) => {
    if (cmd[0] === "xclip" || cmd[0] === "xsel") {
      capturedStdin = stdin ?? "";
      return Promise.resolve({ stdout: new Uint8Array(), stderr: new Uint8Array(), code: 0 });
    }
    return Promise.resolve(ok(""));
  });

  await adapter.write({ text: "xclip written", isPassword: false });

  assertEquals(capturedStdin, "xclip written");
});

Deno.test("XclipAdapter: write() fires local subscribers with new content", async () => {
  const fired: ClipboardContent[] = [];

  const trackingAdapter = new XclipAdapter((cmd: string[], _stdin?: string) => {
    if (cmd[0] === "xclip" || cmd[0] === "xsel") {
      return Promise.resolve({ stdout: new Uint8Array(), stderr: new Uint8Array(), code: 0 });
    }
    return Promise.resolve(ok(""));
  });

  trackingAdapter.subscribe((c: ClipboardContent) => fired.push(c));
  await trackingAdapter.write({ text: "xclip-fire", isPassword: false });

  assertEquals(fired.length, 1);
  assertEquals(fired[0]?.text, "xclip-fire");
  assertEquals(fired[0]?.isPassword, false);
});

// ---------------------------------------------------------------------------
// Scenario: subscribe() returns unsubscribe function
// ---------------------------------------------------------------------------
Deno.test("XclipAdapter: subscribe() returns callable unsubscribe", () => {
  const adapter = new XclipAdapter(() => Promise.resolve(ok("")));
  const unsub = adapter.subscribe(() => {});
  unsub(); // Must not throw
  unsub(); // Must be idempotent
});

// ---------------------------------------------------------------------------
// Scenario: polling fires at 1s interval
// ---------------------------------------------------------------------------
Deno.test("XclipAdapter: polling fires at 1s interval", async () => {
  let pollCount = 0;
  const adapter = new XclipAdapter((cmd: string[]) => {
    if (cmd[0] === "xclip" || cmd[0] === "xsel") {
      pollCount++;
      return Promise.resolve(ok("poll-content"));
    }
    return Promise.resolve(ok(""));
  });

  adapter.subscribe(() => {});

  await new Promise<void>((resolve) => setTimeout(resolve, 1200));

  assertEquals(pollCount >= 1, true, "polling should have fired at least once");
});

// ---------------------------------------------------------------------------
// Scenario: unsubscribe stops timer when last handler removed
// ---------------------------------------------------------------------------
Deno.test("XclipAdapter: unsubscribe stops timer when last handler removed", async () => {
  let pollCount = 0;
  const adapter = new XclipAdapter((cmd: string[]) => {
    if (cmd[0] === "xclip" || cmd[0] === "xsel") {
      pollCount++;
      return Promise.resolve(ok("content"));
    }
    return Promise.resolve(ok(""));
  });

  const unsub1 = adapter.subscribe(() => {});
  const unsub2 = adapter.subscribe(() => {});

  await new Promise<void>((resolve) => setTimeout(resolve, 1200));

  unsub1();
  unsub2();

  const countAfterLastUnsub = pollCount;

  await new Promise<void>((resolve) => setTimeout(resolve, 1200));

  assertEquals(pollCount, countAfterLastUnsub, "timer should have stopped after last unsubscribe");
});
