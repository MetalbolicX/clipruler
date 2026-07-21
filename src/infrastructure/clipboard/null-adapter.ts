/**
 * infrastructure/clipboard/null-adapter.ts
 *
 * NullClipboardAdapter — side-effect-free relay-only fallback.
 *
 * This adapter is used when no clipboard backend is available (e.g. headless
 * Linux servers acting as relay nodes). It performs no I/O, spawns no
 * subprocesses, and starts no timers.
 *
 * Design (plan-005 §NullAdapter):
 * - read() returns empty content
 * - write() is a no-op
 * - subscribe() returns a no-op unsubscribe function
 */
import type { ClipboardAdapter, ClipboardContent } from "../../ports/clipboard-adapter.ts";

export class NullClipboardAdapter implements ClipboardAdapter {
  readonly name = "null";

  read(): Promise<ClipboardContent> {
    return Promise.resolve({ text: "", isPassword: false });
  }

  write(_content: ClipboardContent): Promise<void> {
    // Intentional no-op: relay-only nodes do not own the clipboard.
    return Promise.resolve();
  }

  subscribe(_handler: (content: ClipboardContent) => void): () => void {
    // No polling, no timers — subscribers never fire.
    return () => {};
  }
}
