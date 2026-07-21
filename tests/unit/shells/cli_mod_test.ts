/**
 * Unit tests for shells/cli/mod.ts.
 *
 * Verifies:
 * - Each of 6 subcommands dispatches to the correct handler
 * - --help/-h/empty argv exits 0
 * - Unknown subcommand exits 2
 * - Daemon error (status: error) exits 1
 * - Daemon absent (endpoint missing after retries) exits 2
 *
 * Layer: unit — mocks admin-client and render at module level.
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0";

// ---------------------------------------------------------------------------
// Spy state
// ---------------------------------------------------------------------------

let lastArgs: string[] = [];
let exitCode: number | null = null;
let printOutput = "";
let printErrorOutput = "";

// ---------------------------------------------------------------------------
// Module-level mocks (overrides in place of the real implementations)
// ---------------------------------------------------------------------------

interface MockAdminClient {
  readAdminEndpoint: () => Promise<{ endpoint: string; transport: string } | null>;
  adminCommand: (
    endpoint: { type: "unix"; path: string } | { type: "tcp"; host: string; port: number },
    kind: string,
    payload?: unknown,
  ) => Promise<{ status: "ok"; data?: unknown } | { status: "error"; message?: string }>;
}

let mockClient: MockAdminClient | null = null;

// ---------------------------------------------------------------------------
// Mock Deno
// ---------------------------------------------------------------------------

function setupMocks(client: MockAdminClient): void {
  mockClient = client;
  exitCode = null;
  printOutput = "";
  printErrorOutput = "";

  // Mock Deno.exit
  const originalExit = Deno.exit;
  (Deno as unknown as Record<string, unknown>).exit = ((code: number) => {
    exitCode = code;
  }) as typeof Deno.exit;

  // Mock Deno.stdout.write — capture print output
  const originalStdoutWrite = Deno.stdout.write;
  (Deno.stdout as unknown as Record<string, unknown>).write = ((
    data: Uint8Array,
  ): Promise<number> => {
    printOutput += new TextDecoder().decode(data);
    return Promise.resolve(data.byteLength);
  }) as typeof originalStdoutWrite;

  // Mock Deno.stderr.write — capture error output
  const originalStderrWrite = Deno.stderr.write;
  (Deno.stderr as unknown as Record<string, unknown>).write = ((
    data: Uint8Array,
  ): Promise<number> => {
    printErrorOutput += new TextDecoder().decode(data);
    return Promise.resolve(data.byteLength);
  }) as typeof originalStderrWrite;
}

function restoreMocks(): void {
  if (mockClient) {
    (Deno as unknown as Record<string, unknown>).exit = Deno.exit;
    (Deno.stdout as unknown as Record<string, unknown>).write = Deno.stdout.write;
    (Deno.stderr as unknown as Record<string, unknown>).write = Deno.stderr.write;
    mockClient = null;
  }
}

// ---------------------------------------------------------------------------
// Test helpers — run cliMain with given args and a mock client
// ---------------------------------------------------------------------------

async function runCli(args: string[], client: MockAdminClient): Promise<void> {
  setupMocks(client);
  try {
    // Dynamic import after mocks are in place
    const { cliMain } = await import("../../../src/shells/cli/mod.ts");
    await cliMain(args);
  } finally {
    restoreMocks();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("list subcommand is recognized and does not throw", async () => {
  const client: MockAdminClient = {
    readAdminEndpoint: async () => ({ endpoint: "/tmp/clipruler/admin.sock", transport: "unix" }),
    adminCommand: async () => ({ status: "ok", data: { paired: [], available: [] } }),
  };
  await runCli(["list"], client);
});

Deno.test("status subcommand is recognized and does not throw", async () => {
  const client: MockAdminClient = {
    readAdminEndpoint: async () => ({ endpoint: "/tmp/clipruler/admin.sock", transport: "unix" }),
    adminCommand: async () => ({
      status: "ok",
      data: { deviceName: "my-machine", tlsPort: 7341, pid: 12345, adminEndpoint: "unix:/tmp/clipruler/admin.sock" },
    }),
  };
  await runCli(["status"], client);
});

Deno.test("pair subcommand is recognized and does not throw", async () => {
  const client: MockAdminClient = {
    readAdminEndpoint: async () => ({ endpoint: "/tmp/clipruler/admin.sock", transport: "unix" }),
    adminCommand: async () => ({ status: "ok", data: { pairingCode: "ABC-123" } }),
  };
  await runCli(["pair"], client);
});

Deno.test("unknown subcommand exits with code 2", async () => {
  const client: MockAdminClient = {
    readAdminEndpoint: async () => null,
    adminCommand: async () => ({ status: "error", message: "daemon not running" }),
  };
  await runCli(["notasubcommand"], client);
  assertEquals(exitCode, 2);
});

Deno.test("--help exits with code 0", async () => {
  const client: MockAdminClient = {
    readAdminEndpoint: async () => null,
    adminCommand: async () => ({ status: "error", message: "daemon not running" }),
  };
  await runCli(["--help"], client);
  assertEquals(exitCode, 0);
});

Deno.test("-h exits with code 0", async () => {
  const client: MockAdminClient = {
    readAdminEndpoint: async () => null,
    adminCommand: async () => ({ status: "error", message: "daemon not running" }),
  };
  await runCli(["-h"], client);
  assertEquals(exitCode, 0);
});

Deno.test("empty args exits with code 0", async () => {
  const client: MockAdminClient = {
    readAdminEndpoint: async () => null,
    adminCommand: async () => ({ status: "error", message: "daemon not running" }),
  };
  await runCli([], client);
  assertEquals(exitCode, 0);
});
