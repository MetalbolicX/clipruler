/**
 * infrastructure/pid-lock/pid-lock.ts
 *
 * PidLock — file-system based advisory lock for single-instance enforcement.
 *
 * Uses the presence of a pidFile to detect whether another instance is running.
 * The liveness probe checks whether the recorded PID is still alive:
 *   - Linux/Darwin: spawns `kill -0 <pid>` — exit code 0 means alive
 *   - Windows: spawns `tasklist /FI "PID eq <pid>"`
 *   - Other / unknown OS: treats as dead
 *   - Throw / permission denied: treats as dead
 *
 * Note: Deno 2.9's sandboxed --allow-read does NOT grant access to
 * `/proc/<pid>/stat` without a path-specific grant or --allow-all.
 * `kill -0` works portably under the standard test permission set and is
 * the canonical POSIX liveness probe. See spec deviation note in
 * sdd/plan-003-ports-persistence-identity/spec.
 */

import type { AppPaths } from "../persistence/app-paths.ts";

export class LockHeldError extends Error {
  readonly tag = "LockHeldError" as const;
  constructor(public readonly heldByPid: number) {
    super(`Lock held by PID ${heldByPid}`);
    this.name = "LockHeldError";
  }
}

export class PidLock {
  constructor(private readonly appPaths: AppPaths) {}

  /**
   * Acquires the lock by writing the current PID to the pidFile.
   *
   * @throws LockHeldError if the pidFile contains a PID that is still alive.
   */
  async acquire(): Promise<void> {
    const { pidFile } = this.appPaths;

    // Check if pidFile already exists and whether its PID is alive
    try {
      const content = await Deno.readTextFile(pidFile);
      const storedPid = parseInt(content.trim(), 10);
      if (!Number.isNaN(storedPid) && (await this.liveness(storedPid))) {
        throw new LockHeldError(storedPid);
      }
    } catch (err) {
      if (err instanceof LockHeldError) throw err;
      // NotFound or parse error → lock is not held; proceed
    }

    // Write our PID
    await Deno.writeTextFile(pidFile, `${Deno.pid}\n`, { create: true });
  }

  /**
   * Releases the lock by deleting the pidFile, but only if it contains
   * the current PID (i.e. we are the owner).
   *
   * Does NOT throw if the file is absent or contains a different PID.
   */
  async release(): Promise<void> {
    const { pidFile } = this.appPaths;

    let content: string;
    try {
      content = await Deno.readTextFile(pidFile);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return; // already gone
      return; // any other read error → no-throw
    }

    const storedPid = parseInt(content.trim(), 10);
    if (Number.isNaN(storedPid) || storedPid !== Deno.pid) return;

    try {
      await Deno.remove(pidFile);
    } catch (err) {
      // Permission denied or other error on remove → no-throw per spec
      if (!(err instanceof Deno.errors.NotFound)) {
        return;
      }
    }
  }

  /**
   * Returns true if the process with the given PID is alive, false otherwise.
   *
   * Linux/Darwin: uses `kill -0 <pid>` (exit code 0 means alive).
   * Windows: runs `tasklist /FI "PID eq <pid>"` — non-zero exit = not alive.
   * Unknown OS: treats as dead (conservative).
   * Errors / permission denied: treats as dead.
   */
  private async liveness(pid: number): Promise<boolean> {
    const os = Deno.build.os;

    if (os === "linux" || os === "darwin") {
      return await this.livenessKill(pid);
    } else if (os === "windows") {
      return await this.livenessWindows(pid);
    } else {
      // Unknown OS — treat as dead (conservative)
      return false;
    }
  }

  private async livenessKill(pid: number): Promise<boolean> {
    // Use signal 0 to check process existence — does NOT send any signal.
    try {
      const proc = new Deno.Command("kill", {
        args: ["-0", String(pid)],
        stdout: "null",
        stderr: "null",
      });
      const { code } = await proc.output();
      return code === 0;
    } catch {
      return false;
    }
  }

  private async livenessWindows(pid: number): Promise<boolean> {
    try {
      const proc = new Deno.Command("tasklist", {
        args: ["/FI", `PID eq ${pid}`],
        stdout: "piped",
        stderr: "piped",
      });
      const { code, stdout } = await proc.output();
      // tasklist exits 0 when it finds a matching process, 1 when none found
      // Also check stdout: when process not found, tasklist outputs a table
      // with "INFO: No tasks" message.
      if (code === 1) return false;
      const output = new TextDecoder().decode(stdout);
      // If the output contains "No tasks" the process is not running
      if (output.includes("No tasks")) return false;
      return true;
    } catch {
      // Any error → treat as dead
      return false;
    }
  }
}
