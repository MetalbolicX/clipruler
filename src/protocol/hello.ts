/**
 * protocol/hello.ts
 *
 * Wire-format hello payload — initial handshake.
 * No Deno.* imports.
 */

export type HelloPayload = {
  /** Human-readable device name for discovery. */
  readonly deviceName: string;
  /** Wire protocol version — must match PROTOCOL_VERSION. */
  readonly protocolVersion: number;
};
