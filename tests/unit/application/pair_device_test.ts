/**
 * Unit tests for application/pair-device.ts.
 *
 * Verifies:
 * - Returns not-found when peer not in discovery.visible()
 * - Returns already-paired when fingerprint exists in devices
 * - Returns ok, presents code once, sends one envelope, returns immediately
 * - Payload has no code field (R2.6 security invariant)
 * - localFp derived correctly from base64 SPKI via decodeBase64 -> derivePublicKeyFingerprint
 * - originDeviceId === makeDeviceId(localFp)
 *
 * Layer: unit — uses SpyTransport, FakeDeviceRepository, FakeDiscovery, StubKeyStore.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type { PublicKeyFingerprint } from "../../../src/domain/device.ts";
import { makeDeviceId, makePublicKeyFingerprint } from "../../../src/domain/device.ts";
import { pairWith } from "../../../src/application/pair-device.ts";
import {
  FakeDeviceRepository,
  FakeDiscovery,
  RecordingUi,
  SpyTransport,
  StubKeyStore,
  StubLogger,
} from "./test_doubles.ts";
import type { PeerAdvertisement } from "../../../src/ports/discovery.ts";
import { decodeBase64 } from "@std/encoding/base64";
import { derivePublicKeyFingerprint } from "../../../src/infrastructure/identity/fingerprint.ts";

// Canned 64-char hex fingerprint for the remote peer
const REMOTE_FP = makePublicKeyFingerprint("b".repeat(64));

// Canned base64 SPKI for StubKeyStore — a real Ed25519 public key.
// The derived fingerprint is computed dynamically in tests that need it
// (we do NOT hardcode the SHA-256 because that couples the test to the hash).
const CANNED_BASE64_SPKI = "MCowBQYDK2VwAyEAKCtIuLSiCJVPOuNRJEOQ3JLO1uJxvJXYXbZJ8X5K5Ww=";

// Build a FakeDiscovery with a visible remote peer
function makeVisibleDiscovery(
  remoteFp: PublicKeyFingerprint,
  remoteName = "Remote Device",
): FakeDiscovery {
  const discovery = new FakeDiscovery();
  const advertisement: PeerAdvertisement = {
    name: remoteName,
    publicKeyFingerprint: remoteFp,
    tlsPort: 7341,
    protocolVersion: 1,
  };
  discovery.seed([[
    remoteFp,
    {
      advertisement,
      remoteAddress: "192.168.1.100:7341",
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    },
  ]]);
  return discovery;
}

Deno.test("returns not-found when peer not in discovery.visible()", async () => {
  const devices = new FakeDeviceRepository();
  const discovery = new FakeDiscovery(); // empty — no peers
  const keys = new StubKeyStore();
  const transport = new SpyTransport();
  const ui = new RecordingUi();
  const logger = new StubLogger();

  const result = await pairWith(
    { logger, devices, discovery, keys, transport, ui },
    REMOTE_FP,
    "My Device",
  );

  assertEquals(result.kind, "not-found");
  assertEquals(transport.calls.send.length, 0);
  assertEquals(ui.calls.presentPairingCode.length, 0);
});

Deno.test("returns already-paired when devices.getByFingerprint returns existing", async () => {
  const devices = new FakeDeviceRepository();
  await devices.upsert({
    deviceId: makeDeviceId("existing-id"),
    name: "Already Paired",
    lastEndpoint: null,
    lastSeenAt: null,
    clipboardSharingEnabled: false,
    fingerprint: REMOTE_FP,
    equals(other) {
      return this.deviceId === other.deviceId;
    },
  });
  const discovery = makeVisibleDiscovery(REMOTE_FP);
  const keys = new StubKeyStore();
  const transport = new SpyTransport();
  const ui = new RecordingUi();
  const logger = new StubLogger();

  const result = await pairWith(
    { logger, devices, discovery, keys, transport, ui },
    REMOTE_FP,
    "My Device",
  );

  assertEquals(result.kind, "already-paired");
  assertEquals(transport.calls.send.length, 0);
});

Deno.test("returns ok, presents code once, sends one envelope, returns immediately", async () => {
  const devices = new FakeDeviceRepository();
  const discovery = makeVisibleDiscovery(REMOTE_FP);
  const keys = new StubKeyStore({ publicKeyBase64: CANNED_BASE64_SPKI });
  const transport = new SpyTransport();
  const ui = new RecordingUi();
  const logger = new StubLogger();

  const result = await pairWith(
    { logger, devices, discovery, keys, transport, ui },
    REMOTE_FP,
    "My Device",
  );

  assertEquals(result.kind, "ok");
  assertEquals(ui.calls.presentPairingCode.length, 1);
  assertEquals(transport.calls.send.length, 1);
});

Deno.test("R2.6: sent envelope payload has NO code field", async () => {
  const devices = new FakeDeviceRepository();
  const discovery = makeVisibleDiscovery(REMOTE_FP);
  const keys = new StubKeyStore({ publicKeyBase64: CANNED_BASE64_SPKI });
  const transport = new SpyTransport();
  const ui = new RecordingUi();
  const logger = new StubLogger();

  await pairWith(
    { logger, devices, discovery, keys, transport, ui },
    REMOTE_FP,
    "My Device",
  );

  assertEquals(transport.calls.send.length, 1);
  const sent = transport.calls.send[0]!;
  const envelope = sent.envelope;
  const payload = envelope.payload as Record<string, unknown>;
  assertEquals(Object.prototype.hasOwnProperty.call(payload, "code"), false);
  assertEquals(payload.deviceName, "My Device");
  assertEquals(typeof payload.publicKeyFingerprint, "string");
});

Deno.test("originDeviceId === makeDeviceId(localFp)", async () => {
  const devices = new FakeDeviceRepository();
  const discovery = makeVisibleDiscovery(REMOTE_FP);
  const keys = new StubKeyStore({ publicKeyBase64: CANNED_BASE64_SPKI });
  const transport = new SpyTransport();
  const ui = new RecordingUi();
  const logger = new StubLogger();

  // Compute the expected local fingerprint dynamically from the same canned SPKI.
  // This avoids coupling the assertion to a hardcoded hash value.
  const spkiDer = new Uint8Array(decodeBase64(CANNED_BASE64_SPKI));
  const expectedLocalFpRaw = await derivePublicKeyFingerprint(spkiDer);

  await pairWith(
    { logger, devices, discovery, keys, transport, ui },
    REMOTE_FP,
    "My Device",
  );

  assertEquals(transport.calls.send.length, 1);
  const sent = transport.calls.send[0]!;
  const envelope = sent.envelope;
  assertEquals(envelope.originDeviceId, makeDeviceId(expectedLocalFpRaw));
});
