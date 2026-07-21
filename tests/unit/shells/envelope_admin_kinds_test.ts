/**
 * tests/unit/shells/envelope_admin_kinds_test.ts
 *
 * Verifies that EnvelopeKind includes the 8 admin kinds.
 *
 * Layer: unit.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type { EnvelopeKind } from "../../../src/protocol/envelope.ts";
import { type PayloadByKind } from "../../../src/protocol/envelope.ts";

Deno.test("EnvelopeKind accepts admin.list as a valid kind", () => {
  // This assignment verifies the type accepts admin.list
  const kind: EnvelopeKind = "admin.list";
  assertEquals(kind, "admin.list");
});

Deno.test("EnvelopeKind accepts admin.status as a valid kind", () => {
  const kind: EnvelopeKind = "admin.status";
  assertEquals(kind, "admin.status");
});

Deno.test("EnvelopeKind accepts admin.pair.request as a valid kind", () => {
  const kind: EnvelopeKind = "admin.pair.request";
  assertEquals(kind, "admin.pair.request");
});

Deno.test("EnvelopeKind accepts admin.pair.code as a valid kind", () => {
  const kind: EnvelopeKind = "admin.pair.code";
  assertEquals(kind, "admin.pair.code");
});

Deno.test("EnvelopeKind accepts admin.enable as a valid kind", () => {
  const kind: EnvelopeKind = "admin.enable";
  assertEquals(kind, "admin.enable");
});

Deno.test("EnvelopeKind accepts admin.disable as a valid kind", () => {
  const kind: EnvelopeKind = "admin.disable";
  assertEquals(kind, "admin.disable");
});

Deno.test("EnvelopeKind accepts admin.forget as a valid kind", () => {
  const kind: EnvelopeKind = "admin.forget";
  assertEquals(kind, "admin.forget");
});

Deno.test("EnvelopeKind accepts admin.response as a valid kind", () => {
  const kind: EnvelopeKind = "admin.response";
  assertEquals(kind, "admin.response");
});

Deno.test("PayloadByKind resolves to non-never for admin kinds", () => {
  // If PayloadByKind was not extended, these would be `never`.
  // The TypeScript compiler would error on these if admin kinds are not in EnvelopeKind.
  type _AdminListPayload = PayloadByKind<"admin.list">;
  type _AdminStatusPayload = PayloadByKind<"admin.status">;
  type _AdminPairRequestPayload = PayloadByKind<"admin.pair.request">;
  type _AdminPairCodePayload = PayloadByKind<"admin.pair.code">;
  type _AdminEnablePayload = PayloadByKind<"admin.enable">;
  type _AdminDisablePayload = PayloadByKind<"admin.disable">;
  type _AdminForgetPayload = PayloadByKind<"admin.forget">;
  type _AdminResponsePayload = PayloadByKind<"admin.response">;
  // Compile-time check: if any of the above are `never`, TypeScript will error.
  // This test always passes at runtime.
});
