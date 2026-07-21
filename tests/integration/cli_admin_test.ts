/**
 * tests/integration/cli_admin_test.ts
 *
 * End-to-end integration test for the CLI admin channel.
 * Exercises all six CLI subcommands against a real daemon via cliMain.
 *
 * Strict TDD: RED first — this test will fail until all wiring is complete.
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Run clipruler as a subprocess with the given argv.
 * Uses --no-check to speed up CLI startup (skip type checking).
 */
async function runClipruler(args: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const proc = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-check",
      "--allow-all",
      "file:///home/metalbolicx/Documents/clipruler/main.ts",
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
    // Pass temp dir env so daemon state is isolated
    env: {
      HOME: Deno.env.get("HOME") ?? "/tmp",
      XDG_DATA_HOME: Deno.env.get("XDG_DATA_HOME") ?? "/tmp",
      XDG_CONFIG_HOME: Deno.env.get("XDG_CONFIG_HOME") ?? "/tmp",
      XDG_CACHE_HOME: Deno.env.get("XDG_CACHE_HOME") ?? "/tmp",
    },
  });
  const { code, stdout, stderr } = await proc.output();
  return {
    code: code ?? 0,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

// ---------------------------------------------------------------------------
// RED tests — these should fail until all wiring is complete
// ---------------------------------------------------------------------------

Deno.test({
  name: "e2e: daemon start then stop, cli returns exit 2",
  fn: async () => {
    // Create temp directory for isolated daemon state
    const tmpDir = await Deno.makeTempDir();
    const dataDir = `${tmpDir}/clipruler`;
    await Deno.mkdir(dataDir, { recursive: true });

    const origHome = Deno.env.get("HOME");
    const origXdgDataHome = Deno.env.get("XDG_DATA_HOME");
    const origXdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgCacheHome = Deno.env.get("XDG_CACHE_HOME");

    try {
      Deno.env.set("HOME", tmpDir);
      Deno.env.set("XDG_DATA_HOME", tmpDir);
      Deno.env.set("XDG_CONFIG_HOME", tmpDir);
      Deno.env.set("XDG_CACHE_HOME", tmpDir);

      // Import and start daemon
      const { buildAndRunDaemon } = await import("../../src/shells/composition-root.ts");
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-e2e" });

      // Give the admin server time to bind the socket and write the endpoint file
      await new Promise((r) => setTimeout(r, 500));

      // Verify daemon is reachable
      const statusResult = await runClipruler(["status"]);
      assertEquals(
        statusResult.code,
        0,
        `status should succeed while daemon running, got ${statusResult.code}: ${statusResult.stderr}`,
      );
      assertStringIncludes(statusResult.stdout, "test-device-e2e");

      // Stop daemon
      await daemon.stop();

      // Give a moment for cleanup
      await new Promise((r) => setTimeout(r, 500));

      // Now status should return exit 2 (daemon not running)
      const afterStopResult = await runClipruler(["status"]);
      assertEquals(
        afterStopResult.code,
        2,
        `status after daemon stop should exit 2, got ${afterStopResult.code}: ${afterStopResult.stderr}`,
      );
    } finally {
      if (origHome !== undefined) Deno.env.set("HOME", origHome);
      else Deno.env.delete("HOME");
      if (origXdgDataHome !== undefined) Deno.env.set("XDG_DATA_HOME", origXdgDataHome);
      else Deno.env.delete("XDG_DATA_HOME");
      if (origXdgConfigHome !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdgConfigHome);
      else Deno.env.delete("XDG_CONFIG_HOME");
      if (origXdgCacheHome !== undefined) Deno.env.set("XDG_CACHE_HOME", origXdgCacheHome);
      else Deno.env.delete("XDG_CACHE_HOME");

      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* ignore */ }
    }
  },
});

Deno.test({
  name: "e2e: 'list' returns paired/available device list",
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    const dataDir = `${tmpDir}/clipruler`;
    await Deno.mkdir(dataDir, { recursive: true });

    const origHome = Deno.env.get("HOME");
    const origXdgDataHome = Deno.env.get("XDG_DATA_HOME");
    const origXdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgCacheHome = Deno.env.get("XDG_CACHE_HOME");

    try {
      Deno.env.set("HOME", tmpDir);
      Deno.env.set("XDG_DATA_HOME", tmpDir);
      Deno.env.set("XDG_CONFIG_HOME", tmpDir);
      Deno.env.set("XDG_CACHE_HOME", tmpDir);

      const { buildAndRunDaemon } = await import("../../src/shells/composition-root.ts");
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-list" });

      await new Promise((r) => setTimeout(r, 500));

      const result = await runClipruler(["list"]);
      assertEquals(
        result.code,
        0,
        `list should exit 0, got ${result.code}: ${result.stderr}`,
      );
      // Output should mention "Paired devices" or "Available devices"
      assertStringIncludes(result.stdout, "devices");

      await daemon.stop();
    } finally {
      if (origHome !== undefined) Deno.env.set("HOME", origHome);
      else Deno.env.delete("HOME");
      if (origXdgDataHome !== undefined) Deno.env.set("XDG_DATA_HOME", origXdgDataHome);
      else Deno.env.delete("XDG_DATA_HOME");
      if (origXdgConfigHome !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdgConfigHome);
      else Deno.env.delete("XDG_CONFIG_HOME");
      if (origXdgCacheHome !== undefined) Deno.env.set("XDG_CACHE_HOME", origXdgCacheHome);
      else Deno.env.delete("XDG_CACHE_HOME");

      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* ignore */ }
    }
  },
});

