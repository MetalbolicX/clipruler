/**
 * shells/daemon.ts
 *
 * Daemon entry point — handles SIGINT/SIGTERM for graceful shutdown.
 *
 * Design (Plan 009 §Architecture constraints):
 * - SIGINT/SIGTERM triggers graceful shutdown via RunningDaemon.stop()
 * - The daemon prints JSON to stdout on startup (PID, adminSocketPath, tlsPort)
 */

import { buildAndRunDaemon } from "./composition-root.ts";
import type { RunningDaemon } from "./composition-root.ts";

/**
 * Run the daemon: build, start, print startup info, await signals, shutdown.
 *
 * @param deviceName - Human-readable device name
 */
export const daemonMain = async (deviceName: string): Promise<void> => {
  let running: RunningDaemon;

  try {
    running = await buildAndRunDaemon({ deviceName });
  } catch (err) {
    console.error(JSON.stringify({
      error: "failed to start daemon",
      message: err instanceof Error ? err.message : String(err),
    }));
    Deno.exit(1);
  }

  // Print startup JSON to stdout so parent process / CLI can parse it
  console.log(
    JSON.stringify({
      adminSocketPath: running.adminSocketPath,
      tlsPort: running.tlsPort,
      pid: Deno.pid,
    }),
  );

  // Flush stdout before waiting for signals
  await new Promise<void>((resolve) => {
    // Signal handler — resolve on first signal, ignore subsequent
    let received = false;
    const handler = () => {
      if (received) return;
      received = true;
      resolve();
    };
    Deno.addSignalListener("SIGINT", handler);
    Deno.addSignalListener("SIGTERM", handler);
  });

  await running.stop();
};
