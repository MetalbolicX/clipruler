/**
 * domain/pairing.ts
 *
 * Pure domain pairing FSM — immutable transition function.
 * Zero Deno.* runtime imports.
 *
 * States:  NotPaired | Requested | RequestedByPeer | Paired
 * Events:  RequestPairing | PeerRequested | Accept | Revoke
 *
 * 5 valid transitions:
 *   NotPaired  + RequestPairing → Requested
 *   NotPaired  + PeerRequested  → RequestedByPeer
 *   Requested  + Accept          → Paired
 *   RequestedByPeer + Accept     → Paired
 *   Paired     + Revoke         → NotPaired
 *
 * All other transitions throw — caller uses assertThrows to verify.
 */

export type PairState = "NotPaired" | "Requested" | "RequestedByPeer" | "Paired";
export type PairEvent = "RequestPairing" | "PeerRequested" | "Accept" | "Revoke";

/**
 * Immutable FSM transition.
 * Returns the next state, or throws if the (state, event) pair is invalid.
 */
export const transition = (current: PairState, event: PairEvent): PairState => {
  switch (current) {
    case "NotPaired":
      switch (event) {
        case "RequestPairing":
          return "Requested";
        case "PeerRequested":
          return "RequestedByPeer";
        default:
          throw new Error(`Invalid transition: ${current} + ${event}`);
      }

    case "Requested":
      switch (event) {
        case "Accept":
          return "Paired";
        default:
          throw new Error(`Invalid transition: ${current} + ${event}`);
      }

    case "RequestedByPeer":
      switch (event) {
        case "Accept":
          return "Paired";
        default:
          throw new Error(`Invalid transition: ${current} + ${event}`);
      }

    case "Paired":
      switch (event) {
        case "Revoke":
          return "NotPaired";
        default:
          throw new Error(`Invalid transition: ${current} + ${event}`);
      }
  }
};
