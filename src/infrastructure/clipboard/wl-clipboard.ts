/**
 * infrastructure/clipboard/wl-clipboard.ts
 *
 * Wayland clipboard adapter — wraps wl-paste and wl-copy for clipboard access.
 *
 * Design (plan-005 §wl-clipboard adapter):
 * - Read: `wl-paste --no-newline` (fixed args, piped stdout)
 * - Write: `wl-copy` with stdin-piped text
 * - Subscribe: 1s polling with lastText diff and lazy timer (start at 0→1, stop at 1→0)
 * - Write notifies local subscribers (caller-side dedup)
 *
 * Runner injection: constructor accepts an optional `runner` for testability.
 * The runner signature mirrors Deno.Command output without requiring actual
 * subprocess spawning in unit tests.
 */

import type { ClipboardAdapter, ClipboardContent } from "../../ports/clipboard-adapter.ts";

export class WlClipboardAdapter implements ClipboardAdapter {
  readonly name = "wl-clipboard" as const;

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
    const out = await this.runner(["wl-paste", "--no-newline"]);
    const text = new TextDecoder().decode(out.stdout);
    return { text, isPassword: false };
  }

  async write(content: ClipboardContent): Promise<void> {
    const { code } = await this.runner(["wl-copy"], content.text);
    if (code !== 0) {
      throw new Error(`wl-copy exited with code ${code}`);
    }
    // Fire subscribers with the written content (local-write notification)
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
      const out = await this.runner(["wl-paste", "--no-newline"]);
      const text = new TextDecoder().decode(out.stdout).trim();
      if (text !== this.lastText) {
        this.lastText = text;
        const content: ClipboardContent = { text, isPassword: false };
        for (const h of this.handlers) h(content);
      }
    } catch {
      // wl-paste returns non-zero when clipboard is empty — ignore
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
