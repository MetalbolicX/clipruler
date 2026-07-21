/**
 * Unit tests for shells/cli/render.ts.
 *
 * Verifies:
 * - renderDevices outputs device list without ANSI codes
 * - renderStatus outputs daemon status without ANSI codes
 * - renderPairResult echoes the response without ANSI codes
 *
 * Layer: unit — captures stdout for assertion.
 */
import { assertMatch, assertNotMatch } from "jsr:@std/assert@^1.0";
import type { DeviceListView } from "../../../src/application/list-devices.ts";
import type { AdminResponse } from "../../../src/shells/cli/admin-client.ts";
import { renderDevices, renderPairResult, renderStatus } from "../../../src/shells/cli/render.ts";

// ANSI color code pattern — output MUST NOT contain these
// deno-lint-ignore no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const mockDeviceListView: DeviceListView = {
  paired: [{
    deviceId: "dev-123" as import("../../../src/domain/device.ts").DeviceId,
    fingerprint: "fp-aaaa" as import("../../../src/domain/device.ts").PublicKeyFingerprint,
    name: "My Laptop",
    sharingEnabled: true,
    reachable: true,
  }],
  available: [{
    fingerprint: "fp-bbbb" as import("../../../src/domain/device.ts").PublicKeyFingerprint,
    name: "Neighbor Desktop",
    remoteAddress: "192.168.1.50:7341",
    tlsPort: 7341,
  }],
};

const mockStatusView: AdminResponse<{
  deviceName: string;
  tlsPort: number;
  pid: number;
  adminEndpoint: string;
}> = {
  status: "ok",
  data: {
    deviceName: "my-machine",
    tlsPort: 7341,
    pid: 12345,
    adminEndpoint: "unix:/tmp/clipruler/admin.sock",
  },
};

const mockPairView: AdminResponse<{ pairingCode?: string; message?: string }> = {
  status: "ok",
  data: { pairingCode: "ABC-123" },
};

// ---------------------------------------------------------------------------
// Capture stdout helper
// ---------------------------------------------------------------------------

async function captureRenderOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: Uint8Array[] = [];
  const writer = {
    write(chunk: Uint8Array): Promise<void> {
      chunks.push(chunk);
      return Promise.resolve();
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
    releaseLock(): void {},
  };

  const originalStdout = Deno.stdout;
  Object.defineProperty(Deno, "stdout", {
    value: {
      writable: new WritableStream<Uint8Array>({
        write(chunk: Uint8Array) {
          chunks.push(chunk);
        },
        close() {},
      }),
      getWriter() {
        return writer;
      },
    },
    writable: true,
    configurable: true,
  });

  try {
    await fn();
  } finally {
    Object.defineProperty(Deno, "stdout", {
      value: originalStdout,
      writable: true,
      configurable: true,
    });
  }

  const totalLen = chunks.reduce((acc, b) => acc + b.byteLength, 0);
  const buf = new Uint8Array(totalLen);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

// ---------------------------------------------------------------------------
// renderDevices tests
// ---------------------------------------------------------------------------

Deno.test("renderDevices outputs paired and available sections without ANSI", async () => {
  const output = await captureRenderOutput(async () => {
    await renderDevices(mockDeviceListView);
  });

  // Contains expected content
  assertMatch(output, /Paired devices:/);
  assertMatch(output, /My Laptop/);
  assertMatch(output, /Available devices:/);
  // No ANSI codes
  assertNotMatch(output, ANSI_PATTERN);
});

Deno.test("renderStatus outputs daemon identity without ANSI", async () => {
  const output = await captureRenderOutput(async () => {
    await renderStatus(mockStatusView);
  });

  assertNotMatch(output, ANSI_PATTERN);
});

Deno.test("renderPairResult echoes the pairing code without ANSI", async () => {
  const output = await captureRenderOutput(async () => {
    await renderPairResult(mockPairView);
  });

  assertNotMatch(output, ANSI_PATTERN);
});
