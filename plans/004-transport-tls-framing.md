# Plan 004: Transport — TLS TCP + length-prefixed framing

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: 003
- **Category**: feature

## Why this matters

The transport is the security boundary of the protocol. Length-prefixed framing prevents stream
corruption; TLS with pinned peer public keys prevents LAN-level MitM. Every later phase depends on
this layer being reliable and authenticated.

## Current state

After 003: identity (`FileKeyStore`, Ed25519 keypair), state store, PID lock, ports and logger
exist. No transport code, no TLS wiring, no framing.

## Commands you will need

| Purpose            | Command                                                 |
| ------------------ | ------------------------------------------------------- |
| Check              | `deno task check`                                       |
| Test               | `deno task test --allow-net --allow-read --allow-write` |
| Framing round-trip | `deno test --filter framing`                            |

## Scope

**In scope**:

- `src/ports/transport.ts`
- `src/infrastructure/transport/framing.ts`
- `src/infrastructure/transport/tls-cert.ts`
- `src/infrastructure/transport/tls-tcp.ts`
- `src/infrastructure/transport/reconnect.ts`
- `src/infrastructure/transport/mod.ts` (factory)
- `tests/unit/infrastructure/framing_test.ts`
- `tests/integration/transport_tls_test.ts`

**Out of scope**:

- mDNS / UDP beacon (Plan 006).
- Actual pairing handshake (Plan 007).
- Clipboard event broadcasting (Plan 008).

## Dependency note (ROI)

- Self-signed TLS certificate: Deno's `Deno.connectTLS` and `Deno.listenTls` accept a `cert` + `key`
  pair. Generating the certificate requires ASN.1 DER encoding.
- **Considered third-party**: `@denosaurs/tls` or `selfsigned` npm package. **Decision**: reject.
  The shape we need is fixed (one self-signed cert per device, CN = device ID, 30-day validity,
  refreshed automatically). Hand-rolled DER builder is ~150 lines and has no supply-chain risk. If
  hand-rolling proves fragile in tests, escalate before pulling a dependency.
- `@std/streams`: used for `readAll` / `writeAll` helpers if needed. Std.

## Architecture constraints

- Transport implements a `Transport` port that exposes `send(envelope)` and `subscribe(handler)`.
  The application never sees raw TLS sockets.
- Reconnect lives in its own adapter so the listener can be tested without reconnect logic.

## Steps

### Step 1: Port — transport

Create `src/ports/transport.ts`:

```ts
import type { Envelope } from "../protocol/envelope.ts";

export interface Transport {
  /** Send to a specific connected peer. */
  send(peerFingerprint: string, envelope: Envelope<unknown>): Promise<void>;
  /** Broadcast to all connected peers. */
  broadcast(envelope: Envelope<unknown>): Promise<void>;
  /** Subscribe to incoming envelopes. Returns an unsubscribe function. */
  subscribe(handler: (env: Envelope<unknown>) => void): () => void;
  /** Graceful shutdown of all connections. */
  close(): Promise<void>;
}
```

### Step 2: Framing — length-prefixed

Create `src/infrastructure/transport/framing.ts`:

```ts
import { readAll, writeAll } from "@std/streams";

// Wire layout for one envelope:
//   [4 bytes big-endian unsigned length][length bytes UTF-8 JSON]
//
// 32-bit length prefix gives us ~4 GiB max envelope, far beyond MVP.
// Use a DataView for unambiguous big-endian encoding.

const LENGTH_BYTES = 4;
const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024; // 16 MiB guard

export async function writeEnvelope(
  writer: Deno.Writer,
  envelope: unknown,
): Promise<void> {
  const json = new TextEncoder().encode(JSON.stringify(envelope));
  if (json.byteLength > MAX_ENVELOPE_BYTES) {
    throw new Error(`envelope too large: ${json.byteLength} bytes`);
  }
  const prefix = new Uint8Array(LENGTH_BYTES);
  new DataView(prefix.buffer).setUint32(0, json.byteLength, false); // big-endian
  await writeAll(writer, prefix);
  await writeAll(writer, json);
}

export async function readEnvelope(
  reader: Deno.Reader,
): Promise<unknown | null> {
  const prefix = new Uint8Array(LENGTH_BYTES);
  const n = await readExact(reader, prefix);
  if (n === 0) return null; // clean EOF
  if (n < LENGTH_BYTES) {
    throw new Error("truncated length prefix");
  }
  const len = new DataView(prefix.buffer).getUint32(0, false);
  if (len > MAX_ENVELOPE_BYTES) {
    throw new Error(`announced envelope too large: ${len}`);
  }
  const body = new Uint8Array(len);
  const bodyN = await readExact(reader, body);
  if (bodyN < len) throw new Error("truncated envelope body");
  return JSON.parse(new TextDecoder().decode(body));
}

async function readExact(
  reader: Deno.Reader,
  dst: Uint8Array,
): Promise<number> {
  let read = 0;
  const buf = new Uint8Array(dst.byteLength);
  while (read < dst.byteLength) {
    const n = await reader.read(buf);
    if (n === null) return read;
    dst.set(buf.subarray(0, n), read);
    read += n;
  }
  return read;
}
```

