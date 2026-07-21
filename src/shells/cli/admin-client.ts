/**
 * shells/cli/admin-client.ts
 *
 * Admin channel client for the CLI shell.
 *
 * Design (Plan 010):
 * - Uses makeEnvelope() (M2/M3) for outbound envelopes
 * - Uses writeEnvelope/readEnvelope from the transport barrel (M1)
 * - AdminEndpoint: unix socket (POSIX) or TCP port (Windows)
 * - AdminResponse: { status: "ok"|"error", data?, message? }
 * - The daemon JSON-stringifies admin.status and admin.list into message;
 *   client MUST JSON.parse(message) into data.
 */

import { makeEnvelope } from "../../protocol/envelope.ts";
import { writeEnvelope, readEnvelope } from "../../infrastructure/transport/index.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AdminEndpoint =
  | { readonly kind: "unix"; readonly path: string }
  | { readonly kind: "tcp"; readonly port: number };

export interface AdminResponse<T = unknown> {
  readonly status: "ok" | "error";
  readonly data?: T;
  readonly message?: string;
}

// ---------------------------------------------------------------------------
// adminCommand — single round-trip on the admin channel
// ---------------------------------------------------------------------------

/**
 * Perform a single framed-envelope round-trip on the admin channel.
 *
 * @param endpoint - Resolved admin endpoint (unix socket or TCP port)
 * @param kind - EnvelopeKind for the request
 * @param payload - Request payload (typed per kind)
 * @returns Parsed AdminResponse from the daemon
 * @throws Error if the connection fails (caller maps to exit code 2)
 */
export async function adminCommand<T = unknown>(
  endpoint: AdminEndpoint,
  kind: import("../../protocol/envelope.ts").EnvelopeKind,
  payload: unknown,
): Promise<AdminResponse<T>> {
  // Connect to the admin endpoint
  const conn = endpoint.kind === "unix"
    ? await Deno.connect({ transport: "unix", path: endpoint.path })
    : await Deno.connect({ transport: "tcp", port: endpoint.port, hostname: "127.0.0.1" });

  try {
    const writer = conn.writable.getWriter();
    const reader = conn.readable.getReader();

    // Build the request envelope using makeEnvelope (M2/M3)
    // originDeviceId is the local device identity; we use a placeholder
    // since the daemon doesn't validate it for admin commands.
    const envelope = makeEnvelope(
      "clipruler-admin",
      kind,
      payload as import("../../protocol/envelope.ts").PayloadByKind<typeof kind>,
    );

    // Write the framed envelope
    await writeEnvelope(writer, envelope);
    await writer.close();

    // Read one response envelope
    const responseEnvelope = await readEnvelope(reader);
    reader.releaseLock();

    // The daemon JSON-stringifies the payload into responseEnvelope.payload.message
    // We need to parse it to get the actual data.
    const responsePayload = responseEnvelope.payload as {
      status: "ok" | "error";
      message?: string;
      data?: T;
    };

    // If the daemon returned a JSON-stringified message, parse it
    if (typeof responsePayload.message === "string") {
      try {
        const parsed = JSON.parse(responsePayload.message);
        return {
          status: responsePayload.status,
          data: parsed as T,
          message: responsePayload.message,
        };
      } catch {
        // Not JSON — return as-is (plain string messages)
        return {
          status: responsePayload.status,
          message: responsePayload.message,
        };
      }
    }

    return {
      status: responsePayload.status,
      data: responsePayload.data as T,
    };
  } finally {
    await conn.close();
  }
}
