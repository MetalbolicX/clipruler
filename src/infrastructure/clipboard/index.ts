/**
 * infrastructure/clipboard/index.ts
 *
 * Barrel — re-exports the public surface of the clipboard infrastructure layer.
 *
 * Exposes:
 * - buildClipboardAdapter factory
 * - All concrete adapter classes (for shell composition and testing)
 * - Detector types (for testability)
 */

export { buildClipboardAdapter } from "./mod.ts";

// Concrete adapter classes — imported here so shells can compose without
// knowing the concrete file paths.
export { WlClipboardAdapter } from "./wl-clipboard.ts";
export { XclipAdapter } from "./xclip.ts";
export { PowershellClipboardAdapter } from "./powershell.ts";
export { NullClipboardAdapter } from "./null-adapter.ts";

// Detector types — re-exported for unit-testability without importing the
// internal detector directly from tests.
export type { DetectedBackend, DetectionResult } from "./detector.ts";
export { detectBackend, detectFromEnv } from "./detector.ts";
