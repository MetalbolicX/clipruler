# Plan 002: Domain core + wire protocol

> **Executor instructions**: Follow this plan step by step. Every verification is a command with an
> expected result. Honor STOP conditions. Update `plans/README.md` when done.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: 001
- **Category**: feature
- **Planned at**: after 001 lands

## Why this matters

The domain layer is the contract every adapter must satisfy. Writing it pure (no `Deno.*` runtime
imports) makes it instantly testable, deterministic, and portable. The wire protocol is its own
module so transport changes never force business-logic rewrites.

## Current state

After 001: `deno.json` exists, `main.ts` dispatches help, `src/version.ts` exists,
`tests/smoke_test.ts` passes. No domain types, no protocol types.

## Commands you will need

| Purpose    | Command                                                     |
| ---------- | ----------------------------------------------------------- |
| Check      | `deno task check`                                           |
| Test       | `deno task test`                                            |
| Pure check | `deno check src/domain/**/*.ts` (no `Deno.*` usage allowed) |

## Scope

**In scope**:

- `src/domain/device.ts`
- `src/domain/pairing.ts`
- `src/domain/clipboard-event.ts`
- `src/domain/conflict-resolver.ts`
- `src/domain/index.ts` (barrel)
- `src/protocol/envelope.ts`
- `src/protocol/hello.ts`
- `src/protocol/pairing.ts`
- `src/protocol/clipboard-payload.ts`
- `src/protocol/index.ts` (barrel)
- `tests/unit/domain/conflict_resolver_test.ts`
- `tests/unit/domain/pairing_test.ts`

**Out of scope**:

- Any file that imports `Deno.*` runtime symbols.
- Adapters, ports, application, shells (later plans).
- Actual key generation or cert generation (Plan 003).

## Architecture constraints (must hold)

- `src/domain/**` MUST be importable from a non-Deno TypeScript environment in principle. That
  means: no `Deno.*` runtime, no `console.*` side effects except inside explicit helper functions,
  no I/O.
- Branded types for IDs prevent accidental string mixing.
- Value objects are immutable; produce new instances, never mutate.

## Steps

### Step 1: Define branded primitives

Create `src/domain/device.ts`:

```ts
// Branding helper for nominal typing over string.
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type DeviceId = Brand<string, "DeviceId">;
export type MessageId = Brand<string, "MessageId">;
export type PublicKeyFingerprint = Brand<string, "PublicKeyFingerprint">;

export interface DeviceName {
  readonly value: string;
}

export interface Device {
  readonly id: DeviceId;
  readonly name: DeviceName;
  readonly publicKeyFingerprint: PublicKeyFingerprint;
  readonly protocolVersion: number;
}
```

**Verify**: `deno check src/domain/device.ts` exits 0.

### Step 2: Pairing state machine

Create `src/domain/pairing.ts`:

```ts
export type PairState =
  | { kind: "NotPaired" }
  | { kind: "Requested"; initiator: "Local" | "Remote"; code: PairingCode }
  | { kind: "RequestedByPeer"; code: PairingCode }
  | { kind: "Paired" };

export type PairingCode = Brand<string, "PairingCode">;

export function startPairing(code: PairingCode): PairState {
  return { kind: "Requested", initiator: "Local", code };
}

export function receivePairingRequest(code: PairingCode): PairState {
  return { kind: "RequestedByPeer", code };
}

export function confirmPairing(state: PairState): PairState {
  if (state.kind === "NotPaired") {
    throw new Error("Cannot confirm pairing from NotPaired state");
  }
  if (state.kind === "Paired") return state;
  return { kind: "Paired" };
}

export function cancelPairing(_state: PairState): PairState {
  return { kind: "NotPaired" };
}

// Re-export the Brand helper locally for the PairingCode alias above.
import type { Brand } from "./device.ts";
```

> Note: TypeScript hoists type-only imports, so the trailing `import type` is legal. If the linter
> rejects it, move the import to the top of the file.

**Verify**: `deno check src/domain/pairing.ts` exits 0.

### Step 3: Clipboard event + version

Create `src/domain/clipboard-event.ts`:

```ts
import type { DeviceId, MessageId } from "./device.ts";

export type LogicalCounter = number;

// Deterministic ordering: higher counter wins; ties broken by deviceId so
// every peer converges on the same winner regardless of arrival order.
export interface Version {
  readonly counter: LogicalCounter;
  readonly deviceId: DeviceId;
}

export interface ClipboardEvent {
  readonly messageId: MessageId;
  readonly origin: DeviceId;
  readonly version: Version;
  readonly content: string;
  readonly isPassword: boolean;
}

export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.deviceId === b.deviceId) return 0;
  return a.deviceId < b.deviceId ? -1 : 1;
}
```

**Verify**: `deno check src/domain/clipboard-event.ts` exits 0.

