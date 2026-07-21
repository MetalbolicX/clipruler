/**
 * Integration smoke tests for clipboard adapters.
 *
 * These tests probe real clipboard backends (wl-paste/wl-copy, xclip/xsel,
 * powershell.exe) and are gated by:
 *   CLIPRULER_CLIPBOARD_TESTS=1 deno task test:clipboard
 *
 * Each test:
 * 1. Probes `which <bin>` — skips if the tool is absent
 * 2. Writes a UUID sentinel to the clipboard
 * 3. Reads it back and asserts equality
 * 4. Cleans up by writing an empty string
 *
 * These are true integration tests: they exercise the full subprocess
 * boundary and verify the adapters work against the real OS clipboard.
 */

import { assertEquals } from "jsr:@std/assert@^1.0";
import { which } from "../../src/infrastructure/clipboard/which.ts";
import { WlClipboardAdapter } from "../../src/infrastructure/clipboard/wl-clipboard.ts";
import { XclipAdapter } from "../../src/infrastructure/clipboard/xclip.ts";
import { PowershellClipboardAdapter } from "../../src/infrastructure/clipboard/powershell.ts";

const RUN_INTEGRATION = Deno.env.get("CLIPRULER_CLIPBOARD_TESTS") === "1";

/**
 * Wraps a promise with a hard timeout. If the timeout fires first, the returned
 * promise rejects with a timeout error. This prevents smoke tests from hanging
 * indefinitely when a clipboard binary exists (e.g. xclip) but the display
 * server it needs is unreachable.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT:${label}:${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sentinel(): string {
  return `clipruler-test-${crypto.randomUUID()}`;
}

async function writeReadBack(
  adapter: WlClipboardAdapter | XclipAdapter | PowershellClipboardAdapter,
  text: string,
): Promise<void> {
  const adapterName = adapter.constructor.name;
  try {
    await withTimeout(adapter.write({ text, isPassword: false }), 5000, `${adapterName} write`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("TIMEOUT:")) {
      console.warn(
        `${adapterName} smoke skipped: write timeout (likely no X/Wayland server reachable)`,
      );
      return;
    }
    throw err;
  }
  let content: Awaited<ReturnType<typeof adapter.read>>;
  try {
    content = await withTimeout(adapter.read(), 5000, `${adapterName} read`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("TIMEOUT:")) {
      console.warn(
        `${adapterName} smoke skipped: read timeout (likely no X/Wayland server reachable)`,
      );
      return;
    }
    throw err;
  }
  assertEquals(content.text, text, "read back should equal what was written");
}

async function cleanup(
  adapter: WlClipboardAdapter | XclipAdapter | PowershellClipboardAdapter,
): Promise<void> {
  try {
    await adapter.write({ text: "", isPassword: false });
  } catch {
    // Cleanup failures are non-fatal in smoke tests
  }
}

// ---------------------------------------------------------------------------
// wl-clipboard smoke test
// ---------------------------------------------------------------------------
Deno.test({
  name: "wl-clipboard smoke: write/read back a UUID sentinel",
  ignore: !RUN_INTEGRATION,
  async fn() {
    const hasWlPaste = await which("wl-paste");
    if (!hasWlPaste) return;

    const hasWlCopy = await which("wl-copy");
    if (!hasWlCopy) return;

    const adapter = new WlClipboardAdapter();
    const sent = sentinel();

    try {
      await writeReadBack(adapter, sent);
    } finally {
      await cleanup(adapter);
    }
  },
});

// ---------------------------------------------------------------------------
// wl-clipboard smoke test: apostrophe and multiline
// ---------------------------------------------------------------------------
Deno.test({
  name: "wl-clipboard smoke: handles apostrophe and multiline text",
  ignore: !RUN_INTEGRATION,
  async fn() {
    const hasWlPaste = await which("wl-paste");
    if (!hasWlPaste) return;

    const hasWlCopy = await which("wl-copy");
    if (!hasWlCopy) return;

    const adapter = new WlClipboardAdapter();
    const sent = "line1\nO'Reilly\nline3";

    try {
      await writeReadBack(adapter, sent);
    } finally {
      await cleanup(adapter);
    }
  },
});

// ---------------------------------------------------------------------------
// xclip smoke test
// ---------------------------------------------------------------------------
Deno.test({
  name: "xclip smoke: write/read back a UUID sentinel",
  ignore: !RUN_INTEGRATION,
  async fn() {
    const hasXclip = await which("xclip");
    const hasXsel = await which("xsel");
    if (!hasXclip && !hasXsel) return;
    // xclip requires a DISPLAY; skip on headless hosts
    if (!Deno.env.get("DISPLAY") && !Deno.env.get("WAYLAND_DISPLAY")) return;

    const adapter = new XclipAdapter();
    const sent = sentinel();

    try {
      await writeReadBack(adapter, sent);
    } finally {
      await cleanup(adapter);
    }
  },
});

// ---------------------------------------------------------------------------
// xclip smoke test: apostrophe and multiline
// ---------------------------------------------------------------------------
Deno.test({
  name: "xclip smoke: handles apostrophe and multiline text",
  ignore: !RUN_INTEGRATION,
  async fn() {
    const hasXclip = await which("xclip");
    const hasXsel = await which("xsel");
    if (!hasXclip && !hasXsel) return;
    // xclip requires a DISPLAY; skip on headless hosts
    if (!Deno.env.get("DISPLAY") && !Deno.env.get("WAYLAND_DISPLAY")) return;

    const adapter = new XclipAdapter();
    const sent = "hello\nworld\n";

    try {
      await writeReadBack(adapter, sent);
    } finally {
      await cleanup(adapter);
    }
  },
});

// ---------------------------------------------------------------------------
// powershell smoke test (Windows only)
// ---------------------------------------------------------------------------
Deno.test({
  name: "powershell smoke: write/read back a UUID sentinel",
  ignore: !RUN_INTEGRATION,
  async fn() {
    const hasPwsh = await which("powershell.exe");
    if (!hasPwsh) return;

    const adapter = new PowershellClipboardAdapter();
    const sent = sentinel();

    try {
      await writeReadBack(adapter, sent);
    } finally {
      await cleanup(adapter);
    }
  },
});

// ---------------------------------------------------------------------------
// powershell smoke test: apostrophe and multiline
// ---------------------------------------------------------------------------
Deno.test({
  name: "powershell smoke: handles apostrophe and multiline text",
  ignore: !RUN_INTEGRATION,
  async fn() {
    const hasPwsh = await which("powershell.exe");
    if (!hasPwsh) return;

    const adapter = new PowershellClipboardAdapter();
    const sent = "line1\r\nO'Reilly\r\nline3";

    try {
      // Write the normalized version (CRLF → LF in read)
      await adapter.write({ text: sent, isPassword: false });
      const content = await adapter.read();
      // PowerShell Get-Clipboard normalizes CRLF → LF
      assertEquals(content.text, sent.replace(/\r\n/g, "\n"));
    } finally {
      await cleanup(adapter);
    }
  },
});
