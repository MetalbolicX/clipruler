/**
 * ports/index.ts
 *
 * Barrel — re-exports all port interfaces from a single entry point.
 * Ports files export only interface and type. No runtime exports.
 */

// Logger port
export type { Logger, LogLevel } from "./logger.ts";

// KeyStore port
export type { KeyStore, PrivateKeyMaterial } from "./key-store.ts";

// DeviceRepository port
export type { DeviceRepository, StoredDevice } from "./device-repository.ts";

// LogicalClock port
export type { LogicalClock, LogicalCounter } from "./logical-clock.ts";

// Transport port
export type { Transport } from "./transport.ts";

// ClipboardAdapter port
export type { ClipboardAdapter, ClipboardContent } from "./clipboard-adapter.ts";
