/**
 * ports/logical-clock.ts
 *
 * LogicalClock port interface — defines the contract for a Lamport-style
 * logical clock that advances on tick() and observes remote counter values.
 */

import type { DeviceId } from "../domain/device.ts";

/** Logical counter — a plain number per Plan 002. */
export type LogicalCounter = number;

export interface LogicalClock {
  /** Advance and return the next local counter value. */
  tick(): Promise<LogicalCounter>;
  /** Observe a remote counter; local clock advances past it if needed. */
  observe(remote: LogicalCounter): Promise<void>;
  /** Bind to a device identity. Used in Version tuples. */
  readonly deviceId: DeviceId;
}
