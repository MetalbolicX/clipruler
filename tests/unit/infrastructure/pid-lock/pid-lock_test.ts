/**
 * Unit tests for infrastructure/pid-lock/pid-lock.ts.
 *
 * Verifies:
 * - acquire() writes current PID to the pidFile when lock not held
 * - acquire() rejects with LockHeldError when another process holds the lock
 * - release() deletes the pidFile iff it contains the current PID
 * - release() is no-throw if the pidFile is absent or contains a different PID
 * - Liveness probe: dead PID (0x7FFFFFFF) is treated as not alive
 * - Liveness probe: own Deno.pid is treated as alive
 *
 * Layer: unit — uses Deno.makeTempDir for isolation; mocks liveness
 * indirectly via crafted PID files.
 */
import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@^1.0";
import type { AppPaths } from "../../../../src/infrastructure/persistence/app-paths.ts";
import { LockHeldError, PidLock } from "../../../../src/infrastructure/pid-lock/pid-lock.ts";

async function makeTempAppPaths(
  prefix = "pid-lock-test",
): Promise<{ appPaths: AppPaths; cleanup: () => void }> {
  const dir = await Deno.makeTempDir({ prefix });
  const stateFile = dir + "/state.json";
  const pidFile = dir + "/clipruler.pid";
  const appPaths: AppPaths = {
    configDir: dir + "/config",
    dataDir: dir,
    cacheDir: dir + "/cache",
    stateFile,
    pidFile,
  };
  const cleanup = () => {
    Deno.removeSync(dir, { recursive: true });
  };
  return { appPaths, cleanup };
}

Deno.test("acquire() writes current PID to pidFile when lock is free", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    const lock = new PidLock(appPaths);
    await lock.acquire();

    const pidContent = await Deno.readTextFile(appPaths.pidFile);
    const pid = parseInt(pidContent.trim(), 10);
    assertEquals(pid, Deno.pid);
  } finally {
    cleanup();
  }
});

Deno.test("acquire() rejects with LockHeldError when pidFile contains a live PID", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    // Write the current process PID to the pid file — it IS alive.
    // acquire() reads the file, detects the PID is alive, and rejects.
    await Deno.writeTextFile(appPaths.pidFile, `${Deno.pid}\n`);

    const lock = new PidLock(appPaths);
    await assertRejects(() => lock.acquire(), LockHeldError);
  } finally {
    cleanup();
  }
});

Deno.test("release() deletes pidFile when it contains current PID", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    const lock = new PidLock(appPaths);
    await lock.acquire();
    assertExists(await Deno.stat(appPaths.pidFile));

    await lock.release();

    // After release, the file should not exist
    try {
      await Deno.stat(appPaths.pidFile);
      throw new Error("File should not exist after release");
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        // Expected
      } else {
        throw err;
      }
    }
  } finally {
    cleanup();
  }
});

Deno.test("release() is no-throw when pidFile is absent", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    const lock = new PidLock(appPaths);
    // File does not exist — release should not throw
    await lock.release();
  } finally {
    cleanup();
  }
});

Deno.test("release() is no-throw when pidFile contains a different PID", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    await Deno.writeTextFile(appPaths.pidFile, "99999\n");
    const lock = new PidLock(appPaths);
    // Different PID — release should not throw
    await lock.release();
  } finally {
    cleanup();
  }
});

Deno.test("acquire() then acquire() on same instance throws (lock not released)", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    const lock = new PidLock(appPaths);
    await lock.acquire();
    await assertRejects(() => lock.acquire(), LockHeldError);
  } finally {
    cleanup();
  }
});

Deno.test("acquire() works when pidFile contains stale PID of dead process", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    // Write a clearly-dead PID (0x7FFFFFFF)
    await Deno.writeTextFile(appPaths.pidFile, "2147483647\n");
    const lock = new PidLock(appPaths);
    // Liveness probe should detect process 2147483647 is not alive
    // so acquire should succeed
    await lock.acquire();
    const pidContent = await Deno.readTextFile(appPaths.pidFile);
    assertEquals(parseInt(pidContent.trim(), 10), Deno.pid);
  } finally {
    cleanup();
  }
});

Deno.test("liveness probe: non-existent PID is treated as dead", async () => {
  const { appPaths, cleanup } = await makeTempAppPaths();
  try {
    // PID 999999 definitely does not exist on any system
    await Deno.writeTextFile(appPaths.pidFile, "999999\n");
    const lock = new PidLock(appPaths);
    await lock.acquire();
    const pidContent = await Deno.readTextFile(appPaths.pidFile);
    assertEquals(parseInt(pidContent.trim(), 10), Deno.pid);
  } finally {
    cleanup();
  }
});
