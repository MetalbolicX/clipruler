/**
 * tests/integration/main_dispatch_test.ts
 *
 * Integration test for main.ts dispatch logic.
 * Strict TDD: RED first — verifies routing to daemonMain vs cliMain.
 *
 * Tests exit code propagation by running main.ts as a subprocess.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";

/** Run main.ts with given args and capture exit code. */
async function runMain(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "file:///home/metalbolicx/Documents/clipruler/main.ts", ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await proc.output();
  return {
    code: code ?? 0,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

Deno.test("main dispatch: 'daemon' routes to daemonMain (not cliMain)", async () => {
  // Run with 'daemon' — should route to daemonMain (the plan-009 path).
  // The daemon may fail to start in this environment (permissions/net), but
  // routing to daemonMain is verified by the output: it should NOT contain
  // "Unknown subcommand: daemon" (which would indicate cliMain routing).
  const result = await runMain(["daemon"]);
  // daemonMain output includes "Starting clipruler daemon" or similar.
  // If routed to cliMain: stderr would say "Unknown subcommand: daemon"
  // We check it does NOT say unknown subcommand (proving daemonMain was called)
  assertEquals(
    result.stderr.includes("Unknown subcommand: daemon"),
    false,
    "daemon arg should not be routed to cliMain",
  );
});

Deno.test("main dispatch: 'status' routes to cliMain (exit 2 — daemon not running)", async () => {
  const result = await runMain(["status"]);
  // cliMain called → daemon not running → exit 2 (endpoint not found after retries)
  assertEquals(result.code, 2, "status without daemon should exit 2");
  assertEquals(
    result.stderr.includes("daemon not reachable"),
    true,
    "should report daemon not reachable",
  );
});

Deno.test("main dispatch: '--help' exits 0 (handled before routing)", async () => {
  const result = await runMain(["--help"]);
  assertEquals(result.code, 0, "--help should exit 0");
});

Deno.test("main dispatch: '--version' exits 0 (handled before routing)", async () => {
  const result = await runMain(["--version"]);
  assertEquals(result.code, 0, "--version should exit 0");
});

Deno.test("main dispatch: no args exits 1 (no subcommand)", async () => {
  const result = await runMain([]);
  assertEquals(result.code, 1, "no args should exit 1");
});

Deno.test("main dispatch: unknown subcommand exits 2 (routed to cliMain)", async () => {
  const result = await runMain(["notasubcommand"]);
  // cliMain receives unknown subcommand → exit 2
  assertEquals(result.code, 2, "unknown subcommand should exit 2");
});

Deno.test("main dispatch: 'desktop' routes to desktopMain (not cliMain)", async () => {
  // Run with 'desktop' — should route to desktopMain (not cliMain).
  // If routed to cliMain: stderr would say "Unknown subcommand: desktop"
  const result = await runMain(["desktop"]);
  assertEquals(
    result.stderr.includes("Unknown subcommand: desktop"),
    false,
    "desktop arg should not be routed to cliMain",
  );
});

Deno.test("main dispatch: 'desktop --help' routes to desktopMain and exits 0", async () => {
  const result = await runMain(["desktop", "--help"]);
  // desktopMain handles --help and returns 0
  assertEquals(result.code, 0, "desktop --help should exit 0");
});

Deno.test("main dispatch: 'desktop' on headless Linux exits 1 with headless reason", async () => {
  // If host has no display and is Linux, desktopMain headless guard fails → exit 1
  const result = await runMain(["desktop"]);
  // On headless Linux: exit 1 with headless reason; on display host: exit 0
  // We verify routing: should NOT be routed to cliMain
  assertEquals(
    result.stderr.includes("Unknown subcommand: desktop"),
    false,
    "desktop should not be routed to cliMain",
  );
  // In headless env: code should be 1
  if (!Deno.env.get("WAYLAND_DISPLAY") && !Deno.env.get("DISPLAY") && Deno.build.os === "linux") {
    assertEquals(result.code, 1, "headless environment should exit 1");
    assertEquals(
      result.stderr.includes("No display server found"),
      true,
      "should report headless reason",
    );
  }
});
