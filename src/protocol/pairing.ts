/**
 * protocol/pairing.ts
 *
 * Wire-format pairing payloads — pairing request and confirmation.
 * No Deno.* imports.
 */

export type PairingRequestPayload = {
  /** Human-readable device name for pairing confirmation. */
  readonly deviceName: string;
  /** Public key fingerprint for secure pairing verification. */
  readonly publicKeyFingerprint: string;
};

export type PairingConfirmPayload = {
  /** Outcome of the pairing request. */
  readonly status: "accepted" | "rejected";
  /** Present only when status is "accepted". */
  readonly peerDeviceId?: string;
};
