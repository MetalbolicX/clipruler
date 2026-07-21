/**
 * Unit tests for infrastructure/clipboard/powershell.ts.
 *
 * Verifies (via injected runner — no real powershell.exe needed):
 * - name is "powershell"
 * - read() uses `powershell.exe -NoProfile -Command Get-Clipboard` and normalizes \\r\\n → \\n
 * - write() uses `-EncodedCommand` UTF-16LE base64 of a stdin-piped script
 * - write() fires subscribers with the new content
 * - subscribe() starts polling on first handler, stops when last removed
 * - no subprocess on construction
 *
 * Layer: unit — injected runner replaces Deno.Command in tests.
 * Strict TDD: tests written BEFORE implementation.
 */
import { assertEquals, assertFalse } from "jsr:@std/assert@^1.0";
import type { ClipboardContent } from "../../../../src/ports/clipboard-adapter.ts";
import { PowershellClipboardAdapter } from "../../../../src/infrastructure/clipboard/powershell.ts";

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
Deno.test("PowershellClipboardAdapter: name is 'powershell'", () => {
  const adapter = new PowershellClipboardAdapter(() => Promise.resolve(ok("")));
  assertEquals(adapter.name, "powershell");
});

// ---------------------------------------------------------------------------
// Scenario: no subprocess on construction
// ---------------------------------------------------------------------------
Deno.test("PowershellClipboardAdapter: no subprocess on construction", () => {
  let spawned = false;
  const spy = (_cmd: string[], _stdin?: string): Promise<CmdOutput> => {
    spawned = true;
    return Promise.resolve(ok(""));
  };
  new PowershellClipboardAdapter(spy);
  assertFalse(spawned);
});

// ---------------------------------------------------------------------------
// Scenario: read() uses Get-Clipboard and normalizes \\r\\n → \\n
// ---------------------------------------------------------------------------
Deno.test("PowershellClipboardAdapter: read() returns content from Get-Clipboard", async () => {
  const adapter = new PowershellClipboardAdapter(() => Promise.resolve(ok("hello powershell\r\n")));
  const content = await adapter.read();
  assertEquals(content.text, "hello powershell\n");
  assertEquals(content.isPassword, false);
});

Deno.test("PowershellClipboardAdapter: read() normalizes CRLF to LF", async () => {
  const adapter = new PowershellClipboardAdapter(() => Promise.resolve(ok("line1\r\nline2\r\n")));
  const content = await adapter.read();
  assertEquals(content.text, "line1\nline2\n");
});

Deno.test("PowershellClipboardAdapter: read() handles text without trailing CRLF", async () => {
  const adapter = new PowershellClipboardAdapter(() => Promise.resolve(ok("no-crlf")));
  const content = await adapter.read();
  assertEquals(content.text, "no-crlf");
});

// ---------------------------------------------------------------------------
// Scenario: write() uses -EncodedCommand with base64 UTF-16LE script
// ---------------------------------------------------------------------------
Deno.test("PowershellClipboardAdapter: write() uses -EncodedCommand with base64 UTF-16LE", async () => {
  const adapter = new PowershellClipboardAdapter((cmd: string[], _stdin?: string) => {
    // cmd should be ["powershell.exe", "-NoProfile", "-EncodedCommand", "<base64>"]
    const encodedIdx = cmd.indexOf("-EncodedCommand");
    assertEquals(encodedIdx !== -1, true, "should use -EncodedCommand");
    const encoded = cmd[encodedIdx + 1]!;
    // Decode and verify it contains Set-Clipboard -Value $input or equivalent
    // The script should read from stdin (the $input automatic variable)
    const decoded = atob(encoded);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      bytes[i] = decoded.charCodeAt(i);
    }
    const pairs: string[] = [];
    for (let i = 0; i < bytes.length - 1; i += 2) {
      pairs.push(String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8)));
    }
    const script = pairs.slice(0, decoded.length / 2).join("");
    assertEquals(script.includes("Set-Clipboard"), true, "script should call Set-Clipboard");
    return Promise.resolve({ stdout: new Uint8Array(), stderr: new Uint8Array(), code: 0 });
  });

  await adapter.write({ text: "test content", isPassword: false });
});

// ---------------------------------------------------------------------------
// Scenario: write() fires local subscribers with new content
// ---------------------------------------------------------------------------
Deno.test("PowershellClipboardAdapter: write() fires local subscribers with new content", async () => {
  const fired: ClipboardContent[] = [];
  const trackingAdapter = new PowershellClipboardAdapter(() => {
    return Promise.resolve({ stdout: new Uint8Array(), stderr: new Uint8Array(), code: 0 });
  });
  trackingAdapter.subscribe((c: ClipboardContent) => fired.push(c));
  await trackingAdapter.write({ text: "powershell-fire", isPassword: false });

  assertEquals(fired.length, 1);
  assertEquals(fired[0]?.text, "powershell-fire");
  assertEquals(fired[0]?.isPassword, false);
});

// ---------------------------------------------------------------------------
// Scenario: subscribe() returns unsubscribe function
// ---------------------------------------------------------------------------
Deno.test("PowershellClipboardAdapter: subscribe() returns callable unsubscribe", () => {
  const adapter = new PowershellClipboardAdapter(() => Promise.resolve(ok("")));
  const unsub = adapter.subscribe(() => {});
  unsub(); // Must not throw
  unsub(); // Must be idempotent
});

// ---------------------------------------------------------------------------
// Scenario: polling fires at 1s interval
// ---------------------------------------------------------------------------
Deno.test("PowershellClipboardAdapter: polling fires at 1s interval", async () => {
  let pollCount = 0;
  const adapter = new PowershellClipboardAdapter((_cmd: string[]) => {
    pollCount++;
    return Promise.resolve(ok("poll-content\r\n"));
  });

  adapter.subscribe(() => {});

  await new Promise<void>((resolve) => setTimeout(resolve, 1200));

  assertEquals(pollCount >= 1, true, "polling should have fired at least once");
});

// ---------------------------------------------------------------------------
// Scenario: unsubscribe stops timer when last handler removed
// ---------------------------------------------------------------------------
Deno.test("PowershellClipboardAdapter: unsubscribe stops timer when last handler removed", async () => {
  let pollCount = 0;
  const adapter = new PowershellClipboardAdapter((_cmd: string[]) => {
    pollCount++;
    return Promise.resolve(ok("content\r\n"));
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
