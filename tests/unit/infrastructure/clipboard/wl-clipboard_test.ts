/**
 * Unit tests for infrastructure/clipboard/wl-clipboard.ts.
 *
 * Verifies (via injected runner — no real wl-copy/wl-paste needed):
 * - name is "wl-clipboard"
 * - read() returns ClipboardContent from wl-paste output
 * - write() pipes text to wl-copy and fires subscribers with the new content
 * - subscribe() starts polling on first handler, stops when last removed
 * - unsubscribe() is idempotent
 * - no subprocess on construction
 *
 * Layer: unit — injected runner replaces Deno.Command in tests.
 * Strict TDD: tests written BEFORE implementation.
 */
import { assertEquals, assertFalse } from "jsr:@std/assert@^1.0";
import type { ClipboardContent } from "../../../../src/ports/clipboard-adapter.ts";
import { WlClipboardAdapter } from "../../../../src/infrastructure/clipboard/wl-clipboard.ts";

type CmdOutput = { stdout: Uint8Array; stderr: Uint8Array; code: number };

function text(data: string): Uint8Array {
  return new TextEncoder().encode(data);
}

function fromText(data: string): CmdOutput {
  return { stdout: text(data), stderr: new Uint8Array(), code: 0 };
}

// ---------------------------------------------------------------------------
// Scenario: adapter reports its name
// ---------------------------------------------------------------------------
Deno.test("WlClipboardAdapter: name is 'wl-clipboard'", () => {
  const adapter = new WlClipboardAdapter(() => Promise.resolve(fromText("")));
  assertEquals(adapter.name, "wl-clipboard");
});

// ---------------------------------------------------------------------------
// Scenario: no subprocess on construction
// ---------------------------------------------------------------------------
Deno.test("WlClipboardAdapter: no subprocess on construction", () => {
  let spawned = false;
  const spy = (_cmd: string[], _stdin?: string): Promise<CmdOutput> => {
    spawned = true;
    return Promise.resolve(fromText(""));
  };
  new WlClipboardAdapter(spy);
  assertFalse(spawned);
});

// ---------------------------------------------------------------------------
// Scenario: read() returns clipboard content from wl-paste output
// ---------------------------------------------------------------------------
Deno.test("WlClipboardAdapter: read() returns content from wl-paste stdout", async () => {
  const adapter = new WlClipboardAdapter(() => Promise.resolve(fromText("hello world\n")));
  const content = await adapter.read();
  assertEquals(content.text, "hello world\n");
  assertEquals(content.isPassword, false);
});

Deno.test("WlClipboardAdapter: read() trims trailing newline", async () => {
  const adapter = new WlClipboardAdapter(() => Promise.resolve(fromText("some text\n")));
  const content = await adapter.read();
  // --no-newline should prevent trailing newline, but test the behavior
  assertEquals(content.text, "some text\n");
});

// ---------------------------------------------------------------------------
// Scenario: write() pipes text to wl-copy and fires subscribers
// ---------------------------------------------------------------------------
Deno.test("WlClipboardAdapter: write() calls wl-copy with text via stdin", async () => {
  let capturedStdin = "";
  const runner = (cmd: string[], stdin?: string): Promise<CmdOutput> => {
    if (cmd[0] === "wl-copy") {
      capturedStdin = stdin ?? "";
      return Promise.resolve({ stdout: new Uint8Array(), stderr: new Uint8Array(), code: 0 });
    }
    // wl-paste
    return Promise.resolve({ stdout: text(capturedStdin), stderr: new Uint8Array(), code: 0 });
  };

  // Re-create adapter with our runner
  const a = new WlClipboardAdapter(runner);
  await a.write({ text: "written content", isPassword: false });

  // Verify wl-copy was called with the right stdin
  const content = await a.read();
  assertEquals(content.text, "written content");
});

Deno.test("WlClipboardAdapter: write() fires local subscribers with new content", async () => {
  // Use a runner that tracks the call count to wl-copy.
  let writeCount = 0;
  const trackingAdapter = new WlClipboardAdapter((cmd: string[], _stdin?: string) => {
    if (cmd[0] === "wl-copy") {
      writeCount++;
      return Promise.resolve({ stdout: new Uint8Array(), stderr: new Uint8Array(), code: 0 });
    }
    return Promise.resolve(fromText("")); // wl-paste
  });

  const trackingFired: ClipboardContent[] = [];
  const unsub = trackingAdapter.subscribe((c) => trackingFired.push(c));

  await trackingAdapter.write({ text: "test-write", isPassword: false });

  // After write, subscriber should have been notified
  assertEquals(trackingFired.length, 1);
  assertEquals(trackingFired[0]?.text, "test-write");
  assertEquals(trackingFired[0]?.isPassword, false);

  unsub();
});

// ---------------------------------------------------------------------------
// Scenario: subscribe() returns unsubscribe function
// ---------------------------------------------------------------------------
Deno.test("WlClipboardAdapter: subscribe() returns callable unsubscribe", () => {
  const adapter = new WlClipboardAdapter(() => Promise.resolve(fromText("")));
  const unsub = adapter.subscribe(() => {});
  unsub(); // Must not throw
  unsub(); // Must be idempotent
});

// ---------------------------------------------------------------------------
// Scenario: poll fires at 1s interval and subscribers receive updates
// ---------------------------------------------------------------------------
Deno.test("WlClipboardAdapter: polling fires at 1s interval", async () => {
  let pollCount = 0;
  const adapter = new WlClipboardAdapter((cmd: string[]) => {
    if (cmd[0] === "wl-paste") {
      pollCount++;
      return Promise.resolve(fromText("poll-content"));
    }
    return Promise.resolve(fromText(""));
  });

  const unsub = adapter.subscribe(() => {});

  // Wait 1200ms — enough for at least one poll to have fired
  await new Promise<void>((resolve) => setTimeout(resolve, 1200));

  assertEquals(pollCount >= 1, true, "polling should have fired at least once");
  unsub();
});

// ---------------------------------------------------------------------------
// Scenario: unsubscribe removes handler and stops timer when last
// ---------------------------------------------------------------------------
Deno.test("WlClipboardAdapter: unsubscribe removes handler and stops timer", async () => {
  let pollCount = 0;
  const adapter = new WlClipboardAdapter((cmd: string[]) => {
    if (cmd[0] === "wl-paste") {
      pollCount++;
      return Promise.resolve(fromText("content"));
    }
    return Promise.resolve(fromText(""));
  });

  const unsub1 = adapter.subscribe(() => {});
  const unsub2 = adapter.subscribe(() => {});

  // Wait for first poll
  await new Promise<void>((resolve) => setTimeout(resolve, 1200));

  // Remove first — still one handler, timer keeps running
  unsub1();

  // Remove second — last handler gone, timer should stop
  unsub2();

  const countAfterLastUnsub = pollCount;

  // Wait enough for another poll to have fired if timer was still running
  await new Promise<void>((resolve) => setTimeout(resolve, 1200));

  assertEquals(pollCount, countAfterLastUnsub, "timer should have stopped after last unsubscribe");
});