### Step 4: Conflict resolver

Create `src/domain/conflict-resolver.ts`:

```ts
import type { ClipboardEvent, Version } from "./clipboard-event.ts";
import type { MessageId } from "./device.ts";

export interface ResolverState {
  readonly current: ClipboardEvent | null;
  readonly seenMessageIds: ReadonlySet<MessageId>;
}

export function initResolver(): ResolverState {
  return { current: null, seenMessageIds: new Set() };
}

export interface ResolveResult {
  readonly state: ResolverState;
  readonly accepted: boolean;
  readonly reason:
    | "accepted-newer"
    | "accepted-first"
    | "rejected-duplicate"
    | "rejected-stale";
}

export function observe(
  state: ResolverState,
  incoming: ClipboardEvent,
  localDeviceId: import("./device.ts").DeviceId,
): ResolveResult {
  if (state.seenMessageIds.has(incoming.messageId)) {
    return { state, accepted: false, reason: "rejected-duplicate" };
  }
  // Never accept our own origin echo.
  if (incoming.origin === localDeviceId) {
    return { state, accepted: false, reason: "rejected-duplicate" };
  }

  const nextSeen = new Set(state.seenMessageIds);
  nextSeen.add(incoming.messageId);

  if (state.current === null) {
    return {
      state: { current: incoming, seenMessageIds: nextSeen },
      accepted: true,
      reason: "accepted-first",
    };
  }

  // Last-writer-wins: incoming must be strictly greater than current.
  if (
    compareVersionsScalar(incoming.version, state.current.version) <= 0
  ) {
    return {
      state: { current: state.current, seenMessageIds: nextSeen },
      accepted: false,
      reason: "rejected-stale",
    };
  }

  return {
    state: { current: incoming, seenMessageIds: nextSeen },
    accepted: true,
    reason: "accepted-newer",
  };
}

// Local copy of compareVersions to avoid a circular-feeling import; if the
// linter accepts importing from clipboard-event.ts directly, prefer that.
function compareVersionsScalar(
  a: Version,
  b: Version,
): -1 | 0 | 1 {
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.deviceId === b.deviceId) return 0;
  return a.deviceId < b.deviceId ? -1 : 1;
}

type Version = import("./clipboard-event.ts").Version;
```

> Refactor opportunity for the executor: move `compareVersions` into `clipboard-event.ts` and import
> it. The duplication above is intentional to keep the plan self-contained.

**Verify**: `deno check src/domain/conflict-resolver.ts` exits 0.

### Step 5: Domain barrel

Create `src/domain/index.ts` re-exporting the public surface.

**Verify**: `deno check src/domain/index.ts` exits 0.

### Step 6: Wire protocol — envelope

Create `src/protocol/envelope.ts`:

```ts
// Bumped on incompatible wire changes. Peers with different majors reject.
export const PROTOCOL_VERSION = 1 as const;

export type EnvelopeKind =
  | "hello"
  | "pairing.request"
  | "pairing.confirm"
  | "pairing.cancel"
  | "clipboard.event"
  | "control.bye";

export interface Envelope<TPayload> {
  readonly v: typeof PROTOCOL_VERSION;
  readonly kind: EnvelopeKind;
  readonly originDeviceId: string;
  readonly messageId: string;
  readonly payload: TPayload;
}

export function makeEnvelope<TPayload>(
  kind: EnvelopeKind,
  originDeviceId: string,
  messageId: string,
  payload: TPayload,
): Envelope<TPayload> {
  return { v: PROTOCOL_VERSION, kind, originDeviceId, messageId, payload };
}
```

**Verify**: `deno check src/protocol/envelope.ts` exits 0.

### Step 7: Payload types

Create `src/protocol/hello.ts`, `src/protocol/pairing.ts`, and `src/protocol/clipboard-payload.ts`:

```ts
// src/protocol/hello.ts
export interface HelloPayload {
  readonly name: string;
  readonly protocolVersion: number;
  readonly publicKeyFingerprint: string;
}

// src/protocol/pairing.ts
export interface PairingRequestPayload {
  readonly code: string; // short shared code
  readonly proverFingerprint: string;
}

export interface PairingConfirmPayload {
  readonly code: string;
}

// src/protocol/clipboard-payload.ts
export interface ClipboardPayload {
  readonly content: string;
  readonly isPassword: boolean;
  readonly version: { counter: number; deviceId: string };
}
```

Create `src/protocol/index.ts` barrel.

**Verify**: `deno check src/protocol/**/*.ts` exits 0.

### Step 8: Unit tests for the resolver

Create `tests/unit/domain/conflict_resolver_test.ts`:

