/**
 * infrastructure/clock/persistent-clock.ts
 *
 * PersistentClock adapter — satisfies the LogicalClock port.
 *
 * Implements Lamport clock semantics:
 * - tick() increments the counter and calls sink with the new value.
 * - observe(remote) updates to max(local, remote); sink is called only when
 *   the counter actually advances.
 *
 * The sink (persistence hook) is injected and debounced by the composition
 * root — this class calls it on every genuine advancement.
 *
 * Uses clockCounter semantics (never logicalCounter).
 */

import type { DeviceId } from "../../domain/device.ts";
import type { LogicalClock } from "../../ports/logical-clock.ts";
import type { Logger } from "../../ports/logger.ts";

/**
 * Sink function type — called when the clock counter advances.
 * The composition root debounces calls to the actual state-file writer.
 */
export type ClockSink = (nextCounter: number) => void;

/**
 * PersistentClock implements the LogicalClock port.
 *
 * @param deviceId       - The device this clock is bound to.
 * @param initialCounter - The initial clockCounter value (loaded from state).
 * @param sink           - Called on every counter advancement (debounced at the shell).
 * @param logger         - Logger instance for diagnostics.
 */
export class PersistentClock implements LogicalClock {
  private counter: number;

  readonly deviceId: DeviceId;

  constructor(
    deviceId: DeviceId,
    initialCounter: number,
    private readonly sink: ClockSink,
    private readonly logger: Logger,
  ) {
    this.deviceId = deviceId;
    this.counter = initialCounter;
  }

  /**
   * Advance the local counter by one and notify the sink.
   */
  tick(): Promise<number> {
    const next = this.counter + 1;
    this.counter = next;
    this.sink(next);
    this.logger.debug("clock.tick", { counter: next });
    return Promise.resolve(next);
  }

  /**
   * Observe a remote counter value.
   * If remote > local, advance to max(local, remote) and notify the sink.
   * If remote <= local, this is a no-op — sink is NOT called.
   */
  observe(remote: number): Promise<void> {
    if (remote > this.counter) {
      this.counter = remote;
      this.sink(remote);
      this.logger.debug("clock.observe advanced", { counter: remote });
    }
    return Promise.resolve();
  }
}
