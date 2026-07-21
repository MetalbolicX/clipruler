/**
 * application/receive-clipboard.ts
 *
 * Incoming clipboard sync use case.
 *
 * Subscribes to the transport for incoming clipboard envelopes, validates
 * trust/sharing/origin guards, resolves conflicts via the existing resolver,
 * and applies accepted remote writes to the local clipboard.
 *
 * The shared remote-write gate prevents echo: suppressNext() is called before
 * clipboard.write() so the resulting local subscriber notification does NOT
 * re-broadcast.
 *
 * DESIGN decisions:
 * - D1: envelope kind is "clipboard" (not "clipboard.event")
 * - D3: check originDeviceId === localDeviceId BEFORE resolver/clock handling
 * - D5: map wire payload to unchanged domain ClipboardEvent in the receiver
 * - D6: use shared one-shot remote-write gate (no timer suppressor)
 */

import type { ClipboardAdapter } from "../ports/clipboard-adapter.ts";
import type { DeviceRepository } from "../ports/device-repository.ts";
import type { LogicalClock } from "../ports/logical-clock.ts";
import type { Logger } from "../ports/logger.ts";
import type { Transport } from "../ports/transport.ts";
import type { DeviceId } from "../domain/device.ts";
import type { ClipboardEvent } from "../domain/clipboard-event.ts";
import { initResolver, observe } from "../domain/conflict-resolver.ts";
import type { RemoteWriteGate } from "./sync-clipboard.ts";
import type { Envelope } from "../protocol/envelope.ts";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ReceiveClipboardDeps {
  readonly logger: Logger;
  readonly clock: LogicalClock;
  /** Paired device registry — used for trust and sharing checks. */
  readonly devices: DeviceRepository;
  /** Transport for receiving envelopes from peers. */
  readonly transport: Transport;
  /** Clipboard adapter — written when a remote event is accepted. */
  readonly clipboard: ClipboardAdapter;
  /** Local device identity — used for origin-echo rejection. */
  readonly localDeviceId: DeviceId;
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
 * Start the incoming clipboard sync pipeline.
 *
 * @param deps - all port dependencies
 * @returns A cleanup function that stops processing incoming events
 */
export function startRemoteReceiver(deps: ReceiveClipboardDeps): () => void {
  const { logger, clock, devices, transport, clipboard, localDeviceId, remoteWriteGate } =
    deps;

  // Stateful conflict resolver — passed forward after each observe call
  let resolver = initResolver();

  // Guard flag for cleanup — set to false to stop processing
  let active = true;

  // Subscribe to incoming transport events
  transport.subscribe(async (envelope: Envelope) => {
    if (!active) return;

    // M1 / D1: filter to clipboard kind only
    if (envelope.kind !== "clipboard") {
      logger.debug("receive-clipboard: non-clipboard envelope dropped", {
        kind: envelope.kind,
      });
      return;
    }

    const originDeviceId = envelope.originDeviceId;

    // D3 / M3: origin-echo rejection BEFORE observe — drop events from ourselves
    if (originDeviceId === localDeviceId) {
      logger.debug("receive-clipboard: origin-echo dropped before observe", {
        origin: originDeviceId,
      });
      return;
    }

    // Trust check: origin must be a paired device
    const allDevices = await devices.list();
    const originDevice = allDevices.find((d) => d.deviceId === originDeviceId);
    if (!originDevice) {
      logger.debug("receive-clipboard: unpaired origin dropped", {
        origin: originDeviceId,
      });
      return;
    }

    // Sharing check: paired device must have clipboard sharing enabled
    if (!originDevice.clipboardSharingEnabled) {
      logger.debug("receive-clipboard: sharing-disabled origin dropped", {
        origin: originDeviceId,
        deviceName: originDevice.name,
      });
      return;
    }

    // Extract payload
    const payload = envelope.payload as {
      readonly version: number;
      readonly counter: number;
      readonly content: string;
    };

    // M4: observe remote counter via clock (max semantics)
    await clock.observe(payload.counter);

    // M3 (duplicate): conflict resolution — two-argument observe
    // The resolver checks messageId deduplication and version comparison
    const version = {
      counter: payload.counter,
      deviceId: originDeviceId as DeviceId,
    };
    const { state: nextResolver, result } = observe(resolver, {
      version,
      messageId: envelope.messageId,
    });
    resolver = nextResolver;

    if (result.result !== "accepted") {
      logger.debug("receive-clipboard: event not accepted by resolver", {
        result: result.result,
        messageId: envelope.messageId,
      });
      return;
    }

    // M5: map wire payload to domain ClipboardEvent and write locally
    // D6: call gate.suppressNext() BEFORE clipboard.write() to prevent echo
    remoteWriteGate.suppressNext();

    const domainEvent: ClipboardEvent = {
      sourceDeviceId: originDeviceId as DeviceId,
      counter: payload.counter,
      timestamp: Date.now(),
      text: payload.content,
    };

    logger.debug("receive-clipboard: applying remote write", {
      text: domainEvent.text,
      source: originDeviceId,
    });

    await clipboard.write({ text: domainEvent.text, isPassword: false });
  });

  // Return cleanup function — sets active flag to false
  return () => {
    active = false;
  };
}
