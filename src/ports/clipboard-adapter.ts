/**
 * ports/clipboard-adapter.ts
 *
 * ClipboardAdapter port — defines the contract for reading, writing, and
 * subscribing to clipboard changes on the host system.
 *
 * Design (plan-005 §Port):
 * - read() returns current clipboard content
 * - write() overwrites the clipboard
 * - subscribe() registers a handler for change notifications
 * - name is a human-readable backend identifier
 *
 * This port is implemented by infrastructure adapters (wl-clipboard, xclip,
 * powershell, null) and is consumed by application-layer use cases.
 *
 * Note: ports import only types — never Deno.* runtime symbols.
 */

export interface ClipboardContent {
  readonly text: string;
  readonly isPassword: boolean;
}

export interface ClipboardAdapter {
  /**
   * Read the current clipboard content.
   */
  read(): Promise<ClipboardContent>;

  /**
   * Overwrite the clipboard with the given content.
   */
  write(content: ClipboardContent): Promise<void>;

  /**
   * Subscribe to clipboard change notifications.
   * The handler fires on local user-driven changes AND on writes performed
   * by this adapter. The caller is responsible for deduplication.
   *
   * @returns An unsubscribe function that removes the handler and tears
   *          down the polling timer when the last handler is removed.
   */
  subscribe(handler: (content: ClipboardContent) => void): () => void;

  /**
   * Human-readable name of the backend, e.g. "wl-clipboard", "xclip",
   * "powershell", "null".
   */
  readonly name: string;
}