**Verify**: `deno check src/infrastructure/transport/framing.ts` exits 0.

### Step 3: Self-signed cert generator

Create `src/infrastructure/transport/tls-cert.ts`:

```ts
// Hand-rolled ASN.1 DER for a self-signed X.509 cert with Ed25519 public key.
// ~150 lines. If this proves fragile, STOP and escalate per dependency note.
//
// Public surface:
export interface TlsCertMaterial {
  readonly certPem: string;
  readonly privateKeyPem: string;
  readonly fingerprint: string; // SHA-256 of the DER, base64
}

export async function makeSelfSignedCert(params: {
  commonName: string;
  validDays: number;
  ed25519PrivateKey: CryptoKey;
}): Promise<TlsCertMaterial> {
  // Implementation outline:
  //   1. Export the Ed25519 private key as PKCS8 (used by Deno.listenTls).
  //   2. Export the matching public key as SPKI.
  //   3. Build the TBSCertificate DER (version=3, serial=random, issuer/subject
  //      CN=params.commonName, validity, subjectPublicKeyInfo = SPKI).
  //   4. Sign TBSCertificate with Ed25519 and append as the signatureValue.
  //   5. Wrap as PEM ("-----BEGIN CERTIFICATE-----").
  //   6. Wrap private key as PKCS8 PEM ("-----BEGIN PRIVATE KEY-----").
  //   7. fingerprint = SHA-256 of the DER certificate, base64.
  throw new Error("not implemented — follow the outline above");
}
```

> The executor implements the outline. Use WebCrypto for sign + SHA-256. ASN.1 templates are
> deterministic; copy a known-good DER skeleton and patch lengths. Do NOT pull a third-party cert
> library without escalating.

### Step 4: TLS TCP listener + dialer

Create `src/infrastructure/transport/tls-tcp.ts`:

```ts
import type { Logger } from "../../ports/logger.ts";
import type { TlsCertMaterial } from "./tls-cert.ts";

export interface TlsTcpOptions {
  readonly listenPort: number; // 0 = pick free port
  readonly cert: TlsCertMaterial;
  readonly knownPeers: ReadonlyMap<string, string>; // fingerprint -> expected cert PEM
  readonly logger: Logger;
}

export class TlsTcpTransport {
  private listener: Deno.TlsListener | null = null;
  private peers = new Map<string, Deno.TlsConn>(); // fingerprint -> conn
  private readonly handlers = new Set<(env: unknown) => void>();

  constructor(private readonly opts: TlsTcpOptions) {}

  async start(): Promise<number> {
    this.listener = Deno.listenTls({
      port: this.opts.listenPort,
      cert: this.opts.cert.certPem,
      key: this.opts.cert.privateKeyPem,
      // Verify client cert; reject unless pinned.
      alpnProtocols: ["clipruler/1"],
    });
    const actualPort = (this.listener.addr as Deno.NetAddr).port;
    this.opts.logger.info("tls listener up", { port: actualPort });
    this.acceptLoop();
    return actualPort;
  }

  private async acceptLoop(): Promise<void> {
    if (!this.listener) return;
    for await (const conn of this.listener) {
      this.handleConn(conn).catch((err) => {
        this.opts.logger.warn("peer connection failed", { err: String(err) });
      });
    }
  }

  private async handleConn(conn: Deno.TlsConn): Promise<void> {
    // Verify the peer cert fingerprint against knownPeers; close if unknown.
    // Read envelopes via readEnvelope and dispatch to handlers.
    // Store the conn in this.peers keyed by fingerprint.
    // On EOF or error, remove the conn.
    conn.close();
  }

  async dial(endpoint: string, expectedFingerprint: string): Promise<void> {
    // Parse host:port, Deno.connectTLS with caCerts=[knownPeers.get(...)],
    // verify server cert fingerprint, store conn in this.peers.
  }

  async send(fingerprint: string, env: unknown): Promise<void> {
    const conn = this.peers.get(fingerprint);
    if (!conn) throw new Error(`peer not connected: ${fingerprint}`);
    await writeEnvelope(conn, env);
  }

  broadcast(env: unknown): Promise<void> {
    return Promise.all([...this.peers.values()].map((c) => writeEnvelope(c, env).catch(() => {})))
      .then(() => {});
  }

  subscribe(handler: (env: unknown) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async close(): Promise<void> {
    this.listener?.close();
    for (const conn of this.peers.values()) {
      try {
        conn.close();
      } catch { /* ignore */ }
    }
    this.peers.clear();
  }
}
```

