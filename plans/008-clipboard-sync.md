# Plan 008: Clipboard sync end-to-end

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 007
- **Category**: feature

## Why this matters

This phase wires the clipboard adapter, logical clock, conflict resolver, and transport into the two
use cases that actually move text between devices. It also enforces the per-device opt-in and
prevents the classic "copy echo loop".

## Current state

After 007: pairing works, peers are trusted, devices can be listed and toggled. No clipboard events
flow yet. The conflict resolver exists as a pure function but has no incoming data.

## Commands you will need

| Purpose   | Command                               |
| --------- | ------------------------------------- |
| Check     | `deno task check`                     |
| Test      | `deno task test --allow-net`          |
| Sync test | `deno test --filter "clipboard sync"` |

## Scope

**In scope**:

- `src/application/sync-clipboard.ts`
- `src/application/receive-clipboard.ts`
- `src/infrastructure/clock/persistent-clock.ts` (implements `LogicalClock`)
- `src/infrastructure/logging/sync-logger.ts` (optional helper)
- `tests/integration/clipboard_sync_test.ts`

**Out of scope**:

- Daemon process lifecycle (Plan 009).
- CLI/GUI surfaces (Plans 010/011).

## Architecture constraints

- Local clipboard changes are observed via `ClipboardAdapter.subscribe`. Every notification: tick
  the clock, build a `ClipboardEvent`, broadcast via `Transport.broadcast` to all paired peers with
  `clipboardSharingEnabled`.
- Remote events arrive via `Transport.subscribe`. Each event: verify the origin is paired, run the
  resolver, write to the local clipboard via the adapter (unless the event originated from us),
  update the logical clock.
- Loop prevention: the resolver already drops events whose `origin` equals the local device id, AND
  drops events with a messageId we have seen. Additionally, the `write` call we make for a remote
  event is tracked so we do not re-emit it from our own subscriber.

## Steps

### Step 1: Persistent logical clock

Create `src/infrastructure/clock/persistent-clock.ts`:

```ts
import type { LogicalClock } from "../../ports/logical-clock.ts";
import type { DeviceId } from "../../domain/device.ts";
import type { Logger } from "../../ports/logger.ts";

/**
 * The counter is persisted inside state.json (StateFileV1.logicalCounter).
 * On each tick we update the store; on observe(remote) we advance to
 * max(local, remote) + 0 (Lamport: max + 1).
 */
export class PersistentClock implements LogicalClock {
  constructor(
    public readonly deviceId: DeviceId,
    private counter: number,
    private readonly sink: (next: number) => Promise<void>,
    private readonly logger: Logger,
  ) {}

  async tick(): Promise<number> {
    this.counter += 1;
    await this.sink(this.counter);
    return this.counter;
  }

  async observe(remote: number): Promise<void> {
    if (remote > this.counter) {
      this.counter = remote;
      await this.sink(this.counter);
    }
  }
}
```

> The sink callback calls `StateStore.save` with an updated `logicalCounter`. To avoid a disk write
> on every clipboard copy, debounce in the composition root (e.g. save at most once per second,
> force-save on shutdown signal).

### Step 2: Sync-clipboard use case (local → remote)

Create `src/application/sync-clipboard.ts`:

```ts
import type { Logger } from "../ports/logger.ts";
import type { ClipboardAdapter, ClipboardContent } from "../ports/clipboard-adapter.ts";
import type { LogicalClock } from "../ports/logical-clock.ts";
import type { Transport } from "../ports/transport.ts";
import type { DeviceRepository } from "../ports/device-repository.ts";
import type { DeviceId, MessageId } from "../domain/device.ts";
import { makeEnvelope } from "../protocol/envelope.ts";

export interface SyncClipboardDeps {
  readonly logger: Logger;
  readonly clipboard: ClipboardAdapter;
  readonly clock: LogicalClock;
  readonly transport: Transport;
  readonly devices: DeviceRepository;
}

export function startLocalSync(deps: SyncClipboardDeps): () => void {
  return deps.clipboard.subscribe(async (content) => {
    // Defensive: ignore empty copies (some platforms emit spurious events).
    if (content.text.length === 0) return;

    const counter = await deps.clock.tick();
    const messageId = randomId() as MessageId;
    const payload = {
      content: content.text,
      isPassword: content.isPassword,
      version: { counter, deviceId: deps.clock.deviceId },
    };
    deps.transport.broadcast(makeEnvelope(
      "clipboard.event",
      deps.clock.deviceId as unknown as string,
      messageId as unknown as string,
      payload,
    ));
  });
}

function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
```

### Step 3: Receive-clipboard use case (remote → local)

Create `src/application/receive-clipboard.ts`:

