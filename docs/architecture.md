# Architecture — Clipruler v0.1.0

clipruler is a peer-to-peer clipboard synchronization tool. Each device runs a daemon (`daemon.ts`)
that discovers peers, establishes mutual TLS connections, and streams clipboard changes through a
versioned wire protocol.

## Module map

clipruler follows a layered architecture with six clearly defined layers. Each layer may only import
from layers strictly below it.

| Layer              | Path                  | Role                                                                                                                              |
| ------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Domain**         | `src/domain/`         | Pure business entities, branded ID types, pairing FSM, conflict resolution                                                        |
| **Protocol**       | `src/protocol/`       | Wire envelope codec, envelope kinds, payload type definitions, protocol constants                                                 |
| **Ports**          | `src/ports/`          | Interface contracts (abstract adapters) — e.g. `ClipboardAdapter`, `Transport`, `DeviceRepository`                                |
| **Application**    | `src/application/`    | Use cases that orchestrate domain and ports — `startLocalSync`, `startRemoteReceiver`, `pairWith`, `listDevices`, `toggleSharing` |
| **Infrastructure** | `src/infrastructure/` | Concrete adapter implementations — clipboard backends, TLS transport, UDP beacon, key store, state store                          |
| **Shells**         | `src/shells/`         | Process entry points and composition root — `daemonMain`, `buildAndRunDaemon`, admin server, CLI, desktop shell                   |

## Dependency rule

Dependencies flow downward only. A layer never imports from a layer above it.

```
shells          → application, infrastructure
application     → domain, ports, protocol
infrastructure  → domain, ports
ports           → domain (interfaces only, no implementation)
domain          → (pure, no external dependencies)
protocol        → domain (for makeMessageId)
```

This rule is enforced structurally, not mechanically. The consequence is that the domain and
protocol layers are testable without any infrastructure present.

---

## Lifecycle of a clipboard event

A clipboard event traverses the full stack from local poll to remote apply. All class and function
names are drawn from `src/application/`.

### Outgoing (local change → wire)

```
ClipboardAdapter.subscribe()
  → startLocalSync() [sync-clipboard.ts:104]
      1. Receive local clipboard notification
      2. Guard: skip empty content (M2 spec)
      3. Guard: skip if RemoteWriteGate.isSuppressed() (echo break, D6)
      4. clock.tick() → Lamport counter increment
      5. devices.list() → filter eligible peers (clipboardSharingEnabled)
      6. makeEnvelope(originDeviceId, "clipboard", { version, counter, content })
      7. transport.send(fingerprint, envelope) per eligible peer
```

### Wire transport

```
encodeEnvelope [envelope.ts:103]  →  TLS TCP connection
                                     (makeTlsTcpTransport, src/infrastructure/transport/tls-tcp.ts)
```

### Incoming (wire → remote apply)

```
TLS receive → transport.subscribe()
  → startRemoteReceiver() [receive-clipboard.ts:64]
      1. Filter to kind === "clipboard" (D1)
      2. Guard: reject originDeviceId === localDeviceId (origin-echo, D3)
      3. Guard: reject if origin not in DeviceRepository (unpaired)
      4. Guard: reject if originDevice.clipboardSharingEnabled === false
      5. clock.observe(counter) → Lamport clock update (M4)
      6. observe(resolver, { version, messageId }) → conflict resolution (M3)
      7. RemoteWriteGate.suppressNext() — arm echo breaker BEFORE write (D6)
      8. clipboard.write({ text, isPassword }) → local clipboard update
```

## Lifecycle of a pairing flow

Pairing establishes mutual trust between two devices using an out-of-band confirmation code derived
from both public keys.

