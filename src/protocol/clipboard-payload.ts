/**
 * protocol/clipboard-payload.ts
 *
 * Wire-format clipboard payload — transport-neutral, no Deno.* imports.
 * Protocol version 1 — serialized as { version: number; counter: number; content: string }
 */

export type ClipboardTextPayload = {
  /** Monotonically increasing version number. */
  readonly version: number;
  /** Per-device monotonically increasing counter for tie-breaking. */
  readonly counter: number;
  /** The actual clipboard text content. */
  readonly content: string;
};
