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
import { readEnvelope, writeEnvelope } from "../../infrastructure/transport/index.ts";

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
export const adminCommand = async <T = unknown>(
  endpoint: AdminEndpoint,
  kind: import("../../protocol/envelope.ts").EnvelopeKind,
  payload: unknown,
): Promise<AdminResponse<T>> => {
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

    // Write the framed envelope. The frame is length-prefixed and self-delimiting,
    // so the daemon knows the request is complete without an EOF. We must NOT
    // close the writer here: on a real Deno socket, writer.close() tears down the
    // shared connection resource and the read below would throw
    // "The stream's underlying resource was closed or consumed". conn.close() in
    // the finally block owns full teardown.
    await writeEnvelope(writer, envelope);
    writer.releaseLock();

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
    // Guard against double-close when the server closes first (e.g., BrokenPipe)
    try {
      conn.close();
    } catch {
      // Connection already closed — ignore
    }
  }
};

// ---------------------------------------------------------------------------
// readAdminEndpoint — resolves daemon admin endpoint with retry
// ---------------------------------------------------------------------------

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 50;

/**
 * Read and parse the admin endpoint file.
 *
 * - Missing or empty file: retry 3× with 50ms backoff → null
 * - Valid JSON: returns AdminEndpoint (unix or tcp)
 * - Malformed JSON: throws
 */
export const readAdminEndpoint = async (
  adminEndpointFile: string,
): Promise<AdminEndpoint | null> => {
  for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
    try {
      const content = await Deno.readTextFile(adminEndpointFile);
      if (content.trim().length === 0) {
        // Empty file — treat as missing
        if (attempt < RETRY_COUNT - 1) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
        continue;
      }
      return JSON.parse(content) as AdminEndpoint;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        if (attempt < RETRY_COUNT - 1) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
        continue;
      }
      if (err instanceof SyntaxError) {
        throw new Error(`Malformed JSON in ${adminEndpointFile}: ${err.message}`);
      }
      throw err;
    }
  }
  return null;
};
