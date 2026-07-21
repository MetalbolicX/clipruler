/**
 * Unit tests for protocol/pairing.ts — PairingRequestPayload and PairingConfirmPayload.
 * @std/assert required.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type {
  PairingConfirmPayload,
  PairingRequestPayload,
} from "../../../src/protocol/pairing.ts";

Deno.test("PairingRequestPayload carries deviceName and publicKeyFingerprint", () => {
  const payload: PairingRequestPayload = {
    deviceName: "peer-device",
    publicKeyFingerprint: "deadbeef",
  };
  assertEquals(payload.deviceName, "peer-device");
  assertEquals(payload.publicKeyFingerprint, "deadbeef");
});

Deno.test("PairingConfirmPayload carries status and optional peerDeviceId", () => {
  const accepted: PairingConfirmPayload = {
    status: "accepted",
    peerDeviceId: "device-abc",
  };
  assertEquals(accepted.status, "accepted");
  assertEquals(accepted.peerDeviceId, "device-abc");
});

Deno.test("PairingConfirmPayload rejected has no peerDeviceId", () => {
  const rejected: PairingConfirmPayload = {
    status: "rejected",
  };
  assertEquals(rejected.status, "rejected");
  assertEquals(rejected.peerDeviceId, undefined);
});
