/**
 * shells/desktop/tray-menu.ts
 *
 * TrayMenu — state machine for the desktop tray icon and menu.
 *
 * Design (Plan 011, Design #2534, DS-3.1/3.2/3.3):
 * State machine:
 *   START
 *    ├─ daemon down: Status unavailable; Show/Pair disabled; Quit enabled
 *    ├─ up + 0 paired: Status running on :P; Show enabled; Pair disabled
 *    └─ up + N paired: Show enabled; device rows enable Enable/Disable/Forget
 *   Pair → admin.pair.request → not_implemented → placeholder state → Ready
 *   Quit(any) → running.stop → tray.destroy → 0
 *
 * trayId === 0 logs a warning but is nonfatal.
 */

import type { AdminEndpoint } from "../cli/admin-client.ts";
import type { AdminResponse } from "../cli/admin-client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrayItem {
  label: string;
  disabled?: boolean;
  click?: () => void;
}

/** Seam for Deno.Tray — injectable for unit testing. */
export interface TrayHandle {
  id: number;
  setMenuItems(items: TrayItem[]): void;
}

/** Runtime context — owned by desktopMain; passed in so TrayMenu can stop it on Quit. */
export interface RunningContext {
  stop(): void;
}

/** Admin command function (same signature as adminCommand from admin-client.ts). */
export type AdminCommandFn = (
  endpoint: AdminEndpoint,
  method: string,
  params?: unknown,
) => Promise<unknown>;

/** Options for constructing TrayMenu. */
export interface TrayMenuOptions {
  /** Inject a mock TrayHandle for unit testing. */
  _tray?: TrayHandle;
  /** Resolved admin endpoint (unix socket or TCP port). */
  endpoint: AdminEndpoint;
  /** Admin command function for calling daemon methods. */
  adminCommand: AdminCommandFn;
  /** Running daemon context; stop() called on Quit. */
  running?: RunningContext;
}

/** Daemon status driving the state machine. */
export interface DaemonStatus {
  running: boolean;
  deviceCount: number;
  port?: number;
}

// ---------------------------------------------------------------------------
// TrayMenu
// ---------------------------------------------------------------------------

/**
 * State machine–driven tray menu.
 *
 * Receives status updates via `setStatus()` and `setPairingError()` and
 * rebuilds the tray menu accordingly.
 *
 * @param opts._tray  — inject mock TrayHandle for unit tests (default: real Deno.Tray)
 * @param opts.endpoint — resolved admin endpoint
 * @param opts.adminCommand — adminCommand function for daemon calls
 * @param opts.running — running daemon context; stop() called on Quit
 */
export class TrayMenu {
  #tray: TrayHandle;
  #endpoint: AdminEndpoint;
  #adminCommand: AdminCommandFn;
  #running: RunningContext | undefined = undefined;
  #port: number | undefined = undefined;
  #deviceCount = 0;
  #isRunning = false;
  #pairingError = false;

  constructor(opts: TrayMenuOptions) {
    if (opts._tray) {
      this.#tray = opts._tray;
    } else {
      // Access Deno.Tray via globalThis with explicit cast
      // deno-lint-ignore no-explicit-any
      const DenoTray = (globalThis as any).Deno?.Tray as
        // deno-lint-ignore no-explicit-any
        { new(opts: object): TrayHandle } | undefined;
      if (!DenoTray) {
        throw new Error(
          "Deno.Tray is not available. Ensure you are running with --unstable-desktop.",
        );
      }
      this.#tray = new DenoTray({});
    }

    this.#endpoint = opts.endpoint;
    this.#adminCommand = opts.adminCommand;
    this.#running = opts.running;

    // DS-3.3: trayId === 0 logs a warning but is nonfatal
    if (this.#tray.id === 0) {
      console.warn(
        "[tray] Deno.Tray returned id === 0 — tray may not function correctly. Continuing anyway.",
      );
    }

    this.#rebuildMenu();
  }

  /**
   * Update the daemon status and rebuild the tray menu.
   *
   * @param status — { running, deviceCount, port }
   */
  setStatus(status: DaemonStatus): void {
    this.#isRunning = status.running;
    this.#deviceCount = status.deviceCount;
    this.#port = status.port;
    this.#pairingError = false;
    this.#rebuildMenu();
  }

  /**
   * Transition to the pairing-error placeholder state.
   * Called when admin.pair.request returns not_implemented or another error.
   */
  setPairingError(_reason: string): void {
    this.#pairingError = true;
    this.#rebuildMenu();
  }

  #rebuildMenu(): void {
    const items: TrayItem[] = [];

    if (this.#pairingError) {
      // Pair → not_implemented → placeholder state; tray stays alive
      items.push(
        { label: "Pairing not yet implemented — use a future version", disabled: true },
        { label: "" },
      );
    }

    if (!this.#isRunning) {
      // Daemon down
      items.push({ label: "Status unavailable", disabled: true });
      items.push({ label: "Show", disabled: true });
      items.push({ label: "Pair", disabled: true });
      items.push({ label: "Quit", disabled: false, click: () => this.#handleQuit() });
    } else {
      // Daemon up
      const portStr = this.#port !== undefined ? `:${this.#port}` : "";
      items.push({ label: `Status running${portStr}`, disabled: true });
      items.push({
        label: "Show",
        disabled: false,
        click: () => this.#handleShow(),
      });

      if (this.#deviceCount === 0) {
        items.push({ label: "Pair", disabled: true });
      } else {
        items.push({
          label: "Pair",
          disabled: false,
          click: () => this.#handlePair(),
        });
        // Device rows — placeholder labels (device names come from admin.list at runtime)
        for (let i = 0; i < this.#deviceCount; i++) {
          items.push({ label: `  Device ${i + 1}`, disabled: true });
          items.push({
            label: `    Enable`,
            disabled: false,
            click: () => this.#handleToggle(i, true),
          });
          items.push({
            label: `    Disable`,
            disabled: false,
            click: () => this.#handleToggle(i, false),
          });
          items.push({
            label: `    Forget`,
            disabled: false,
            click: () => this.#handleForget(i),
          });
        }
      }
      items.push({ label: "Quit", disabled: false, click: () => this.#handleQuit() });
    }

    this.#tray.setMenuItems(items);
  }

  #handleShow(): void {
    // Show the hidden window — TBD in Slice 4 (window.show())
  }

  async #handlePair(): Promise<void> {
    try {
      const result = await this.#adminCommand(
        this.#endpoint,
        "admin.pair.request",
        {},
      ) as AdminResponse<unknown>;
      // If daemon returns not_implemented, surface placeholder
      if (result?.status === "error") {
        this.setPairingError(result.message ?? "error");
      }
    } catch {
      this.setPairingError("error");
    }
  }

  async #handleToggle(_index: number, _enable: boolean): Promise<void> {
    // admin.toggle — implemented in plan-009; placeholder for now
  }

  async #handleForget(_index: number): Promise<void> {
    // admin.forget — implemented in plan-009; placeholder for now
  }

  #handleQuit(): void {
    this.#running?.stop();
    this.#tray.setMenuItems([{ label: "Quitting..." }]);
    // Destroy after a tick so the label is visible briefly
    setTimeout(() => {
      this.#tray.setMenuItems([]);
    }, 100);
  }
}
