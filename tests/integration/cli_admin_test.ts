/**
 * tests/integration/cli_admin_test.ts
 *
 * End-to-end integration test for the CLI admin channel.
 * Exercises the CLI subcommands against a real in-process daemon via cliMain.
 *
 * Approach: cliMain now returns an exit code (no Deno.exit), so each test calls
 * it directly in-process — no subprocess, no hardcoded paths. A real daemon is
 * started via the composition root in the same process, with env isolated to a
 * temp dir per test.
 *
 * Exit-code contract exercised:
 *   0 — subcommand round-trip succeeded (adminCommand ok + render completed)
 *   1 — daemon returned an error response (e.g. pair: "not yet implemented")
 *   2 — daemon not reachable (admin endpoint file absent after stop)
 *
 * Output assertions: mod.ts prints "OK" / "Device removed." via console.log
 * (captured here for enable/disable/forget). render*.ts write to the stdout
 * stream directly, so for status/list we rely on the exit code (which is 0
 * only if adminCommand AND the renderer both ran without throwing).
 *
 * sanitizeOps/sanitizeResources disabled: the daemon starts timers/sockets
 * (UDP beacon, admin listener) that Deno's sanitizers would otherwise flag.
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0";
import { cliMain } from "../../src/shells/cli/mod.ts";

// ---------------------------------------------------------------------------
// Console capture — mod.ts prints confirmation lines via console.log.
// ---------------------------------------------------------------------------

interface Captured {
  restore: () => void;
  output: () => string;
}

function captureConsole(): Captured {
  const original = console.log;
  let buffer = "";
  console.log = (...args: unknown[]) => {
    buffer += args.join(" ") + "\n";
  };
  return {
    restore: () => {
      console.log = original;
    },
    output: () => buffer,
  };
}

// ---------------------------------------------------------------------------
// Env isolation — point HOME/XDG at a fresh temp dir so each daemon gets its
// own PID lock, admin socket, and endpoint file. Fully restored in finally.
// ---------------------------------------------------------------------------

interface EnvSnapshot {
  tmpDir: string;
  keys: Record<string, string | undefined>;
}

async function isolateEnv(): Promise<EnvSnapshot> {
  const tmpDir = await Deno.makeTempDir();
  const dataDir = `${tmpDir}/clipruler`;
  await Deno.mkdir(dataDir, { recursive: true });
  const keys: Record<string, string | undefined> = {
    "HOME": Deno.env.get("HOME"),
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
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "e2e: status returns 0 while daemon runs, 2 after stop",
  fn: async () => {
    const snap = await isolateEnv();
    try {
      const { buildAndRunDaemon } = await import(
        "../../src/shells/composition-root.ts"
      );
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-e2e" });
      // Let the admin server bind and write the endpoint file.
      await new Promise((r) => setTimeout(r, 200));

      try {
        // Exit 0 requires adminCommand AND renderStatus to both succeed.
        assertEquals(
          await cliMain(["status"]),
          0,
          "status should succeed while daemon running",
        );
      } finally {
        await daemon.stop();
        // Release the UDP beacon socket before the next test binds it.
        await new Promise((r) => setTimeout(r, 300));
      }

      // After stop, endpoint file is gone → status returns 2.
      assertEquals(await cliMain(["status"]), 2, "status after stop should exit 2");
    } finally {
      restoreEnv(snap);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "e2e: list returns 0 while daemon runs, 2 after stop",
  fn: async () => {
    const snap = await isolateEnv();
    try {
      const { buildAndRunDaemon } = await import(
        "../../src/shells/composition-root.ts"
      );
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-list" });
      await new Promise((r) => setTimeout(r, 200));

      try {
        assertEquals(await cliMain(["list"]), 0, "list should exit 0");
      } finally {
        await daemon.stop();
        await new Promise((r) => setTimeout(r, 300));
      }

      assertEquals(await cliMain(["list"]), 2, "list after stop should exit 2");
    } finally {
      restoreEnv(snap);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "e2e: pair returns 1 while daemon runs (pairing not yet implemented), 2 after stop",
  fn: async () => {
    const snap = await isolateEnv();
    try {
      const { buildAndRunDaemon } = await import(
        "../../src/shells/composition-root.ts"
      );
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-pair" });
      await new Promise((r) => setTimeout(r, 200));

      try {
        // The daemon's admin.pair.request handler is a stub that returns
        // status:error "pairing not yet implemented (PR2)". cliMain maps a
        // daemon error response to exit 1.
        assertEquals(
          await cliMain(["pair"]),
          1,
          "pair should exit 1 (daemon reports pairing not yet implemented)",
        );
      } finally {
        await daemon.stop();
        await new Promise((r) => setTimeout(r, 300));
      }

      assertEquals(await cliMain(["pair"]), 2, "pair after stop should exit 2");
    } finally {
      restoreEnv(snap);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "e2e: enable returns 0 and prints OK while daemon runs, 2 after stop",
  fn: async () => {
    const snap = await isolateEnv();
    try {
      const { buildAndRunDaemon } = await import(
        "../../src/shells/composition-root.ts"
      );
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-enable" });
      await new Promise((r) => setTimeout(r, 200));

      try {
        const cap = captureConsole();
        let result: number;
        try {
          result = await cliMain(["enable", "test-fp-enable"]);
        } finally {
          cap.restore();
        }
        assertEquals(result, 0, "enable should exit 0");
        assertStringIncludes(cap.output(), "OK");
      } finally {
        await daemon.stop();
        await new Promise((r) => setTimeout(r, 300));
      }

      assertEquals(
        await cliMain(["enable", "test-fp-enable"]),
        2,
        "enable after stop should exit 2",
      );
    } finally {
      restoreEnv(snap);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "e2e: disable returns 0 and prints OK while daemon runs, 2 after stop",
  fn: async () => {
    const snap = await isolateEnv();
    try {
      const { buildAndRunDaemon } = await import(
        "../../src/shells/composition-root.ts"
      );
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-disable" });
      await new Promise((r) => setTimeout(r, 200));

      try {
        const cap = captureConsole();
        let result: number;
        try {
          result = await cliMain(["disable", "test-fp-disable"]);
        } finally {
          cap.restore();
        }
        assertEquals(result, 0, "disable should exit 0");
        assertStringIncludes(cap.output(), "OK");
      } finally {
        await daemon.stop();
        await new Promise((r) => setTimeout(r, 300));
      }

      assertEquals(
        await cliMain(["disable", "test-fp-disable"]),
        2,
        "disable after stop should exit 2",
      );
    } finally {
      restoreEnv(snap);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "e2e: forget returns 0 and reports device removed while daemon runs, 2 after stop",
  fn: async () => {
    const snap = await isolateEnv();
    try {
      const { buildAndRunDaemon } = await import(
        "../../src/shells/composition-root.ts"
      );
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-forget" });
      await new Promise((r) => setTimeout(r, 200));

      try {
        const cap = captureConsole();
        let result: number;
        try {
          result = await cliMain(["forget", "unknown-fp-forget-test"]);
        } finally {
          cap.restore();
        }
        assertEquals(result, 0, "forget should exit 0");
        assertStringIncludes(
          cap.output(),
          "removed",
          "forget output should indicate device removed",
        );
      } finally {
        await daemon.stop();
        await new Promise((r) => setTimeout(r, 300));
      }

      assertEquals(
        await cliMain(["forget", "unknown-fp-forget-test"]),
        2,
        "forget after stop should exit 2",
      );
    } finally {
      restoreEnv(snap);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});

Deno.test({
  name: "e2e: status returns 0 before stop, 2 after stop (lifecycle)",
  fn: async () => {
    const snap = await isolateEnv();
    try {
      const { buildAndRunDaemon } = await import(
        "../../src/shells/composition-root.ts"
      );
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-absent" });
      await new Promise((r) => setTimeout(r, 200));

      // Status succeeds while running.
      assertEquals(await cliMain(["status"]), 0);

      await daemon.stop();
      await new Promise((r) => setTimeout(r, 300));

      // After stop, endpoint file is removed → status returns 2.
      assertEquals(await cliMain(["status"]), 2);
    } finally {
      restoreEnv(snap);
    }
  },
  sanitizeOps: false,
  sanitizeResources: false,
});
