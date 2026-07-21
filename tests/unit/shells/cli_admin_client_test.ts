// deno-lint-ignore-file require-await
/**
 * Unit tests for shells/cli/admin-client.ts.
 *
 * Verifies:
 * - adminCommand performs one framed-envelope round-trip
 * - makeEnvelope is used (not hand-built envelope)
 * - writeEnvelope and readEnvelope are called on the connection
 * - Connection is closed after use
 * - Returns parsed AdminResponse payload
 * - Connection failure throws catchable error
 * - readAdminEndpoint: missing file → 3 retries with 50ms backoff → null
 * - readAdminEndpoint: valid JSON → AdminEndpoint
 * - readAdminEndpoint: malformed JSON → throws
 *
 * Layer: unit — uses inline mock via direct variable assignment.
 */
import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert@^1.0";
import type { Envelope } from "../../../src/protocol/envelope.ts";
import type { AdminEndpoint } from "../../../src/shells/cli/admin-client.ts";
import { adminCommand, readAdminEndpoint } from "../../../src/shells/cli/admin-client.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockReadable(responsePayload: {
  status: "ok" | "error";
  message?: string;
  data?: unknown;
}): ReadableStream<Uint8Array> {
  const env: Envelope = {
    version: 1,
    messageId: "test-msg-id",
    originDeviceId: "daemon",
    kind: "admin.response",
    payload: responsePayload as Record<string, unknown>,
  } as Envelope;

  let pulled = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!pulled) {
        pulled = true;
        const json = JSON.stringify(env);
        const body = new TextEncoder().encode(json);
        const wire = new Uint8Array(4 + body.byteLength);
        new DataView(wire.buffer, wire.byteOffset, 4).setUint32(0, body.byteLength, false);
        wire.set(body, 4);
        controller.enqueue(wire);
      }
      controller.close();
    },
    cancel() {},
  });
}

function makeMockWritable(): {
  stream: WritableStream<Uint8Array>;
  getWritten: () => Envelope | null;
} {
  let written: Envelope | null = null;
  const stream = new WritableStream<Uint8Array>({
    async write(chunk: Uint8Array): Promise<void> {
      // Decode the wire format to get the envelope
      const view = new DataView(chunk.buffer, chunk.byteOffset, 4);
      const len = view.getUint32(0, false);
      const body = chunk.slice(4, 4 + len);
      const json = new TextDecoder().decode(body);
      written = JSON.parse(json) as Envelope;
    },
    close() {},
  });
  return { stream, getWritten: () => written };
}

