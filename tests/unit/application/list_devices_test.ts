/**
 * Unit tests for application/list-devices.ts.
 *
 * Verifies:
 * - Returns paired (from devices.list) + available (from discovery.visible)
 *   with correct field mapping
 * - reachable cross-reference: paired device in visible() -> true; absent -> false
 * - empty state: no devices, no peers -> { paired: [], available: [] }
 *
 * Layer: unit — uses FakeDeviceRepository, FakeDiscovery.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type { PublicKeyFingerprint } from "../../../src/domain/device.ts";
import { makeDeviceId, makePublicKeyFingerprint } from "../../../src/domain/device.ts";
import { listDevices } from "../../../src/application/list-devices.ts";
import { FakeDeviceRepository, FakeDiscovery } from "./test_doubles.ts";
import type { PeerAdvertisement } from "../../../src/ports/discovery.ts";

const FP1 = makePublicKeyFingerprint("a".repeat(64));
const FP2 = makePublicKeyFingerprint("b".repeat(64));

function makeSighting(
  fp: PublicKeyFingerprint,
  name: string,
  remoteAddress = "192.168.1.100:7341",
  tlsPort = 7341,
) {
  const advertisement: PeerAdvertisement = {
    name,
    publicKeyFingerprint: fp,
    tlsPort,
    protocolVersion: 1,
  };
  return [fp, {
    advertisement,
    remoteAddress,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
  }] as [PublicKeyFingerprint, {
    readonly advertisement: PeerAdvertisement;
    readonly remoteAddress: string;
    readonly firstSeenAt: number;
    readonly lastSeenAt: number;
  }];
}

Deno.test("returns paired + available with correct field mapping", async () => {
  const devices = new FakeDeviceRepository();
  await devices.upsert({
    deviceId: makeDeviceId("dev-1"),
    name: "Paired Device",
    lastEndpoint: "192.168.1.10:7341",
    lastSeenAt: "2026-01-01T00:00:00Z",
    clipboardSharingEnabled: true,
    fingerprint: FP1,
    equals(other) {
      return this.deviceId === other.deviceId;
    },
  });

  const discovery = new FakeDiscovery();
  discovery.seed([makeSighting(FP1, "Paired Device"), makeSighting(FP2, "Visible Device")]);

  const result = await listDevices({ devices, discovery });

  assertEquals(result.paired.length, 1);
  assertEquals(result.paired[0]!.name, "Paired Device");
  assertEquals(result.paired[0]!.sharingEnabled, true);
  assertEquals(result.paired[0]!.fingerprint, FP1);
  assertEquals(result.available.length, 1);
  assertEquals(result.available[0]!.name, "Visible Device");
  assertEquals(result.available[0]!.fingerprint, FP2);
});

Deno.test("reachable cross-reference: paired device in visible() -> true; absent -> false", async () => {
  const devices = new FakeDeviceRepository();
  // Two paired devices: FP1 is visible, FP2 is not
  await devices.upsert({
    deviceId: makeDeviceId("dev-1"),
    name: "Reachable Device",
    lastEndpoint: null,
    lastSeenAt: null,
    clipboardSharingEnabled: false,
    fingerprint: FP1,
    equals(other) {
      return this.deviceId === other.deviceId;
    },
  });
  await devices.upsert({
    deviceId: makeDeviceId("dev-2"),
    name: "Unreachable Device",
    lastEndpoint: null,
    lastSeenAt: null,
    clipboardSharingEnabled: false,
    fingerprint: FP2,
    equals(other) {
      return this.deviceId === other.deviceId;
    },
  });

  const discovery = new FakeDiscovery();
  discovery.seed([makeSighting(FP1, "Reachable Device")]); // only FP1 is visible

  const result = await listDevices({ devices, discovery });

  const reachable = result.paired.find((d) => d.name === "Reachable Device");
  const unreachable = result.paired.find((d) => d.name === "Unreachable Device");
  assertEquals(reachable?.reachable, true);
  assertEquals(unreachable?.reachable, false);
});

Deno.test("empty state: no devices, no peers -> { paired: [], available: [] }", async () => {
  const devices = new FakeDeviceRepository();
  const discovery = new FakeDiscovery(); // empty

  const result = await listDevices({ devices, discovery });

  assertEquals(result.paired.length, 0);
  assertEquals(result.available.length, 0);
});
