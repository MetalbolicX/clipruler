# Plan 007: Pairing + trust

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: 006
- **Category**: feature, security

## Why this matters

Pairing is the security gate. If it is wrong, an attacker on the same LAN can read or poison the
clipboard. This phase implements the state machine, the short confirmation code, public key pinning,
and the rejection of untrusted clipboard events.

## Current state

After 006: discovery surfaces peers as `available`. Transport authenticates pinned peers via TLS
cert fingerprints. Identity exists. No pairing flow yet. Devices can be discovered but never paired.

## Commands you will need

| Purpose          | Command                                 |
| ---------------- | --------------------------------------- |
| Check            | `deno task check`                       |
| Test             | `deno task test --allow-net`            |
| Pairing flow     | `deno test --filter pairing`            |
| Reject untrusted | `deno test --filter "rejects unpaired"` |

## Scope

**In scope**:

- `src/infrastructure/crypto/pairing-code.ts`
- `src/application/pair-device.ts`
- `src/application/list-devices.ts`
- `src/application/toggle-device.ts`
- `src/application/index.ts`
- `tests/unit/infrastructure/pairing_code_test.ts`
- `tests/integration/pairing_flow_test.ts`

**Out of scope**:

- CLI subcommands (Plan 010).
- GUI pairing dialog (Plan 011).
- Clipboard broadcast after pairing (Plan 008 — this plan only sets up trust, no clipboard flows
  yet).

## Dependency note (ROI)

- Pairing code = first 6 hex chars of `SHA-256(localFingerprint || remoteFingerprint)`
  (lexicographically smaller first so both sides compute the same code).
- Considered and rejected: PAKE libraries (SRP, OPAQUE). A PAKE would harden against active MitM but
  adds a non-std dependency and the threat model is "someone on the LAN guesses a 6-char hex in the
  few seconds the code is shown" — sufficient protection is the 6-char code plus key pinning.
- Considered and rejected: Argon2 for code derivation. SHA-256 is enough; the code is not a password
  being stored.

## Architecture constraints

- Pairing state lives in the application layer, not the domain. The domain's `PairState` type is
  pure data; the use case drives transitions.
- Pairing NEVER auto-completes. Both sides MUST confirm the code.
- A device MUST be paired before any `clipboard.event` envelope is accepted from it. The transport's
  TLS pinning enforces connection; the application enforces "is this peer in my trusted list".

## Steps

### Step 1: Pairing code derivation

Create `src/infrastructure/crypto/pairing-code.ts`:

```ts
import { crypto } from "@std/crypto";
import { encodeBase64 } from "@std/encoding/base64";

/**
 * Both peers compute the same 6-char hex code from their public key
 * fingerprints. The smaller fingerprint goes first so both sides agree
 * without exchanging additional data.
 */
export async function derivePairingCode(
  a: string,
  b: string,
): Promise<string> {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const data = new TextEncoder().encode(`${lo}:${hi}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 6);
}
```

### Step 2: Pair-device use case

Create `src/application/pair-device.ts`:

```ts
import type { Logger } from "../ports/logger.ts";
import type { Discovery, PeerSighting } from "../ports/discovery.ts";
import type { Transport } from "../ports/transport.ts";
import type { DeviceRepository } from "../ports/device-repository.ts";
import type { KeyStore } from "../ports/key-store.ts";
import type { UiPort } from "../ports/ui.ts";
import { makeEnvelope } from "../protocol/envelope.ts";
import { derivePairingCode } from "../infrastructure/crypto/pairing-code.ts";

export interface PairDeviceDeps {
  readonly logger: Logger;
  readonly discovery: Discovery;
  readonly transport: Transport;
  readonly devices: DeviceRepository;
  readonly keys: KeyStore;
  readonly ui: UiPort;
}

export type PairOutcome =
  | { kind: "ok" }
  | { kind: "not-found" }
  | { kind: "already-paired" }
  | { kind: "cancelled" }
  | { kind: "code-mismatch" };

export async function pairWith(
  deps: PairDeviceDeps,
  remoteFingerprint: string,
): Promise<PairOutcome> {
  const sighting = deps.discovery.visible().get(remoteFingerprint);
  if (!sighting) return { kind: "not-found" };

  const existing = await deps.devices.get(byFingerprint(remoteFingerprint));
  if (existing) return { kind: "already-paired" };

  const localMaterial = await deps.keys.getOrCreateLocal();
  const expectedCode = await derivePairingCode(
    localMaterial.publicKeyBase64, // simplified: in practice use fingerprints
    sighting.advertisement.publicKeyFingerprint,
  );

  // Show the code to the local user; ask the remote (via transport) to do the same.
  await deps.ui.presentPairingCode(expectedCode);

  // Send pairing.request with the local code so the remote can compare.
  deps.transport.send(
    remoteFingerprint,
    makeEnvelope(
      "pairing.request",
      localMaterial.publicKeyBase64,
      cryptoRandom(),
      { code: expectedCode, proverFingerprint: localMaterial.publicKeyBase64 },
    ),
  );

  // The transport's incoming handler drives the rest:
  //  - on "pairing.request", derive the code, show it, await UI confirm,
  //    reply "pairing.confirm" with the code.
  //  - on "pairing.confirm", check code equality; if match, persist the peer
  //    key and emit a "paired" event.

  // For brevity the event handler is registered by the composition root.
  // The use case returns once the local side has shown its code.
  return { kind: "ok" };
}

