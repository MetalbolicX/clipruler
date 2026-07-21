/**
 * infrastructure/logger/console-logger.ts
 *
 * ConsoleLogger adapter — satisfies the Logger port.
 * Outputs JSON Lines to stderr for EVERY level (constraint #2: stderr-only).
 * Never throws: JSON.stringify and the stderr call are wrapped in try/catch.
 */

import type { Logger, LogLevel } from "../../ports/logger.ts";

export class ConsoleLogger implements Logger {
  constructor(private readonly scope = "clipruler") {}

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.emit("debug", msg, meta);
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.emit("info", msg, meta);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.emit("warn", msg, meta);
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.emit("error", msg, meta);
  }

  child(scope: string): Logger {
    return new ConsoleLogger(`${this.scope}:${scope}`);
  }

  private emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        scope: this.scope,
        msg,
        ...meta,
      });
      // Constraint #2: ALL levels go to stderr.
      console.error(line);
    } catch {
      // Non-throwing: swallow serialization errors silently
    }
  }
}
