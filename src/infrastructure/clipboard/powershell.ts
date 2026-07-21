/**
 * infrastructure/clipboard/powershell.ts
 *
 * Windows PowerShell clipboard adapter — wraps Get-Clipboard and Set-Clipboard.
 *
 * Design (plan-005 §powershell adapter):
 * - Read: `powershell.exe -NoProfile -Command Get-Clipboard`; normalize \r\n → \n
 * - Write: UTF-16LE base64 `-EncodedCommand` of a stdin-piped Set-Clipboard script.
 *   Using -EncodedCommand avoids all quoting/escaping issues with special characters
 *   (apostrophes, newlines, etc.) that plague -Command "Set-Clipboard -Value 'text'".
 *   The script reads from the $input automatic variable (piped stdin) and passes
 *   it to Set-Clipboard.
 * - Subscribe: 1s polling with lastText diff and lazy timer
 * - Write notifies local subscribers
 *
 * Runner injection: constructor accepts an optional `runner` for testability.
 */

import type { ClipboardAdapter, ClipboardContent } from "../../ports/clipboard-adapter.ts";

export class PowershellClipboardAdapter implements ClipboardAdapter {
  readonly name = "powershell" as const;

  private timer: number | null = null;
  private lastText = "";
  private readonly handlers = new Set<(c: ClipboardContent) => void>();

  constructor(
    private readonly runner: (
      cmd: string[],
      stdin?: string,
    ) => Promise<{ stdout: Uint8Array; stderr: Uint8Array; code: number }> = defaultRunner,
  ) {}

  async read(): Promise<ClipboardContent> {
    const out = await this.runner(["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard"]);
    const raw = new TextDecoder().decode(out.stdout);
    // Normalize CRLF → LF globally (Windows PowerShell returns \r\n line endings).
    // Preserve trailing newlines — the spec and tests expect the trailing LF to stay.
    const text = raw.replace(/\r\n/g, "\n");
    return { text, isPassword: false };
  }

  async write(content: ClipboardContent): Promise<void> {
    // Build a PowerShell script that reads $input (piped stdin) and sets the clipboard.
    // Using -EncodedCommand (UTF-16LE base64) avoids all quoting/escaping issues.
    const scriptText = "$input | Set-Clipboard";
    // UTF-16LE encode then base64 — handles any Unicode in the script correctly
    const scriptBytes = new Uint8Array(scriptText.length * 2);
    for (let i = 0; i < scriptText.length; i++) {
      scriptBytes[i * 2] = scriptText.charCodeAt(i) & 0xff;
      scriptBytes[i * 2 + 1] = (scriptText.charCodeAt(i) >> 8) & 0xff;
    }
    const encodedScript = btoa(String.fromCharCode(...scriptBytes));

    const { code } = await this.runner(
      ["powershell.exe", "-NoProfile", "-EncodedCommand", encodedScript],
      content.text,
    );
    if (code !== 0) {
      throw new Error(`powershell.exe Set-Clipboard exited with code ${code}`);
    }
    const notification: ClipboardContent = { text: content.text, isPassword: false };
    for (const h of this.handlers) h(notification);
  }

  subscribe(handler: (c: ClipboardContent) => void): () => void {
    this.handlers.add(handler);
    if (this.timer === null) {
      this.timer = setInterval(() => void this.poll(), 1000) as unknown as number;
    }
    return () => {
      this.handlers.delete(handler);
      if (this.handlers.size === 0 && this.timer !== null) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  private async poll(): Promise<void> {
    try {
      const out = await this.runner(["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard"]);
      const raw = new TextDecoder().decode(out.stdout);
      // Match read() normalization: global CRLF → LF, preserve trailing newlines.
      const text = raw.replace(/\r\n/g, "\n");
      if (text !== this.lastText) {
        this.lastText = text;
        const content: ClipboardContent = { text, isPassword: false };
        for (const h of this.handlers) h(content);
      }
    } catch {
      // Get-Clipboard can throw on empty clipboard — ignore
    }
  }
}

async function defaultRunner(
  cmd: string[],
  stdin?: string,
): Promise<{ stdout: Uint8Array; stderr: Uint8Array; code: number }> {
  const proc = new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    stdin: stdin ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  });
  if (stdin) {
    const child = proc.spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
    const { code, stdout, stderr } = await child.output();
    return { code, stdout, stderr };
  }
  const { code, stdout, stderr } = await proc.output();
  return { code, stdout, stderr };
}
