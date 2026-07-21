/**
 * application/pair-device.ts
 *
 * Initiator-side pairing kickoff use case.
 *
 * Composes discovery, trust lookup, local-key fingerprinting, UI, and the
 * existing pairing-request envelope to kick off a pairing without transmitting
 * the SAS code over the wire.
 *
 * Precondition (B3 from proposal): the composition root (plan 009) has already
 * established a TLS connection to remoteFingerprint. If not, transport.send
 * silently no-ops (tls-tcp.ts:235-239) and the pairing request is dropped.
 *
 * This function does NOT wait for the remote side's confirmation. The full
 * mutual handshake (responder receives pairing-request -> re-derives -> shows
 * -> confirms -> replies pairing-confirm -> persists) is plan 009's job.
 */

import type { DeviceRepository } from "../ports/device-repository.ts";
import type { Discovery } from "../ports/discovery.ts";
import type { KeyStore } from "../ports/key-store.ts";
import type { Transport } from "../ports/transport.ts";
import type { UiPort } from "../ports/ui.ts";
import type { Logger } from "../ports/logger.ts";
import type { PublicKeyFingerprint } from "../domain/device.ts";
import { makeDeviceId, makePublicKeyFingerprint } from "../domain/device.ts";
import { makeEnvelope } from "../protocol/envelope.ts";
import { derivePublicKeyFingerprint } from "../infrastructure/identity/fingerprint.ts";
import { decodeBase64 } from "@std/encoding/base64";
import { derivePairingCode } from "../infrastructure/crypto/pairing-code.ts";

export interface PairDeviceDeps {
  readonly logger: Logger;
  readonly devices: DeviceRepository;
  readonly discovery: Discovery;
  readonly keys: KeyStore;
  readonly transport: Transport;
  readonly ui: UiPort;
}

export type PairOutcome =
  | { readonly kind: "not-found" }
  | { readonly kind: "already-paired" }
  | { readonly kind: "ok" }
  | {
    readonly kind: "error";
    readonly stage: "discovery" | "storage" | "crypto" | "ui" | "transport";
  };

/**
 * Initiator-side pairing kickoff.
 *
 * @param deps - all port dependencies
 * @param remoteFingerprint - the target peer's public-key fingerprint
 * @param localDeviceName - this device's display name for the pairing request
 */
export async function pairWith(
  deps: PairDeviceDeps,
  remoteFingerprint: PublicKeyFingerprint,
  localDeviceName: string,
): Promise<PairOutcome> {
  // R2.1: peer must be visible
  const sighting = deps.discovery.visible().get(remoteFingerprint);
  if (!sighting) return { kind: "not-found" };

  // R2.2: must not already be paired
  const existing = await deps.devices.getByFingerprint(remoteFingerprint);
  if (existing) return { kind: "already-paired" };

  // R2.4: derive local fingerprint from base64 SPKI
  const localMaterial = await deps.keys.getOrCreateLocal();
  const spkiDer = new Uint8Array(decodeBase64(localMaterial.publicKeyBase64));
  const localFpRaw = await derivePublicKeyFingerprint(spkiDer);
  const localFp = makePublicKeyFingerprint(localFpRaw);

  // R2.4: derive expected code from both fingerprints
  const expectedCode = await derivePairingCode(localFp, remoteFingerprint);

  // R2.5: present code to local user exactly once
  await deps.ui.presentPairingCode(expectedCode);

  // R2.6 + R2.7: emit pairing-request with safe branded origin, NO code in payload
  const envelope = makeEnvelope(
    makeDeviceId(localFp),
    "pairing-request",
    { deviceName: localDeviceName, publicKeyFingerprint: localFp },
  );
  await deps.transport.send(remoteFingerprint, envelope);

  // R2.8: do not await confirmation
  return { kind: "ok" };
}