> `writeEnvelope` is imported from `./framing.ts`; omitted above for brevity.

### Step 5: Reconnect wrapper

Create `src/infrastructure/transport/reconnect.ts`:

```ts
import { delay } from "@std/async";

export interface ReconnectOptions {
  readonly baseMs: number; // e.g. 500
  readonly maxMs: number; // e.g. 30_000
  readonly jitter: number; // 0..1, fraction of jitter to add
}

export async function withReconnect<T>(
  op: () => Promise<T>,
  opts: ReconnectOptions,
  onRetry?: (attempt: number, err: unknown) => void,
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await op();
    } catch (err) {
      attempt++;
      const backoff = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt);
      const jitter = backoff * opts.jitter * Math.random();
      const wait = backoff + jitter;
      onRetry?.(attempt, err);
      await delay(wait);
    }
  }
}
```

### Step 6: Factory

Create `src/infrastructure/transport/mod.ts` exporting `TlsTcpTransport`, `writeEnvelope`,
`readEnvelope`, `makeSelfSignedCert`, `withReconnect`.

### Step 7: Framing unit tests

Create `tests/unit/infrastructure/framing_test.ts`:

- Encode `{ a: 1 }`, decode, assert deep equal.
- Encode a 17 MiB payload, expect `envelope too large` thrown.
- Truncate the body mid-stream, expect `truncated envelope body` thrown.
- Two envelopes concatenated in a buffer, decode sequentially, both correct.

Use an in-memory buffer pair (`new Deno.Buffer()` or `ReadableStream`) — no real sockets.

### Step 8: TLS integration test

Create `tests/integration/transport_tls_test.ts`:

- In the same process, generate two identities, two self-signed certs.
- Start a `TlsTcpTransport` for each on port 0; capture real ports.
- Have each dial the other with the pinned cert.
- Send an envelope from A to B, assert B's subscriber received it.
- Close both, assert no leaked connections (best-effort — check `peers.size` after close).

**Verify**: `deno test --allow-net --allow-read --allow-write tests/integration/` passes both new
tests.

## Test plan

- `tests/unit/infrastructure/framing_test.ts` — 4 tests.
- `tests/integration/transport_tls_test.ts` — 1 in-process two-peer test.

## Done criteria

ALL must hold:

- [ ] `deno task check` exits 0
- [ ] `deno lint` exits 0
- [ ] All tests pass, including new transport tests
- [ ] `TlsTcpTransport.close()` leaves `peers.size === 0`
- [ ] The cert generator rejects if the Ed25519 key is not extractable
- [ ] No third-party cert library imported
- [ ] `plans/README.md` status row for 004 updated

## STOP conditions

Stop and report if:

- Hand-rolled ASN.1 DER for the Ed25519 cert produces invalid output on Deno 2.9.3 (verify with
  `openssl x509 -in cert.pem -text -noout`). Do NOT silently pull `selfsigned` or `@denosaurs/tls`;
  escalate first so the dependency decision is explicit.
- `Deno.listenTls` rejects ALPN negotiation. Drop ALPN and document.
- The integration test flakes more than 1 in 10 runs on port allocation. Use port 0 and read back
  the assigned port; do not hard-code.

## Maintenance notes

- ALPN protocol string `"clipruler/1"` is the v1 marker. Bumping it forces a new transport version.
- Reconnect wrapper is generic; transport-specific reconnect (using peer endpoint hints from the
  device repository) lands in Plan 009.
- The TLS cert is short-lived (30 days) and regenerated automatically. This avoids long-lived cert
  rollover complexity in v0.1.0.