```ts
import { assert, assertEquals } from "@std/testing/asserts";
import { initResolver, observe } from "../../../src/domain/conflict-resolver.ts";
import type { ClipboardEvent } from "../../../src/domain/clipboard-event.ts";
import type { DeviceId, MessageId } from "../../../src/domain/device.ts";

const localId = "device-local" as DeviceId;
const remoteA = "device-A" as DeviceId;
const remoteB = "device-B" as DeviceId;

function ev(
  origin: DeviceId,
  counter: number,
  deviceId: DeviceId,
  messageId: string,
): ClipboardEvent {
  return {
    messageId: messageId as MessageId,
    origin,
    version: { counter, deviceId },
    content: `c-${counter}-${deviceId}`,
    isPassword: false,
  };
}

Deno.test({
  name: "first event is accepted",
  fn() {
    let s = initResolver();
    const r = observe(s, ev(remoteA, 1, remoteA, "m1"), localId);
    assertEquals(r.accepted, true);
    assertEquals(r.reason, "accepted-first");
    assert(r.state.current !== null);
  },
});

Deno.test({
  name: "newer counter wins",
  fn() {
    let s = initResolver();
    s = observe(s, ev(remoteA, 1, remoteA, "m1"), localId).state;
    const r = observe(s, ev(remoteB, 5, remoteB, "m2"), localId);
    assertEquals(r.accepted, true);
    assertEquals(r.reason, "accepted-newer");
  },
});

Deno.test({
  name: "same messageId is duplicate",
  fn() {
    let s = initResolver();
    s = observe(s, ev(remoteA, 1, remoteA, "m1"), localId).state;
    const r = observe(s, ev(remoteA, 1, remoteA, "m1"), localId);
    assertEquals(r.accepted, false);
    assertEquals(r.reason, "rejected-duplicate");
  },
});

Deno.test({
  name: "stale event is rejected",
  fn() {
    let s = initResolver();
    s = observe(s, ev(remoteB, 5, remoteB, "m2"), localId).state;
    const r = observe(s, ev(remoteA, 1, remoteA, "m1"), localId);
    assertEquals(r.accepted, false);
    assertEquals(r.reason, "rejected-stale");
  },
});

Deno.test({
  name: "tie on counter is broken by deviceId",
  fn() {
    let s = initResolver();
    s = observe(s, ev(remoteB, 3, remoteB, "mB"), localId).state;
    // remoteA < remoteB lexically, so A is stale.
    const r = observe(s, ev(remoteA, 3, remoteA, "mA"), localId);
    assertEquals(r.accepted, false);
    assertEquals(r.reason, "rejected-stale");
  },
});

Deno.test({
  name: "origin echo from local device is rejected",
  fn() {
    const s = initResolver();
    const r = observe(s, ev(localId, 9, localId, "self"), localId);
    assertEquals(r.accepted, false);
    assertEquals(r.reason, "rejected-duplicate");
  },
});
```

### Step 9: Unit tests for pairing state machine

Create `tests/unit/domain/pairing_test.ts` covering: NotPaired → Requested → Paired, NotPaired →
RequestedByPeer → Paired, Paired → Paired (idempotent), confirm from NotPaired throws, cancel
returns NotPaired.

**Verify**: `deno task test` runs and all new tests pass.

## Test plan

- `tests/unit/domain/conflict_resolver_test.ts` — 6 tests (see step 8).
- `tests/unit/domain/pairing_test.ts` — at least 5 tests covering state transitions.
- No tests under `domain/` may use `Deno.readFileSync`, network, or timers.

## Done criteria

ALL must hold:

- [ ] `deno task check` exits 0
- [ ] `deno lint` exits 0
- [ ] `deno task test` exits 0; at least 11 domain tests pass (6 resolver + 5 pairing)
- [ ] `grep -rn "Deno\." src/domain/` returns zero matches (excluding type-only positions)
- [ ] `src/domain/` and `src/protocol/` exist with the files listed in scope
- [ ] No third-party imports outside `@std/testing/asserts`
- [ ] `plans/README.md` status row for 002 updated

## STOP conditions

Stop and report if:

- The TypeScript compiler rejects the inline `import("...")` type syntax in `conflict-resolver.ts`.
  Refactor to a top-level `import type` instead.
- `@std/testing` does not export `assert` or `assertEquals` in the resolved version — pin a working
  version in `deno.json` and note it.
- The linter flags the trailing `import type` in `pairing.ts`; move it to the top of the file.

## Maintenance notes

- `compareVersions` is currently in `clipboard-event.ts` and duplicated as `compareVersionsScalar`
  in `conflict-resolver.ts`. The duplication is intentional for plan self-containment; remove it in
  a follow-up.
- When Plan 003 introduces real key fingerprints, the protocol's `publicKeyFingerprint` field type
  stays as `string` on the wire but the domain uses the branded `PublicKeyFingerprint` type.
- `PROTOCOL_VERSION` is the bump lever for the wire format; any breaking change here requires a Plan
  amendment.