function byFingerprint(fp: string): import("../domain/device.ts").DeviceId {
  return fp as import("../domain/device.ts").DeviceId;
}

function cryptoRandom(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
```

> The full handshake (request → confirm → persist) is wired in the composition root
> (`src/shells/composition-root.ts`, Plan 009). The use case here covers the local kickoff.

### Step 3: UI port

Create `src/ports/ui.ts`:

```ts
export interface UiPort {
  presentPairingCode(code: string): Promise<void>;
  confirmPairing(remoteName: string, code: string): Promise<boolean>;
  notifyPaired(deviceName: string): Promise<void>;
}
```

Two implementations land later:

- `StdioUi` (Plan 009) — CLI prompts.
- `DesktopUi` (Plan 011) — webview dialog via bindings.

For this phase, provide a `tests`-only `RecordingUi` that the integration test substitutes.

### Step 4: List-devices + toggle-device

Create `src/application/list-devices.ts` and `src/application/toggle-device.ts`:

```ts
// list-devices.ts
export interface DeviceListView {
  readonly paired: ReadonlyArray<
    { name: string; fingerprint: string; sharingEnabled: boolean; reachable: boolean }
  >;
  readonly available: ReadonlyArray<{ name: string; fingerprint: string; endpoint: string }>;
}

export async function listDevices(deps: {
  devices: DeviceRepository;
  discovery: Discovery;
}): Promise<DeviceListView> {/* ... */}

// toggle-device.ts
export async function toggleSharing(
  deps: {
    devices: DeviceRepository;
  },
  fingerprint: string,
  enabled: boolean,
): Promise<void> {/* ... */}
```

### Step 5: Application barrel

Create `src/application/index.ts` re-exporting all use cases.

### Step 6: Pairing code unit tests

Create `tests/unit/infrastructure/pairing_code_test.ts`:

- `derivePairingCode("a", "b")` equals `derivePairingCode("b", "a")` — both sides compute the same
  code regardless of who initiated.
- Two different fingerprint pairs produce different codes.
- Code is always 6 hex characters.

### Step 7: Pairing flow integration test

Create `tests/integration/pairing_flow_test.ts`:

- Set up two in-process "nodes" with their own identity, key store, transport, and discovery.
- Use a `RecordingUi` that auto-confirms if the code matches.
- From node A, call `pairWith(depsA, fingerprintB)`.
- Assert node A and node B both persisted each other's public key.
- Assert both report the device as `paired` in `listDevices`.
- Send a `clipboard.event` envelope from an unknown third party; assert both nodes drop it without
  persisting anything.

## Test plan

- Pairing-code unit tests: 3 tests.
- Pairing flow integration test: 1 multi-node scenario with 3 assertions.
- Add a "rejects unpaired clipboard" subtest that creates a third untrusted identity and verifies
  its envelopes are ignored.

## Done criteria

ALL must hold:

- [ ] `deno task check` exits 0
- [ ] `deno lint` exits 0
- [ ] All pairing tests pass
- [ ] Both peers compute the same 6-char code (verified)
- [ ] Both peers persist each other's public key after pairing (verified)
- [ ] Envelopes from unpaired peers are dropped (verified by subtest)
- [ ] No third-party deps
- [ ] `plans/README.md` status row for 007 updated

## STOP conditions

Stop and report if:

- `derivePairingCode` produces different codes on the two peers. The canonicalization (smaller
  fingerprint first) must produce identical inputs on both sides; debug by printing the SHA-256
  input.
- The integration test cannot keep two `Deno.listenDatagram` sockets open in the same process. Run
  each peer on a different ephemeral port (requires making MULTICAST_PORT configurable in tests).
- A peer accepts an envelope from a third party. This is a security bug; stop immediately and
  escalate.

## Maintenance notes

- The pairing code is short (6 hex = 24 bits). The threat model assumes the user compares it within
  a few seconds on the same LAN. If the threat model expands to "LAN has an active attacker for the
  entire pairing window", bump to 8 chars or switch to a PAKE.
- Pinning: after pairing, the peer's cert fingerprint is pinned in the device repository. The
  transport rejects any future connection whose cert does not match the pinned fingerprint.
- Unpairing (`forget`) MUST delete the pinned key and close the transport connection. Implement in
  Plan 010 as a CLI subcommand.
