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
