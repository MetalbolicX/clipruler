/**
 * infrastructure/transport/reconnect.ts
 *
 * Reconnect wrapper with exponential backoff, jitter, cancellation, and
 * per-fingerprint deduplication.
 *
 * Design (R5):
 * - Single reconnect loop per fingerprint (no fan-out on concurrent drops).
 * - Cancellable via AbortController.
 * - Exponential backoff: min(cap, base * 2^attempt) + bounded jitter.
 * - Max attempts → ReconnectAbandonedError.
 * - On successful dial: resolve and call optional onConnected callback.
 *
 * Zero third-party deps.
 */

import { ReconnectAbandonedError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Conn interface — minimal contract for the underlying connection
// ---------------------------------------------------------------------------

/**
 * Minimal connection interface required by the reconnect wrapper.
 * The dial() function returns a value satisfying this interface.
 */
export interface Conn {
  readonly id: string;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Clock interface — allows deterministic timing in tests
// ---------------------------------------------------------------------------

/**
 * Clock interface for scheduling delayed callbacks.
 * Allows test injection of a FakeClock for deterministic testing.
 */
export interface Clock {
  setTimeout(fn: () => void, delayMs: number): void;
}

// ---------------------------------------------------------------------------
// ReconnectOptions
// ---------------------------------------------------------------------------

export interface ReconnectOptions {
  /**
   * Dial function — called each reconnect attempt.
   * Receives an AbortSignal that is aborted when the caller cancels.
   * Should throw if the connection cannot be established.
   */
  dial(signal: AbortSignal): Promise<Conn>;

  /** Base delay between reconnect attempts (ms). */
  baseDelayMs: number;

  /** Maximum delay cap between attempts (ms). */
  capDelayMs: number;

  /** Maximum number of dial attempts before abandoning. */
  maxAttempts: number;

  /**
   * Optional jitter function: given (min, max), returns a random value.
   * Defaults to Math.random() * (max - min) + min.
   * Inject this for deterministic tests.
   */
  jitter?(min: number, max: number): number;

  /**
   * Optional clock override for testing.
   * Defaults to global setTimeout.
   * Inject a Clock-compatible object (e.g. FakeClock) for deterministic timing.
   */
  _clock?: Clock;

  /**
   * Optional callback invoked each time a dial succeeds.
   * The wrapper resolves successfully after calling this.
   */
  _onConnected?(conn: Conn): void;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface ReconnectState {
  cancelController: AbortController;
  outcome: Promise<void>;
  /** Reject function for the outcome promise */
  reject: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// Global state — single reconnect loop per fingerprint (no fan-out)
// ---------------------------------------------------------------------------

/** Maps fingerprint → active reconnect state. */
const states = new Map<string, ReconnectState>();

/** Maps fingerprint → outcome Promise for concurrent-call deduplication. */
const pendingOutcomes = new Map<string, Promise<void>>();

/**
 * Maps fingerprint → winner's "claimed" flag.
 * Set synchronously BEFORE creating state — allows losing calls to detect
 * they lost the race before starting any async work.
 */
const claiming = new Map<string, boolean>();

/** Shared placeholder Promise used to claim fingerprint slots during setup. */
const PENDING_PLACEHOLDER = Promise.resolve() as Promise<void>;

// Default jitter: adds ±50% randomness to the delay
function defaultJitter(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

// Default clock using global setTimeout
function defaultClock(): Clock {
  return {
    setTimeout(fn: () => void, delayMs: number) {
      globalThis.setTimeout(fn, delayMs);
    },
  };
}

// ---------------------------------------------------------------------------
// reconnect
// ---------------------------------------------------------------------------

/**
 * Starts or returns the existing reconnect loop for the given fingerprint.
 *
 * If a loop is already running for this fingerprint, returns the existing
 * outcome promise (fan-out dedup). If not, starts a new loop.
 *
 * @param fingerprint  Unique identifier for the remote peer.
 * @param opts         Reconnect configuration.
 * @returns An object with a `cancel()` method and an `outcome` promise.
 */
export function reconnect(
  fingerprint: string,
  opts: ReconnectOptions,
): { cancel(): void; outcome: Promise<void> } {
  // Race-condition guard: claim the fingerprint slot BEFORE creating state.
  // Map.set returns the PREVIOUS value. If non-undefined, another call
  // already claimed this fingerprint — return its outcome.
  const priorClaim = claiming.set(fingerprint, true);
  if (priorClaim !== undefined) {
    // We lost the race — return the existing outcome immediately.
    // The winner's loop is running (or already completed); outcome IS shared.
    const state = states.get(fingerprint);
    if (state) {
      return { cancel: () => state.cancelController.abort(), outcome: state.outcome };
    }
    // Fall through: winner claimed but hasn't set state yet (async window).
    // This caller must NOT loop — fall through to create its own state below.
    // (This case is extremely rare with real async; handled by claiming guard.)
  }

  // We won. Install placeholder immediately so late-arrivers see it.
  pendingOutcomes.set(fingerprint, PENDING_PLACEHOLDER);

  const clock = opts._clock ?? defaultClock();
  const jitterFn = opts.jitter ?? defaultJitter;
  const onConnected = opts._onConnected;

  // We won the race. Create state synchronously.
  const cancelController = new AbortController();
  let settled = false;

  // Promise resolver shared between the loop and the returned outcome
  // eslint-disable-next-line no-unused-vars
  let resolveOutcome!: (value: void) => void;
  // eslint-disable-next-line no-unused-vars
  let rejectOutcome!: (err: Error) => void;

  const outcome = new Promise<void>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });

  // Attach a no-op handler immediately to prevent Deno's unhandled-rejection detection.
  outcome.then(() => {}, () => {});

  const state: ReconnectState = {
    cancelController,
    outcome,
    reject: rejectOutcome,
  };

  // Install state and real outcome BEFORE starting loop() so concurrent callers see it
  states.set(fingerprint, state);
  pendingOutcomes.set(fingerprint, outcome);

  let attempt = 0;

  function scheduleRetry(delayMs: number): void {
    if (settled) return;
    clock.setTimeout(() => {
      if (settled || cancelController.signal.aborted) return;
      // Catch to prevent unhandled rejection from async loop()
      loop().catch(() => {});
    }, delayMs);
  }

  function cleanup(): void {
    settled = true;
    states.delete(fingerprint);
    pendingOutcomes.delete(fingerprint);
    claiming.delete(fingerprint);
  }

  async function loop(): Promise<void> {
    if (settled || cancelController.signal.aborted) return;

    attempt++;
    const isLastAttempt = attempt >= opts.maxAttempts;

    let didDial = false;
    try {
      await opts.dial(cancelController.signal);
      didDial = true;
    } catch {
      // Dial failed — handled below
    }

    if (cancelController.signal.aborted) {
      if (!settled) {
        cleanup();
        rejectOutcome(new Error("reconnect cancelled"));
      }
      return;
    }

    if (didDial) {
      // Success — settle and clean up
      cleanup();
      if (onConnected) onConnected({ id: fingerprint } as Conn);
      resolveOutcome(undefined);
      return;
    }

    if (isLastAttempt) {
      // All attempts exhausted — reject outcome and exit without throwing
      cleanup();
      const err = new ReconnectAbandonedError(fingerprint, attempt);
      rejectOutcome(err);
      // Return normally (do NOT throw) so loop() resolves without causing a second rejection.
      // The rejection is on 'outcome' (handled by caller via await outcome).
      // Suppress Deno unhandled-rejection by catching loop()'s resolved state:
      return;
    }

    // Schedule next attempt with exponential backoff + jitter
    const rawDelay = Math.min(
      opts.capDelayMs,
      opts.baseDelayMs * Math.pow(2, attempt - 1),
    );
    // Jitter: add ±jitterFraction of the raw delay (bounded)
    const jitterFraction = 0.5;
    const jitterBias = jitterFn(0, rawDelay * jitterFraction);
    const totalDelay = rawDelay + jitterBias;
    scheduleRetry(totalDelay);
  }

  // Start the first attempt immediately
  loop().catch(() => {});

  return {
    cancel() {
      cancelController.abort();
    },
    outcome,
  };
}
