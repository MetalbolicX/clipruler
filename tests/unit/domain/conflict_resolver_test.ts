/**
 * Unit tests for domain/conflict-resolver.ts — last-writer-wins conflict resolution.
 * @std/assert required.
 *
 * Spec scenarios:
 *   accept newer:      compareVersions(event.version, lastApplied) > 0  → accepted
 *   reject stale:      compareVersions(event.version, lastApplied) < 0  → rejected-stale
 *   deduplicate equal: compareVersions == 0 AND equal messageId       → deduplicated
 *
 * State:
 *   ResolverState { lastApplied?: Version; seenMessageIds: ReadonlyMap<MessageId, true> }
 *
 * observe() is a pure reducer: returns { state, result }.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import { initResolver, observe } from "../../../src/domain/conflict-resolver.ts";
import { makeDeviceId, makeMessageId } from "../../../src/domain/device.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVersion(
  counter: number,
  deviceId: string,
): { counter: number; deviceId: ReturnType<typeof makeDeviceId> } {
  return { counter, deviceId: makeDeviceId(deviceId) };
}

function makeEvent(
  counter: number,
  deviceId: string,
  messageId: string,
  text = "clip",
) {
  return {
    version: makeVersion(counter, deviceId),
    messageId: makeMessageId(messageId),
    sourceDeviceId: makeDeviceId(deviceId),
    timestamp: 1_700_000_000_000,
    text,
  };
}

// ObserveResult = { result: "accepted" } | { result: "rejected-stale" } | { result: "deduplicated" }
// output.result.result gives us the string tag; cast to suppress strict union widening
function resultTag(output: { result: { result: string } }): string {
  return output.result.result as string;
}

// ---------------------------------------------------------------------------
// initResolver — empty state
// ---------------------------------------------------------------------------

Deno.test("initResolver returns state with no lastApplied and empty seenMessageIds", () => {
  const state = initResolver();
  assertEquals(state.lastApplied, undefined);
  assertEquals(state.seenMessageIds.size, 0);
});

// ---------------------------------------------------------------------------
// Scenario: accept newer
// ---------------------------------------------------------------------------

Deno.test("observe: accepts strictly newer version, updates lastApplied and dedup map", () => {
  const state = initResolver();
  const event = makeEvent(1, "device-a", "msg-1");

  const output = observe(state, event);

  assertEquals(resultTag(output), "accepted");
  assertEquals(output.state.lastApplied?.counter, 1);
  assertEquals(output.state.seenMessageIds.has(event.messageId), true);
  // original state is unchanged (immutable)
  assertEquals(state.seenMessageIds.size, 0);
  assertEquals(state.lastApplied, undefined);
});

Deno.test("observe: accepts next version in a progression (multiple newer events)", () => {
  let state = initResolver();

  // First event: counter 0 → accepted
  const e1 = makeEvent(0, "device-a", "msg-1");
  state = observe(state, e1).state;

  // Second event: counter 1 from same device → accepted (newer)
  const e2 = makeEvent(1, "device-a", "msg-2");
  const r2 = observe(state, e2);
  assertEquals(resultTag(r2), "accepted");
  assertEquals(r2.state.lastApplied?.counter, 1);

  // Third event: counter 2 → accepted
  const e3 = makeEvent(2, "device-a", "msg-3");
  const r3 = observe(state, e3).state;
  assertEquals(resultTag(observe(r3, makeEvent(3, "device-a", "msg-4"))), "accepted");
});

// ---------------------------------------------------------------------------
// Scenario: reject stale
// ---------------------------------------------------------------------------

Deno.test("observe: rejects strictly older version, state unchanged", () => {
  // Start with counter 5
  let state = initResolver();
  state = observe(state, makeEvent(5, "device-a", "msg-new")).state;

  // Try to apply counter 3 → rejected-stale
  const staleEvent = makeEvent(3, "device-a", "msg-old");
  const output = observe(state, staleEvent);

  assertEquals(resultTag(output), "rejected-stale");
  assertEquals(output.state, state); // identical object — immutable
  assertEquals(output.state.lastApplied?.counter, 5);
});

// ---------------------------------------------------------------------------
// Scenario: deduplicate equal version AND equal messageId
// ---------------------------------------------------------------------------

Deno.test("observe: deduplicates when messageId already seen (same event replay)", () => {
  let state = initResolver();
  const event = makeEvent(1, "device-a", "msg-dup");

  state = observe(state, event).state;
  const output = observe(state, event); // same event replayed

  assertEquals(resultTag(output), "deduplicated");
  assertEquals(output.state, state); // identical
});

// ---------------------------------------------------------------------------
// Scenario: deduplicate by messageId (equal version, different messageId)
// ---------------------------------------------------------------------------

Deno.test("observe: deduplicates when version equal but messageId different", () => {
  let state = initResolver();
  // First event at counter 5 with messageId msg-first
  state = observe(state, makeEvent(5, "device-a", "msg-first")).state;

  // Second event same version but different messageId
  const dupEvent = makeEvent(5, "device-a", "msg-second");
  const output = observe(state, dupEvent);

  assertEquals(resultTag(output), "deduplicated");
  assertEquals(output.state.lastApplied?.counter, 5); // still counter 5
  assertEquals(output.state.seenMessageIds.size, 1); // still only one entry
});

// ---------------------------------------------------------------------------
// lastApplied never regresses
// ---------------------------------------------------------------------------

Deno.test("lastApplied never regresses after a series of stale events", () => {
  let state = initResolver();

  // Apply counter 10
  state = observe(state, makeEvent(10, "device-a", "msg-10")).state;
  assertEquals(state.lastApplied?.counter, 10);

  // Many stale events
  for (let c = 0; c < 5; c++) {
    const r = observe(state, makeEvent(c, "device-a", `msg-stale-${c}`));
    assertEquals(resultTag(r), "rejected-stale");
  }

  // Still counter 10
  assertEquals(state.lastApplied?.counter, 10);
});