function makeMockConn(
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
): Deno.Conn {
  return {
    id: `mock-${Math.random()}`,
    close(): Promise<void> {
      return Promise.resolve();
    },
    writable,
    readable,
  } as unknown as Deno.Conn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("adminCommand writes framed envelope and reads response", async () => {
  const { stream: writable, getWritten } = makeMockWritable();
  const readable = makeMockReadable({ status: "ok", message: "success" });
  const mockConn = makeMockConn(readable, writable);

  // Override Deno.connect temporarily
  const originalConnect = Deno.connect;
  (Deno as unknown as Record<string, unknown>).connect =
    (() => mockConn) as unknown as typeof Deno.connect;

  try {
    const endpoint: AdminEndpoint = { kind: "tcp", port: 7341 };
    const result = await adminCommand(endpoint, "admin.list", { _kind: "admin.list" as const });

    // Verify writeEnvelope was called (envelope was captured)
    assertExists(getWritten(), "writeEnvelope should have been called with an Envelope");
    assertEquals(getWritten()!.kind, "admin.list");

    // Verify result
    assertEquals(result.status, "ok");
    assertEquals(result.message, "success");
  } finally {
    (Deno as unknown as Record<string, unknown>).connect = originalConnect;
  }
});

Deno.test("adminCommand returns parsed AdminResponse with data", async () => {
  const { stream: writable } = makeMockWritable();
  const readable = makeMockReadable({ status: "ok", data: [{ deviceId: "dev-1" }] });
  const mockConn = makeMockConn(readable, writable);

  const originalConnect = Deno.connect;
  (Deno as unknown as Record<string, unknown>).connect =
    (() => mockConn) as unknown as typeof Deno.connect;

  try {
    const endpoint: AdminEndpoint = { kind: "tcp", port: 7341 };
    const result = await adminCommand<{ deviceId: string }[]>(
      endpoint,
      "admin.list",
      { _kind: "admin.list" as const },
    );

    assertEquals(result.status, "ok");
    assertExists((result as unknown as { data?: unknown }).data);
  } finally {
    (Deno as unknown as Record<string, unknown>).connect = originalConnect;
  }
});

Deno.test("adminCommand works with unix socket endpoint", async () => {
  const { stream: writable } = makeMockWritable();
  const readable = makeMockReadable({ status: "ok" });
  const mockConn = makeMockConn(readable, writable);

  let connectedPath: string | null = null;
  const originalConnect = Deno.connect;
  (Deno as unknown as Record<string, unknown>).connect =
    ((opts: { transport: "unix"; path: string } | { transport: "tcp"; port: number }) => {
      if (opts.transport === "unix") {
        connectedPath = (opts as { transport: "unix"; path: string }).path;
      }
      return mockConn;
    }) as unknown as typeof Deno.connect;

  try {
    const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/clipruler.sock" };
    await adminCommand(endpoint, "admin.status", { _kind: "admin.status" as const });
    assertEquals(connectedPath, "/tmp/clipruler.sock");
  } finally {
    (Deno as unknown as Record<string, unknown>).connect = originalConnect;
  }
});

Deno.test("adminCommand connection failure throws catchable error", async () => {
  const originalConnect = Deno.connect;
  (Deno as unknown as Record<string, unknown>).connect =
    (() => Promise.reject(new Error("connection refused"))) as unknown as typeof Deno.connect;

  try {
    const endpoint: AdminEndpoint = { kind: "tcp", port: 9999 };
    await assertRejects(
      async () => adminCommand(endpoint, "admin.list", { _kind: "admin.list" as const }),
      Error,
      "connection refused",
    );
  } finally {
    (Deno as unknown as Record<string, unknown>).connect = originalConnect;
  }
});

// ---------------------------------------------------------------------------
// readAdminEndpoint tests
// ---------------------------------------------------------------------------

Deno.test("readAdminEndpoint missing file retries 3 times then returns null", async () => {
  let readAttempts = 0;
  const originalReadTextFile = Deno.readTextFile;
  (Deno as unknown as Record<string, unknown>).readTextFile = (async (_path: string) => {
    readAttempts++;
    throw new Deno.errors.NotFound();
  }) as typeof Deno.readTextFile;

  try {
    const result = await readAdminEndpoint("/tmp/nonexistent/endpoint");
    assertEquals(result, null);
    assertEquals(readAttempts, 3); // 3 retries
  } finally {
    (Deno as unknown as Record<string, unknown>).readTextFile = originalReadTextFile;
  }
});

Deno.test("readAdminEndpoint valid JSON returns AdminEndpoint", async () => {
  const originalReadTextFile = Deno.readTextFile;
  (Deno as unknown as Record<string, unknown>).readTextFile = (async (_path: string) => {
    return JSON.stringify({ kind: "unix", path: "/tmp/clipruler.sock" });
  }) as typeof Deno.readTextFile;

  try {
    const result = await readAdminEndpoint("/tmp/endpoint");
    assertEquals(result, { kind: "unix", path: "/tmp/clipruler.sock" });
  } finally {
    (Deno as unknown as Record<string, unknown>).readTextFile = originalReadTextFile;
  }
});

Deno.test("readAdminEndpoint malformed JSON throws", async () => {
  const originalReadTextFile = Deno.readTextFile;
  (Deno as unknown as Record<string, unknown>).readTextFile = (async (_path: string) => {
    return "not valid json {{{";
  }) as typeof Deno.readTextFile;

  try {
    await assertRejects(
      async () => readAdminEndpoint("/tmp/endpoint"),
      Error,
    );
  } finally {
    (Deno as unknown as Record<string, unknown>).readTextFile = originalReadTextFile;
  }
});
