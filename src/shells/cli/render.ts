/**
 * shells/cli/render.ts
 *
 * Plain-text renderers for the CLI shell.
 *
 * Design (Plan 010):
 * - All renderers write to stdout
 * - Output MUST NOT contain ANSI color codes (CR-1/2/3)
 * - Simple, human-readable plain text format
 */

import type { DeviceListView } from "../../application/list-devices.ts";
import type { AdminResponse } from "./admin-client.ts";

// ---------------------------------------------------------------------------
// renderDevices — lists paired and available devices
// ---------------------------------------------------------------------------

/**
 * Render paired and available devices to stdout.
 * Output format:
 *   Paired devices:
 *     - {name} ({fingerprint}) clipboardSharing={enabled} reachable={reachable}
 *   Available devices:
 *     - {name} ({fingerprint}) at {remoteAddress}
 */
export async function renderDevices(view: DeviceListView): Promise<void> {
  const out = new TextEncoder();
  const writer = Deno.stdout.writable.getWriter();

  // Paired devices section
  const pairedHeader = "Paired devices:\n";
  await writer.write(out.encode(pairedHeader));

  if (view.paired.length === 0) {
    const none = "  (none)\n";
    await writer.write(out.encode(none));
  } else {
    for (const device of view.paired) {
      const line = `  - ${device.name} (${device.fingerprint}) ` +
        `clipboardSharing=${device.sharingEnabled} reachable=${device.reachable}\n`;
      await writer.write(out.encode(line));
    }
  }

  // Available devices section
  const availHeader = "Available devices:\n";
  await writer.write(out.encode(availHeader));

  if (view.available.length === 0) {
    const none = "  (none)\n";
    await writer.write(out.encode(none));
  } else {
    for (const device of view.available) {
      const line = `  - ${device.name} (${device.fingerprint}) at ${device.remoteAddress}\n`;
      await writer.write(out.encode(line));
    }
  }

  writer.releaseLock();
}

// ---------------------------------------------------------------------------
// renderStatus — prints daemon identity
// ---------------------------------------------------------------------------

/**
 * Render daemon status to stdout.
 * Output format:
 *   Device: {deviceName}
 *   TLS Port: {tlsPort}
 *   PID: {pid}
 *   Admin endpoint: {adminEndpoint}
 */
export async function renderStatus(
  view: AdminResponse<{
    deviceName: string;
    tlsPort: number;
    pid: number;
    adminEndpoint: string;
  }>,
): Promise<void> {
  const out = new TextEncoder();
  const writer = Deno.stdout.writable.getWriter();

  if (view.status === "error") {
    const msg = `Error: ${view.message ?? "unknown error"}\n`;
    await writer.write(out.encode(msg));
    writer.releaseLock();
    return;
  }

  const d = view.data!;
  const lines = [
    `Device: ${d.deviceName}\n`,
    `TLS Port: ${d.tlsPort}\n`,
    `PID: ${d.pid}\n`,
    `Admin endpoint: ${d.adminEndpoint}\n`,
  ];

  for (const line of lines) {
    await writer.write(out.encode(line));
  }

  writer.releaseLock();
}

// ---------------------------------------------------------------------------
// renderPairResult — echoes the pair response
// ---------------------------------------------------------------------------

/**
 * Render the pair response to stdout.
 * Prints the pairing code or message returned by the daemon.
 */
export async function renderPairResult(
  view: AdminResponse<{ pairingCode?: string; message?: string }>,
): Promise<void> {
  const out = new TextEncoder();
  const writer = Deno.stdout.writable.getWriter();

  if (view.status === "error") {
    const msg = `Pairing failed: ${view.message ?? "unknown error"}\n`;
    await writer.write(out.encode(msg));
    writer.releaseLock();
    return;
  }

  if (view.data?.pairingCode) {
    await writer.write(out.encode(`Pairing code: ${view.data.pairingCode}\n`));
  } else if (view.data?.message) {
    await writer.write(out.encode(`${view.data.message}\n`));
  } else {
    await writer.write(out.encode("Pairing initiated.\n"));
  }

  writer.releaseLock();
}
