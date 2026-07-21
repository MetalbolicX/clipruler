/**
 * Unit tests for domain/pairing.ts — PairState FSM.
 * @std/assert required.
 *
 * FSM spec:
 *   States: NotPaired | Requested | RequestedByPeer | Paired
 *   Events: RequestPairing | PeerRequested | Accept | Revoke
 *
 * 5 valid transitions:
 *   NotPaired → Requested        (RequestPairing)
 *   NotPaired → RequestedByPeer  (PeerRequested)
 *   Requested → Paired           (Accept)
 *   RequestedByPeer → Paired     (Accept)
 *   Paired → NotPaired           (Revoke)
 *
 * Invalid transitions must be rejected.
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0";
import { transition } from "../../../src/domain/pairing.ts";

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

Deno.test("NotPaired + RequestPairing → Requested", () => {
  const result = transition("NotPaired", "RequestPairing");
  assertEquals(result, "Requested");
});

Deno.test("NotPaired + PeerRequested → RequestedByPeer", () => {
  const result = transition("NotPaired", "PeerRequested");
  assertEquals(result, "RequestedByPeer");
});

Deno.test("Requested + Accept → Paired", () => {
  const result = transition("Requested", "Accept");
  assertEquals(result, "Paired");
});

Deno.test("RequestedByPeer + Accept → Paired", () => {
  const result = transition("RequestedByPeer", "Accept");
  assertEquals(result, "Paired");
});

Deno.test("Paired + Revoke → NotPaired", () => {
  const result = transition("Paired", "Revoke");
  assertEquals(result, "NotPaired");
});

// ---------------------------------------------------------------------------
// Invalid transition rejection
// ---------------------------------------------------------------------------

Deno.test("NotPaired + Accept throws", () => {
  assertThrows(() => transition("NotPaired", "Accept"));
});

Deno.test("NotPaired + Revoke throws", () => {
  assertThrows(() => transition("NotPaired", "Revoke"));
});

Deno.test("Requested + RequestPairing throws (duplicate request-while-pending)", () => {
  assertThrows(() => transition("Requested", "RequestPairing"));
});

Deno.test("Requested + PeerRequested throws", () => {
  assertThrows(() => transition("Requested", "PeerRequested"));
});

Deno.test("RequestedByPeer + PeerRequested throws (duplicate peer-request-while-pending)", () => {
  assertThrows(() => transition("RequestedByPeer", "PeerRequested"));
});

Deno.test("RequestedByPeer + RequestPairing throws", () => {
  assertThrows(() => transition("RequestedByPeer", "RequestPairing"));
});

Deno.test("Paired + RequestPairing throws", () => {
  assertThrows(() => transition("Paired", "RequestPairing"));
});

Deno.test("Paired + PeerRequested throws", () => {
  assertThrows(() => transition("Paired", "PeerRequested"));
});

Deno.test("Paired + Accept throws", () => {
  assertThrows(() => transition("Paired", "Accept"));
});