```ts
import type { Logger } from "../ports/logger.ts";
import type { ClipboardAdapter } from "../ports/clipboard-adapter.ts";
import type { Transport } from "../ports/transport.ts";
import type { DeviceRepository } from "../ports/device-repository.ts";
import type { KeyStore } from "../ports/key-store.ts";
import type { DeviceId, MessageId } from "../domain/device.ts";
import type { Envelope } from "../protocol/envelope.ts";
import { initResolver, observe } from "../domain/conflict-resolver.ts";
import type { ClipboardEvent } from "../domain/clipboard-event.ts";

export interface ReceiveClipboardDeps {
  readonly logger: Logger;
  readonly clipboard: ClipboardAdapter;
  readonly transport: Transport;
  readonly devices: DeviceRepository;
  readonly keys: KeyStore;
  readonly localDeviceId: DeviceId;
}

export function startRemoteReceiver(deps: ReceiveClipboardDeps): () => void {
  let resolver = initResolver();
  // Track writes we just made so our own subscriber does not re-emit them.
  const suppressFor = new Set<MessageId>();
  let suppressTimer: number | null = null;

  const unsubscribeTransport = deps.transport.subscribe(async (env) => {
    if (env.kind !== "clipboard.event") return;

    // 1. Trust check: origin must be a paired peer.
    const paired = await deps.devices.list();
    const isTrusted = paired.some((d) => d.id === env.originDeviceId as unknown as DeviceId);
    if (!isTrusted) {
      deps.logger.warn("dropping event from unpaired peer", { origin: env.originDeviceId });
      return;
    }
    const sharingEnabled = paired.find((d) => d.id === env.originDeviceId as unknown as DeviceId)
      ?.clipboardSharingEnabled ?? false;
    if (!sharingEnabled) return;

    // 2. Map envelope to domain event.
    const payload = env.payload as {
      content: string;
      isPassword: boolean;
      version: { counter: number; deviceId: string };
    };
    const event: ClipboardEvent = {
      messageId: env.messageId as MessageId,
      origin: env.originDeviceId as unknown as DeviceId,
      version: {
        counter: payload.version.counter,
        deviceId: payload.version.deviceId as DeviceId,
      },
      content: payload.content,
      isPassword: payload.isPassword,
    };

    // 3. Conflict resolution.
    const result = observe(resolver, event, deps.localDeviceId);
    resolver = result.state;
    if (!result.accepted) {
      deps.logger.debug("rejected event", { reason: result.reason });
      return;
    }

    // 4. Apply locally (suppress the echo).
    suppressFor.add(event.messageId);
    if (suppressTimer === null) {
      suppressTimer = setTimeout(() => {
        suppressFor.clear();
        suppressTimer = null;
      }, 2_000);
    }
    await deps.clipboard.write({ text: event.content, isPassword: event.isPassword });
  });

  // The sync-clipboard subscriber must check suppressFor before broadcasting.
  // This requires the composition root to share suppressFor between both use
  // cases — OR, simpler: rely on the resolver's origin-echo rejection. Since
  // our own writes go through our adapter, the next subscriber fire carries
  // our own deviceId as origin echo and is rejected.

  return () => {
    unsubscribeTransport();
  };
}
```

> The simpler "origin echo" path is sufficient because every broadcast includes
> `originDeviceId = localDeviceId`, and our subscriber's broadcast will eventually echo back to us —
> at which point the resolver rejects it. The `suppressFor` set is a fast-path optimization to avoid
> a round-trip; keep it but do not depend on it for correctness.

### Step 4: Sync integration test

Create `tests/integration/clipboard_sync_test.ts`:

- Two in-process nodes with paired identities (reuse the harness from Plan 007).
- Use a `RecordingClipboard` (in-memory implementation of the port) on both.
- Node A's adapter writes `"hello"`.
- Assert node B's adapter read returns `"hello"` within 2 seconds.
- Node B writes `"world"`; assert node A sees `"world"`.
- Write `"hello"` again on node A; assert node B's content is `"hello"` and there was exactly one
  broadcast per change (count outgoing envelopes).
- Disable sharing on node B's view of node A; copy on node A; assert node B does not see it.

### Step 5: Verify no loop

Add a regression assertion in the same test:

- After 10 alternating writes between the two nodes, assert the transport counters show
  `10 outgoing` events total (5 from each), not 20+ (which would indicate an echo loop).

## Test plan

- 1 integration scenario with 6 assertions (initial sync, reverse sync, idempotent re-copy, opt-out,
  loop counter, paired-only acceptance).

## Done criteria

ALL must hold:

- [ ] `deno task check` exits 0
- [ ] `deno lint` exits 0
- [ ] The clipboard sync integration test passes consistently (5 consecutive runs)
- [ ] No echo loop after 10 alternating writes (outgoing envelope count == 10)
- [ ] Events from non-paired peers are dropped
- [ ] Per-device opt-out is respected
- [ ] No third-party deps
- [ ] `plans/README.md` status row for 008 updated

## STOP conditions

Stop and report if:

- The echo loop test fails. The resolver's origin-echo rejection must catch our own writes; if not,
  the composition root is mis-wired. Debug before adding more suppressors.
- The logical counter is not persisted across daemon restarts. Verify `StateFileV1.logicalCounter`
  is updated and reloaded; do not paper over with an in-memory counter.
- The 2s wait for cross-node sync flakes. The beacon interval is 2s; the test should wait up to 5s
  before failing.

## Maintenance notes

- The `suppressFor` set is a 2-second fast-path; it is not correctness-bearing. If it ever becomes
  load-bearing, the design is wrong — fix the resolver instead.
- Image/file support (v0.2) will require a new envelope kind. The `clipboard.event` kind remains
  text-only in v1.
- The `isPassword` flag is currently always `false` because we have no password-detection adapter. A
  future adapter (e.g. Windows clipboard with `ClipboardContentType.Password`) can populate it;
  receivers should respect it by suppressing notification previews.
