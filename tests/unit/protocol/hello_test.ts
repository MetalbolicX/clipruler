/**
 * Unit tests for protocol/hello.ts — HelloPayload shape.
 * @std/assert required.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type { HelloPayload } from "../../../src/protocol/hello.ts";

Deno.test("HelloPayload has deviceName and protocolVersion fields", () => {
  const payload: HelloPayload = {
    deviceName: "my-device",
    protocolVersion: 1,
  };
  assertEquals(payload.deviceName, "my-device");
  assertEquals(payload.protocolVersion, 1);
});