```
UDP beacon (238.42.42.42:42731)  → peer discovers our TLS endpoint
  [src/infrastructure/discovery/udp-beacon.ts]

CLI: admin.pair.request
  → pairWith() [application/pair-device.ts:57]
      1. discovery.visible().get(fp) → verify peer is still advertising (R2.1)
      2. devices.getByFingerprint(fp) → reject if already paired (R2.2)
      3. keys.getOrCreateLocal() → local key material
      4. derivePairingCode(localFingerprint, remoteFingerprint) → 6-digit code
      5. ui.presentPairingCode(code) → user confirms visually (R2.5)
      6. transport.send(fp, pairing-request envelope)
         { deviceName, publicKeyFingerprint } — NO code over the wire (R2.6/R2.7)

Remote daemon receives pairing-request
  → derives same code from the received publicKeyFingerprint
     (derivePairingCode, src/infrastructure/crypto/pairing-code.ts)
  → ui.presentPairingCode(expectedCode) → remote user verifies

CLI: admin.pair.code { code }
  → pairing-confirm { status: "accepted", peerDeviceId }
  → devices.upsert(peer) → device persisted to FileKeyStore
```

Pairing code derivation: SHA-256 over the concatenation of both fingerprints, truncated to 6 decimal
digits. The code is never transmitted over the network.

## Security model

clipruler is designed for a trusted LAN. The threat model assumes:

- The local network is not actively hostile (no MITM)
- Peers are trusted after successful pairing confirmation
- Physical proximity is assumed during pairing (visual code verification)

### Ed25519 identity keys

Each device generates a persistent Ed25519 key pair on first boot. The public key fingerprint
(SHA-256 of the SPKI DER) serves as the stable device identifier (`PublicKeyFingerprint` /
`DeviceId`).

```
src/infrastructure/identity/file-key-store.ts  — key persistence
src/infrastructure/identity/fingerprint.ts     — SHA-256 fingerprint derivation
```

### TLS transport

Peer-to-peer connections use self-signed TLS certificates. The certificate fingerprint is derived
from the P-256 transport key (separate from the Ed25519 identity key). TLS pinning is applied at the
transport layer: `makeTlsTcpTransport` validates the peer certificate against the stored fingerprint
before accepting a connection.

```
src/infrastructure/transport/tls-tcp.ts
src/infrastructure/transport/tls-cert.ts
```

### Pairing code derivation

The 6-digit pairing code is derived locally by both parties:

```
pairingCode = truncate(SHA-256(localFingerprint || remoteFingerprint), 6 digits)
```

The code is used only for visual confirmation. It is never sent over the wire.

```
src/infrastructure/crypto/pairing-code.ts  — derivePairingCode()
```

### Unpaired peer rejection

Every incoming clipboard envelope is validated against `DeviceRepository`. An envelope from a device
that is not in the repository is dropped silently. The pairing flow must complete before a peer can
send or receive clipboard content.

```
receive-clipboard.ts:95-103  — unpaired origin rejection (D3)
```

## Extension points

clipruler is designed to be extended in three primary ways.

### 1. Clipboard adapter

The `ClipboardAdapter` port (`src/ports/clipboard-adapter.ts`) abstracts all clipboard access. To
add a new platform, implement the interface and register it in `buildClipboardAdapter()`
(`src/infrastructure/clipboard/index.ts`).

| Adapter             | Path                                           |
| ------------------- | ---------------------------------------------- |
| `powershell`        | `src/infrastructure/clipboard/powershell.ts`   |
| `wl-clipboard`      | `src/infrastructure/clipboard/wl-clipboard.ts` |
| `xclip` / `xsel`    | `src/infrastructure/clipboard/xclip.ts`        |
| `null` (relay-only) | `src/infrastructure/clipboard/null-adapter.ts` |

### 2. Transport

The `Transport` port (`src/ports/transport.ts`) abstracts how envelopes are sent and received. The
default implementation is TLS-over-TCP (`src/infrastructure/transport/tls-tcp.ts`). A future QUIC or
Bluetooth transport would replace this with a drop-in adapter, provided it satisfies the same
interface.

### 3. Shell

Shells (`src/shells/`) are the process-level entry points. The current shells are:

| Shell     | Entry           | Role                                           |
| --------- | --------------- | ---------------------------------------------- |
| `daemon`  | `daemonMain()`  | Long-running background process, admin socket  |
| `desktop` | `desktopMain()` | TUI/desktop integration shell                  |
| `cli`     | `cliMain()`     | CLI commands for pairing and device management |

A custom shell can embed `buildAndRunDaemon()` directly to embed the daemon with a custom UI,
bypassing the admin socket protocol.
