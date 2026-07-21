/**
 * domain/index.ts
 *
 * Curated public exports for the domain layer.
 * Consumers import from here — never from internal module files directly.
 */

// Brand helper
export type { Brand } from "./device.ts";

// Branded ID types
export type { DeviceId, MessageId, PublicKeyFingerprint } from "./device.ts";

// Guard functions
export { isDeviceId, isMessageId, isPublicKeyFingerprint } from "./device.ts";

// Factory functions
export { makeDeviceId, makeMessageId, makePublicKeyFingerprint } from "./device.ts";

// Value objects
export { Device } from "./device.ts";

// Deterministic fingerprint
export { deriveFingerprint } from "./device.ts";

// Pairing FSM
export { transition } from "./pairing.ts";
export type { PairEvent, PairState } from "./pairing.ts";

// Clipboard event & version comparison
export { compareVersions } from "./clipboard-event.ts";
export type { ClipboardEvent, Version } from "./clipboard-event.ts";

// Conflict resolver
export { initResolver, observe } from "./conflict-resolver.ts";
export type { ObserveResult, ResolverState } from "./conflict-resolver.ts";
