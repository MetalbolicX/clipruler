/**
 * infrastructure/clipboard/xclip.ts
 *
 * X11 clipboard adapter — wraps xclip with xsel fallback for clipboard access.
 *
 * Design (plan-005 §xclip adapter):
 * - Constructor lazily probes `which xclip` then `which xsel`; throws if both absent.
 * - Read: `xclip -out -selection clipboard` (or `xsel --output --clipboard`)
 * - Write: `xclip -in -selection clipboard` with stdin (or `xsel --input --clipboard`)
 * - Subscribe: 1s polling with lastText diff and lazy timer
 * - Write notifies local subscribers
 *
 * Runner injection: constructor accepts an optional `runner` for testability.
 */

import type { ClipboardAdapter, ClipboardContent } from "../../ports/clipboard-adapter.ts";
import { which } from "./which.ts";

type CmdOutput = { stdout: Uint8Array; stderr: Uint8Array; code: number };

export class XclipAdapter implements ClipboardAdapter {
  readonly name = "xclip" as const;

  private timer: number | null = null;
  private lastText = "";
  private readonly handlers = new Set<(c: ClipboardContent) => void>();
  private binary = "";

  constructor(
    private readonly runner: (cmd: string[], stdin?: string) => Promise<CmdOutput> = defaultRunner,
    private readonly detect: (bin: string) => Promise<boolean> = which,
  ) {
    this.binary = ""; // Will be resolved lazily on first use
  }

  /** Resolves the available binary on first read/write/subscribe. */
  private async resolveBinary(): Promise<string> {
    if (this.binary) return this.binary;
    if (await this.detect("xclip")) {
      this.binary = "xclip";
      return "xclip";
    }
    if (await this.detect("xsel")) {
      this.binary = "xsel";
      return "xsel";
    }
    throw new Error(
      "Neither xclip nor xsel is available on this system. Install one of them to use the clipboard.",
    );
  }

  async read(): Promise<ClipboardContent> {
    const binary = await this.resolveBinary();
    const args = binary === "xclip"
      ? ["-out", "-selection", "clipboard"]
      : ["--output", "--clipboard"];
    const out = await this.runner([binary, ...args]);
    const text = new TextDecoder().decode(out.stdout);
    return { text, isPassword: false };
  }

  async write(content: ClipboardContent): Promise<void> {
    const binary = await this.resolveBinary();
    const args = binary === "xclip"
      ? ["-in", "-selection", "clipboard"]
      : ["--input", "--clipboard"];
    const { code } = await this.runner([binary, ...args], content.text);
    if (code !== 0) {
      throw new Error(`${binary} exited with code ${code}`);
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
      const binary = await this.resolveBinary();
      const args = binary === "xclip"
        ? ["-out", "-selection", "clipboard"]
        : ["--output", "--clipboard"];
      const out = await this.runner([binary, ...args]);
      const text = new TextDecoder().decode(out.stdout).trim();
      if (text !== this.lastText) {
        this.lastText = text;
        const content: ClipboardContent = { text, isPassword: false };
        for (const h of this.handlers) h(content);
      }
    } catch {
      // xclip/xsel return non-zero when clipboard is empty — ignore
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
