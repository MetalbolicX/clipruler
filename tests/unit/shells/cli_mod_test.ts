/**
 * Unit tests for shells/cli/mod.ts.
 *
 * Verifies cliMain exit-code semantics:
 * - --help / -h / empty argv → 0 (help printed before endpoint resolution)
 * - Unknown subcommand → 2
 * - Known subcommand with no daemon reachable → 2 (admin endpoint not found)
 *
 * Layer: unit — calls cliMain in-process with an isolated env (temp HOME /
 * XDG dirs) so endpoint resolution deterministically fails. No subprocess.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import { cliMain } from "../../../src/shells/cli/mod.ts";

// ---------------------------------------------------------------------------
// Env isolation helper — points HOME/XDG at a fresh temp dir so the admin
// endpoint file is absent and resolveEndpoint() deterministically returns null.
// ---------------------------------------------------------------------------

interface EnvSnapshot {
  tmpDir: string;
  keys: Record<string, string | undefined>;
}

async function isolateEnv(): Promise<EnvSnapshot> {
  const tmpDir = await Deno.makeTempDir();
  const keys: Record<string, string | undefined> = {
    HOME: Deno.env.get("HOME"),
    "XDG_DATA_HOME": Deno.env.get("XDG_DATA_HOME"),
    "XDG_CONFIG_HOME": Deno.env.get("XDG_CONFIG_HOME"),
    "XDG_CACHE_HOME": Deno.env.get("XDG_CACHE_HOME"),
  };
  Deno.env.set("HOME", tmpDir);
  Deno.env.set("XDG_DATA_HOME", tmpDir);
  Deno.env.set("XDG_CONFIG_HOME", tmpDir);
  Deno.env.set("XDG_CACHE_HOME", tmpDir);
  return { tmpDir, keys };
}

function restoreEnv(snap: EnvSnapshot): void {
  for (const [k, v] of Object.entries(snap.keys)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  Deno.remove(snap.tmpDir, { recursive: true }).catch(() => {
    // ignore
  });
}

// ---------------------------------------------------------------------------
// Tests — arg parsing paths (no daemon dependency, no env isolation needed)
// ---------------------------------------------------------------------------

Deno.test("cliMain: --help returns 0", async () => {
  assertEquals(await cliMain(["--help"]), 0);
});

Deno.test("cliMain: -h returns 0", async () => {
  assertEquals(await cliMain(["-h"]), 0);
});

Deno.test("cliMain: empty args returns 0", async () => {
  assertEquals(await cliMain([]), 0);
});

Deno.test("cliMain: unknown subcommand returns 2", async () => {
  assertEquals(await cliMain(["notasubcommand"]), 2);
});

// ---------------------------------------------------------------------------
// Tests — known subcommands with no daemon reachable → 2
// ---------------------------------------------------------------------------

Deno.test("cliMain: list with no daemon returns 2", async () => {
  const snap = await isolateEnv();
  try {
    assertEquals(await cliMain(["list"]), 2);
  } finally {
    restoreEnv(snap);
  }
});

Deno.test("cliMain: status with no daemon returns 2", async () => {
  const snap = await isolateEnv();
  try {
    assertEquals(await cliMain(["status"]), 2);
  } finally {
    restoreEnv(snap);
  }
});

Deno.test("cliMain: pair with no daemon returns 2", async () => {
  const snap = await isolateEnv();
  try {
    assertEquals(await cliMain(["pair"]), 2);
  } finally {
    restoreEnv(snap);
  }
});
