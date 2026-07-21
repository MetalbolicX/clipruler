/**
 * ports/ui.ts
 *
 * UI port — defines the contract for presenting pairing information
 * and collecting user confirmation during the pairing flow.
 *
 * No production adapter is provided in plan 007; shells provide concrete
 * adapters (StdioUi, DesktopUi) in subsequent plans.
 */

export interface UiPort {
  /**
   * Present the pairing code to the local user for visual comparison.
   * Called exactly once during the initiator pairing kickoff.
   */
  presentPairingCode(code: string): Promise<void>;

  /**
   * Ask the local user to confirm or reject a pairing request from a remote
   * peer. Used by the responder side of the pairing handshake (plan 009).
   */
  confirmPairing(remoteName: string, code: string): Promise<boolean>;

  /**
   * Notify the local user that a device was successfully paired.
   * Used by the responder side after confirmed pairing (plan 009).
   */
  notifyPaired(deviceName: string): Promise<void>;

  /**
   * Notify the local user that a pairing attempt failed.
   * Used by the responder side after rejected or timed-out pairing (plan 009).
   */
  notifyPairingFailed(reason: "mismatch" | "rejected" | "timeout"): Promise<void>;
}