Deno.test({
  name: "e2e: 'pair' with fingerprint exits 0 (daemon handles not-implemented gracefully)",
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    const dataDir = `${tmpDir}/clipruler`;
    await Deno.mkdir(dataDir, { recursive: true });

    const origHome = Deno.env.get("HOME");
    const origXdgDataHome = Deno.env.get("XDG_DATA_HOME");
    const origXdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgCacheHome = Deno.env.get("XDG_CACHE_HOME");

    try {
      Deno.env.set("HOME", tmpDir);
      Deno.env.set("XDG_DATA_HOME", tmpDir);
      Deno.env.set("XDG_CONFIG_HOME", tmpDir);
      Deno.env.set("XDG_CACHE_HOME", tmpDir);

      const { buildAndRunDaemon } = await import("../../src/shells/composition-root.ts");
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-pair" });

      await new Promise((r) => setTimeout(r, 500));

      const result = await runClipruler(["pair", "test-fingerprint-abc123"]);
      // Pair returns exit 0 (daemon acknowledges and prints message, even if not fully implemented)
      assertEquals(
        result.code,
        0,
        `pair should exit 0, got ${result.code}: ${result.stderr}`,
      );

      await daemon.stop();
    } finally {
      if (origHome !== undefined) Deno.env.set("HOME", origHome);
      else Deno.env.delete("HOME");
      if (origXdgDataHome !== undefined) Deno.env.set("XDG_DATA_HOME", origXdgDataHome);
      else Deno.env.delete("XDG_DATA_HOME");
      if (origXdgConfigHome !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdgConfigHome);
      else Deno.env.delete("XDG_CONFIG_HOME");
      if (origXdgCacheHome !== undefined) Deno.env.set("XDG_CACHE_HOME", origXdgCacheHome);
      else Deno.env.delete("XDG_CACHE_HOME");

      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* ignore */ }
    }
  },
});

Deno.test({
  name: "e2e: 'enable' exits 0 (state change acknowledged)",
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    const dataDir = `${tmpDir}/clipruler`;
    await Deno.mkdir(dataDir, { recursive: true });

    const origHome = Deno.env.get("HOME");
    const origXdgDataHome = Deno.env.get("XDG_DATA_HOME");
    const origXdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgCacheHome = Deno.env.get("XDG_CACHE_HOME");

    try {
      Deno.env.set("HOME", tmpDir);
      Deno.env.set("XDG_DATA_HOME", tmpDir);
      Deno.env.set("XDG_CONFIG_HOME", tmpDir);
      Deno.env.set("XDG_CACHE_HOME", tmpDir);

      const { buildAndRunDaemon } = await import("../../src/shells/composition-root.ts");
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-enable" });

      await new Promise((r) => setTimeout(r, 500));

      const result = await runClipruler(["enable", "test-fp-enable", "--enable"]);
      assertEquals(
        result.code,
        0,
        `enable should exit 0, got ${result.code}: ${result.stderr}`,
      );
      assertStringIncludes(result.stdout, "OK");

      await daemon.stop();
    } finally {
      if (origHome !== undefined) Deno.env.set("HOME", origHome);
      else Deno.env.delete("HOME");
      if (origXdgDataHome !== undefined) Deno.env.set("XDG_DATA_HOME", origXdgDataHome);
      else Deno.env.delete("XDG_DATA_HOME");
      if (origXdgConfigHome !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdgConfigHome);
      else Deno.env.delete("XDG_CONFIG_HOME");
      if (origXdgCacheHome !== undefined) Deno.env.set("XDG_CACHE_HOME", origXdgCacheHome);
      else Deno.env.delete("XDG_CACHE_HOME");

      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* ignore */ }
    }
  },
});

Deno.test({
  name: "e2e: 'disable' exits 0 (state change acknowledged)",
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    const dataDir = `${tmpDir}/clipruler`;
    await Deno.mkdir(dataDir, { recursive: true });

    const origHome = Deno.env.get("HOME");
    const origXdgDataHome = Deno.env.get("XDG_DATA_HOME");
    const origXdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgCacheHome = Deno.env.get("XDG_CACHE_HOME");

    try {
      Deno.env.set("HOME", tmpDir);
      Deno.env.set("XDG_DATA_HOME", tmpDir);
      Deno.env.set("XDG_CONFIG_HOME", tmpDir);
      Deno.env.set("XDG_CACHE_HOME", tmpDir);

      const { buildAndRunDaemon } = await import("../../src/shells/composition-root.ts");
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-disable" });

      await new Promise((r) => setTimeout(r, 500));

      const result = await runClipruler(["disable", "test-fp-disable", "--disable"]);
      assertEquals(
        result.code,
        0,
        `disable should exit 0, got ${result.code}: ${result.stderr}`,
      );
      assertStringIncludes(result.stdout, "OK");

      await daemon.stop();
    } finally {
      if (origHome !== undefined) Deno.env.set("HOME", origHome);
      else Deno.env.delete("HOME");
      if (origXdgDataHome !== undefined) Deno.env.set("XDG_DATA_HOME", origXdgDataHome);
      else Deno.env.delete("XDG_DATA_HOME");
      if (origXdgConfigHome !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdgConfigHome);
      else Deno.env.delete("XDG_CONFIG_HOME");
      if (origXdgCacheHome !== undefined) Deno.env.set("XDG_CACHE_HOME", origXdgCacheHome);
      else Deno.env.delete("XDG_CACHE_HOME");

      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* ignore */ }
    }
  },
});

