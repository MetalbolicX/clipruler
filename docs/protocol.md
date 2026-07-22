# Wire Protocol — Clipruler v0.1.0

clipruler uses a self-contained, versioned wire protocol for all peer-to-peer communication. The
protocol is stateless at the envelope level: each message is self-describing and can be processed
independently.

## Envelope format

Every wire message is an **envelope** — a versioned container that carries a typed payload.

```typescript
// src/protocol/envelope.ts:61-67
type Envelope<K extends EnvelopeKind = EnvelopeKind> = {
  readonly version: number; // always 1
  readonly messageId: ReturnType<typeof makeMessageId>; // crypto.randomUUID()
  readonly originDeviceId: string; // sender's DeviceId
  readonly kind: K; // discriminated union key
  readonly payload: PayloadByKind<K>; // type-safe payload
};
```

## Length-prefix layout

All envelopes are framed with a 4-byte big-endian unsigned integer prefix indicating the byte length
of the UTF-8 JSON body. The maximum envelope size is 16 MiB (`16 * 1024 * 1024`).

```
+--------+-------------------+
| 4 bytes      | variable       |
| BE uint32    | UTF-8 JSON     |
| body length  | envelope body  |
+--------+-------------------+
```

Encoding and decoding use only `TextEncoder` / `TextDecoder` — no Deno-only APIs are used in
`src/protocol/envelope.ts`, making the codec portable.

```
encodeEnvelope  → src/protocol/envelope.ts:103
decodeEnvelope → src/protocol/envelope.ts:129
```

## Envelope kinds

The protocol defines 12 envelope kinds. Each kind has a fixed payload shape, a defined sender, and a
defined receiver.

| Kind                 | Payload shape                                                 | Sender          | Receiver     | Notes                                                                  |
| -------------------- | ------------------------------------------------------------- | --------------- | ------------ | ---------------------------------------------------------------------- |
| `hello`              | `{ deviceName: string; protocolVersion: number }`             | any peer        | any peer     | Initial handshake; `protocolVersion` must equal `PROTOCOL_VERSION` (1) |
| `pairing-request`    | `{ deviceName: string; publicKeyFingerprint: string }`        | initiator       | responder    | Kicks off pairing; no code transmitted (R2.6)                          |
| `pairing-confirm`    | `{ status: "accepted" \| "rejected"; peerDeviceId?: string }` | responder       | initiator    | Status only; no code transmitted                                       |
| `clipboard`          | `{ version: 1; counter: number; content: string }`            | any paired peer | paired peers | Counter is Lamport clock value (M4)                                    |
| `admin.list`         | `{ _kind: "admin.list" }`                                     | CLI             | daemon       | Requests paired-device list                                            |
| `admin.status`       | `{ _kind: "admin.status" }`                                   | CLI             | daemon       | Requests daemon status                                                 |
| `admin.pair.request` | `{ deviceName: string }`                                      | CLI             | daemon       | Initiates pairing for named peer                                       |
| `admin.pair.code`    | `{ code: string }`                                            | CLI             | daemon       | Delivers confirmation code to daemon                                   |
| `admin.enable`       | `{ fingerprint: string }`                                     | CLI             | daemon       | Enables clipboard sharing for peer                                     |
| `admin.disable`      | `{ fingerprint: string }`                                     | CLI             | daemon       | Disables clipboard sharing for peer                                    |
| `admin.forget`       | `{ fingerprint: string }`                                     | CLI             | daemon       | Removes peer from trusted device list                                  |
| `admin.response`     | `{ status: "ok" \| "error"; message?: string }`               | daemon          | CLI          | Generic response for all admin requests                                |

Payload correlation map (discriminated union narrowing):

