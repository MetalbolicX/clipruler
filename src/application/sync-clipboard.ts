/**
 * application/sync-clipboard.ts
 *
 * Outgoing clipboard sync use case.
 *
 * Subscribes to local clipboard changes, ignores empty content, ticks the
 * logical clock, and fans out a flat `clipboard` envelope to every paired
 * peer with clipboardSharingEnabled = true.
 *
 * The shared remote-write gate prevents an echo loop: when a remote write
 * is accepted locally (PR3), it calls gate.suppressNext() so the resulting
 * local subscriber notification does not re-broadcast.
 *
 * DESIGN decisions:
 * - D1: envelope kind is "clipboard" (not "clipboard.event")
 * - D2: flat payload { version: 1, counter, content } — no isPassword
 * - D6: use Transport.send per eligible fingerprint (not broadcast) so
 *        sharing opt-out is enforced before transmission
 */

import type { ClipboardAdapter } from "../ports/clipboard-adapter.ts";
import type { DeviceRepository } from "../ports/device-repository.ts";
import type { LogicalClock } from "../ports/logical-clock.ts";
import type { Logger } from "../ports/logger.ts";
import type { Transport } from "../ports/transport.ts";
import { makeEnvelope } from "../protocol/envelope.ts";

// ---------------------------------------------------------------------------
// Shared remote-write gate
// ---------------------------------------------------------------------------

/**
 * One-shot gate that suppresses exactly one outgoing broadcast.
 *
 * Used to break the echo loop: when receive-clipboard.ts (PR3) accepts a
 * remote write and calls clipboard.write(), the subscriber fires locally.
 * suppressNext() is called before write() so that the resulting notification
 * does NOT re-broadcast back to the sender.
 *
 * Usage:
 *   // PR3: remote event accepted
 *   gate.suppressNext();
 *   await clipboard.write({ text, isPassword: false });
 *
 *   // PR2: before broadcasting
 *   if (gate.isSuppressed()) return; // skip this event
 */
export interface RemoteWriteGate {
  /** Arm the gate — the next isSuppressed() call returns true. */
  suppressNext(): void;
  /** Consume the gate if armed. Returns true if the next event should be suppressed. */
  isSuppressed(): boolean;
}

/**
 * Creates a one-shot remote-write gate.
 * The gate is armed by suppressNext() and consumed by isSuppressed() (one-shot).
 */
export function createRemoteWriteGate(): RemoteWriteGate {
  let suppressed = false;
  return {
    suppressNext(): void {
      suppressed = true;
    },
    isSuppressed(): boolean {
      const result = suppressed;
      suppressed = false; // consume — one-shot
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface SyncClipboardDeps {
  readonly logger: Logger;
  /** Logical clock for Lamport counter. */
  readonly clock: LogicalClock;
  /** Paired device registry — used to filter eligible recipients. */
  readonly devices: DeviceRepository;
  /** Transport for sending envelopes to peers. */
  readonly transport: Transport;
  /** Clipboard adapter — subscribed for local change notifications. */
  readonly clipboard: ClipboardAdapter;
  /**
   * Shared remote-write gate.
   * Created once per node and shared between startLocalSync and startRemoteReceiver.
   */
  readonly remoteWriteGate: RemoteWriteGate;
}

// ---------------------------------------------------------------------------
// Use case
// ---------------------------------------------------------------------------

/**
 * Start the outgoing clipboard sync pipeline.
 *
 * @param deps - all port dependencies
 * @returns An unsubscribe function that tears down the clipboard subscriber
 */
export function startLocalSync(deps: SyncClipboardDeps): () => void {
  const { logger, clock, devices, transport, clipboard, remoteWriteGate } = deps;

  const unsubscribe = clipboard.subscribe(async (content) => {
    // M2 spec: ignore empty changes
    if (content.text.length === 0) {
      logger.debug("sync-clipboard: empty change ignored", { text: content.text });
      return;
    }

    // D6: check the shared gate — skip if a remote write was just accepted
    if (remoteWriteGate.isSuppressed()) {
      logger.debug("sync-clipboard: outgoing suppressed by remote-write gate", {
        text: content.text,
      });
      return;
    }

    // Tick the logical clock and build the payload
    const counter = await clock.tick();
    const payload = {
      version: 1 as const,
      counter,
      content: content.text,
    };

    // List all paired devices and filter to those with clipboard sharing enabled
    const allDevices = await devices.list();
    const eligible = allDevices.filter((d) => d.clipboardSharingEnabled);

    if (eligible.length === 0) {
      logger.debug("sync-clipboard: no eligible peers, skipping broadcast", {
        text: content.text,
      });
      return;
    }

    // Fan out via Transport.send per eligible peer (D6 design decision)
    const envelope = makeEnvelope(
      clock.deviceId,
      "clipboard",
      payload,
    );

    for (const peer of eligible) {
      logger.debug("sync-clipboard: sending to peer", {
        fingerprint: peer.fingerprint,
        text: content.text,
      });
      // D6: send per eligible fingerprint — not broadcast, so opt-out is enforced
      await transport.send(peer.fingerprint, envelope);
    }
  });

  return unsubscribe;
}