Deno.test({
  name: "e2e: 'forget' with fingerprint exits 0 (ForgetDevice called)",
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    const dataDir = `${tmpDir}/clipruler`;
    await Deno.mkdir(dataDir, { recursive: true });

    const origHome = Deno.env.get("HOME");
    const origXdgDataHome = Deno.env.get("XDG_DATA_HOME");
    const origXdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgCacheHome = Deno.env.get("XDG_CACHE_HOME");

    try {
      Deno.env.set("HOME", tmpDir);
      Deno.env.set("XDG_DATA_HOME", tmpDir);
      Deno.env.set("XDG_CONFIG_HOME", tmpDir);
      Deno.env.set("XDG_CACHE_HOME", tmpDir);

      const { buildAndRunDaemon } = await import("../../src/shells/composition-root.ts");
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-forget" });

      await new Promise((r) => setTimeout(r, 500));

      // Forget an unknown fingerprint — should return ok (no-op per spec)
      const result = await runClipruler(["forget", "unknown-fp-forget-test"]);
      assertEquals(
        result.code,
        0,
        `forget should exit 0, got ${result.code}: ${result.stderr}`,
      );
      assertStringIncludes(
        result.stdout,
        "removed",
        "forget output should indicate device removed",
      );

      await daemon.stop();
    } finally {
      if (origHome !== undefined) Deno.env.set("HOME", origHome);
      else Deno.env.delete("HOME");
      if (origXdgDataHome !== undefined) Deno.env.set("XDG_DATA_HOME", origXdgDataHome);
      else Deno.env.delete("XDG_DATA_HOME");
      if (origXdgConfigHome !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdgConfigHome);
      else Deno.env.delete("XDG_CONFIG_HOME");
      if (origXdgCacheHome !== undefined) Deno.env.set("XDG_CACHE_HOME", origXdgCacheHome);
      else Deno.env.delete("XDG_CACHE_HOME");

      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* ignore */ }
    }
  },
});

Deno.test({
  name: "e2e: 'status' after daemon stop exits 2 (daemon absent)",
  fn: async () => {
    const tmpDir = await Deno.makeTempDir();
    const dataDir = `${tmpDir}/clipruler`;
    await Deno.mkdir(dataDir, { recursive: true });

    const origHome = Deno.env.get("HOME");
    const origXdgDataHome = Deno.env.get("XDG_DATA_HOME");
    const origXdgConfigHome = Deno.env.get("XDG_CONFIG_HOME");
    const origXdgCacheHome = Deno.env.get("XDG_CACHE_HOME");

    try {
      Deno.env.set("HOME", tmpDir);
      Deno.env.set("XDG_DATA_HOME", tmpDir);
      Deno.env.set("XDG_CONFIG_HOME", tmpDir);
      Deno.env.set("XDG_CACHE_HOME", tmpDir);

      const { buildAndRunDaemon } = await import("../../src/shells/composition-root.ts");
      const daemon = await buildAndRunDaemon({ deviceName: "test-device-absent" });

      await new Promise((r) => setTimeout(r, 500));
      await daemon.stop();
      await new Promise((r) => setTimeout(r, 200));

      // After daemon stops, status should exit 2 (daemon not running)
      const result = await runClipruler(["status"]);
      assertEquals(
        result.code,
        2,
        `status after daemon stop should exit 2, got ${result.code}: ${result.stderr}`,
      );
      assertStringIncludes(result.stderr, "not reachable", "should report daemon not reachable");
    } finally {
      if (origHome !== undefined) Deno.env.set("HOME", origHome);
      else Deno.env.delete("HOME");
      if (origXdgDataHome !== undefined) Deno.env.set("XDG_DATA_HOME", origXdgDataHome);
      else Deno.env.delete("XDG_DATA_HOME");
      if (origXdgConfigHome !== undefined) Deno.env.set("XDG_CONFIG_HOME", origXdgConfigHome);
      else Deno.env.delete("XDG_CONFIG_HOME");
      if (origXdgCacheHome !== undefined) Deno.env.set("XDG_CACHE_HOME", origXdgCacheHome);
      else Deno.env.delete("XDG_CACHE_HOME");

      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch { /* ignore */ }
    }
  },
});