```typescript
// src/protocol/envelope.ts:42-55
type PayloadByKind<K extends EnvelopeKind> = K extends "hello"
  ? { deviceName: string; protocolVersion: number }
  : K extends "pairing-request" ? { deviceName: string; publicKeyFingerprint: string }
  : K extends "pairing-confirm" ? { status: "accepted" | "rejected"; peerDeviceId?: string }
  : K extends "clipboard" ? { version: number; counter: number; content: string }
  : K extends "admin.list" ? { _kind: "admin.list" }
  : K extends "admin.status" ? { _kind: "admin.status" }
  : K extends "admin.pair.request" ? { deviceName: string }
  : K extends "admin.pair.code" ? { code: string }
  : K extends "admin.enable" ? { fingerprint: string }
  : K extends "admin.disable" ? { fingerprint: string }
  : K extends "admin.forget" ? { fingerprint: string }
  : K extends "admin.response" ? { status: "ok" | "error"; message?: string }
  : never;
```

## Versioning

```
// src/protocol/envelope.ts:18
export const PROTOCOL_VERSION = 1;
```

The protocol is versioned at the envelope level via the `version` field. `decodeEnvelope`
(`envelope.ts:151-155`) rejects envelopes whose version does not equal `PROTOCOL_VERSION`:

```typescript
if (parsed.version !== PROTOCOL_VERSION) {
  throw new Error(`Unsupported protocol version: ${parsed.version}`);
}
```

**Bump policy**: the protocol version is bumped only when a breaking change is introduced to the
envelope format or envelope kinds. Adding new kinds is a non-breaking extension and does not require
a version bump. A peer that receives an unknown `kind` silently drops the envelope (future
extensibility).

## Admin channel

The admin channel is the control plane for the daemon. It is a separate transport from the
peer-to-peer TLS channel and uses the same envelope framing.

### Transport

| Platform | Transport          | Address                                                              |
| -------- | ------------------ | -------------------------------------------------------------------- |
| POSIX    | Unix domain socket | `$DATA_DIR/admin.sock` (mode 0600)                                   |
| Windows  | TCP loopback       | `127.0.0.1:<ephemeral>` (port written to `$DATA_DIR/admin.endpoint`) |

The daemon writes the admin endpoint address to `adminEndpointFile` so the CLI can discover it
without configuration.

### Peer discovery transport

Peer availability is announced via UDP multicast on `238.42.42.42:42731` (administratively scoped,
RFC 2365). This is a separate transport from the TLS envelope channel and carries a minimal unsigned
payload (protocol version, public key fingerprint, TLS port). See `docs/discovery.md` for the full
beacon lifecycle and security notes.

```
src/shells/admin/admin-server.ts  — startUnixAdminServer(), startTcpAdminServer()
src/shells/composition-root.ts:209-211  — admin socket path resolution
```

### Wire format

The admin channel uses the same length-prefixed JSON envelope format as the TLS transport. Each
request is a single envelope; the response is a single `admin.response` envelope.

### Protocol

```
CLI                          Daemon
  │                             │
  │── admin.list ──────────────→│  listDevices() → DeviceListView
  │←─ admin.response ───────────│  { status: "ok", message: JSON }
  │                             │
  │── admin.pair.request ──────→│  pairWith() initiated (R2.1-R2.8)
  │←─ admin.response ───────────│  { status: "ok" } (initiation only)
  │                             │
  │── admin.pair.code ─────────→│  pairing-confirm sent to remote
  │←─ admin.response ───────────│  { status: "ok" }
  │                             │
  │── admin.enable ────────────→│  toggleSharing(enabled: true)
  │←─ admin.response ───────────│  { status: "ok" }
  │                             │
  │── admin.disable ───────────→│  toggleSharing(enabled: false)
  │←─ admin.response ───────────│  { status: "ok" }
  │                             │
  │── admin.forget ────────────→│  ForgetDevice.execute()
  │←─ admin.response ───────────│  { status: "ok" }
  │                             │
  │── admin.status ────────────→│  { pid, adminSocketPath, tlsPort, deviceName }
  │←─ admin.response ───────────│  { status: "ok", message: JSON }
```

The admin channel is intended for local processes on the same host only. The Unix socket is
protected with mode 0600 (owner read/write only). The TCP loopback on Windows binds to `127.0.0.1`
with an OS-assigned ephemeral port.
