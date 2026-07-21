/**
 * domain/conflict-resolver.ts
 *
 * Last-writer-wins conflict resolution for clipboard events.
 * Pure domain: zero Deno.* runtime imports.
 */

import type { MessageId } from "./device.ts";
import type { Version } from "./clipboard-event.ts";
import { compareVersions } from "./clipboard-event.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ObserveResult =
  | { readonly result: "accepted" }
  | { readonly result: "rejected-stale" }
  | { readonly result: "deduplicated" };

export type ResolverState = {
  readonly lastApplied?: Version;
  readonly seenMessageIds: ReadonlyMap<MessageId, true>;
};

/**
 * ObserveResult + next state returned by the observe reducer.
 */
export type ObserveOutput = {
  readonly state: ResolverState;
  readonly result: ObserveResult;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function initResolver(): ResolverState {
  return {
    seenMessageIds: new Map(),
  };
}

// ---------------------------------------------------------------------------
// observe — pure reducer
//
// Rules:
//   1. messageId already seen → deduplicated (no state change)
//   2. compareVersions(event.version, lastApplied) > 0 → accepted (update)
//   3. compareVersions(event.version, lastApplied) <= 0 → rejected-stale or deduplicated
//      (equal version + different messageId = deduplicated per spec)
// ---------------------------------------------------------------------------

export function observe(state: ResolverState, event: {
  readonly version: Version;
  readonly messageId: MessageId;
}): ObserveOutput {
  const { version, messageId } = event;

  // Rule 1: messageId deduplication
  if (state.seenMessageIds.has(messageId)) {
    return { state, result: { result: "deduplicated" } };
  }

  // No prior event — always accept
  if (state.lastApplied === undefined) {
    const nextSeen = new Map(state.seenMessageIds);
    nextSeen.set(messageId, true);
    return {
      state: { lastApplied: version, seenMessageIds: nextSeen },
      result: { result: "accepted" },
    };
  }

  const cmp = compareVersions(version, state.lastApplied);

  if (cmp > 0) {
    // Rule 2: strictly newer — accept
    const nextSeen = new Map(state.seenMessageIds);
    nextSeen.set(messageId, true);
    return {
      state: { lastApplied: version, seenMessageIds: nextSeen },
      result: { result: "accepted" },
    };
  }

  // Rule 3: stale or equal
  // Equal version + different messageId → deduplicated (per spec dedup rule)
  if (cmp === 0) {
    return { state, result: { result: "deduplicated" } };
  }

  // cmp < 0 → stale
  return { state, result: { result: "rejected-stale" } };
}
