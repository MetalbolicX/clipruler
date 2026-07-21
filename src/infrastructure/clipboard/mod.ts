/**
 * infrastructure/clipboard/mod.ts
 *
 * Clipboard adapter factory — the ONLY place in the infrastructure layer that
 * knows about concrete adapter classes.
 *
 * Design (plan-005 §Factory):
 * - buildClipboardAdapter(logger) switches on detectFromEnv().backend
 * - linux-wl       → WlClipboardAdapter()
 * - linux-xclip    → XclipAdapter()
 * - windows-powershell → PowershellClipboardAdapter()
 * - macos-pbcopy   → throws (post-MVP boundary)
 * - null           → returns null
 * - Logs adapter.name and detection reason via the Logger port
 *
 * The factory is pure: no global state, no I/O beyond detectFromEnv().
 */

import type { Logger } from "../../ports/logger.ts";
import type { ClipboardAdapter } from "../../ports/clipboard-adapter.ts";
import { detectFromEnv } from "./detector.ts";
import { WlClipboardAdapter } from "./wl-clipboard.ts";
import { XclipAdapter } from "./xclip.ts";
import { PowershellClipboardAdapter } from "./powershell.ts";

/**
 * Build and return the ClipboardAdapter for the current host environment.
 *
 * @param logger - Logger port instance used to emit a single info log with
 *                 the selected adapter name and the raw detection reason.
 * @returns The selected ClipboardAdapter, or null when no backend is available
 *          (headless Linux relay node).
 * @throws Error when the detected backend is macos-pbcopy (macOS support is
 *               deferred past v0.1.0).
 */
export function buildClipboardAdapter(logger: Logger): ClipboardAdapter | null {
  const detected = detectFromEnv();

  switch (detected.backend) {
    case "linux-wl": {
      const adapter = new WlClipboardAdapter();
      logger.info("clipboard adapter selected", {
        adapter: adapter.name,
        reason: detected.reason,
      });
      return adapter;
    }
    case "linux-xclip": {
      const adapter = new XclipAdapter();
      logger.info("clipboard adapter selected", {
        adapter: adapter.name,
        reason: detected.reason,
      });
      return adapter;
    }
    case "windows-powershell": {
      const adapter = new PowershellClipboardAdapter();
      logger.info("clipboard adapter selected", {
        adapter: adapter.name,
        reason: detected.reason,
      });
      return adapter;
    }
    case "macos-pbcopy": {
      throw new Error(
        "macOS adapter lands after v0.1.0; PR2 ships with windows-powershell, linux-wl, linux-xclip, null only",
      );
    }
    case "null": {
      // No adapter available (headless relay node); return null as a first-class value.
      logger.info("clipboard adapter selected", {
        adapter: "null",
        reason: detected.reason,
      });
      return null;
    }
  }
}
