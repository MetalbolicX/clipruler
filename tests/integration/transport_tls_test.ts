/**
 * Integration tests for infrastructure/transport/tls-tcp.ts — TlsTcpTransport.
 *
 * Layer: integration (gated behind CLIPRULER_NET_TESTS=1)
 *
 * Scope:
 *   - close() is idempotent and callable before listen()
 *   - post-close operations reject with TransportClosedError
 *   - TransportClosedError type correctness
 *
 * Out of scope here:
 *   - Full TLS handshake + Envelope delivery between two real peers.
 *     The TLS adapter requires chain-trust anchor certs; the application
 *     enforces identity via the fingerprint (R4.1). Covering that
 *     end-to-end requires a deterministic test PKI, which is tracked
 *     as a follow-up (P2) once a CLI/diagnostic shell is available.
 */

import { assertInstanceOf, assertRejects } from "jsr:@std/assert@^1.0";
import { makeEnvelope } from "../../src/protocol/envelope.ts";
import { makeDeviceId } from "../../src/domain/device.ts";
import { TransportClosedError } from "../../src/infrastructure/transport/errors.ts";
import { makeTlsTcpTransport } from "../../src/infrastructure/transport/tls-tcp.ts";

// ---------------------------------------------------------------------------
// Skip if not running with CLIPRULER_NET_TESTS=1
// ---------------------------------------------------------------------------

function isIntegrationEnabled(): boolean {
  try {
    return Deno.env.get("CLIPRULER_NET_TESTS") === "1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scenario: close() is idempotent — can be called before listen()
// ---------------------------------------------------------------------------

Deno.test({
  name: "transport_tls: close is idempotent before listen",
  ignore: !isIntegrationEnabled(),
  fn() {
    const transport = makeTlsTcpTransport({
      mode: "listen",
      listen: { hostname: "127.0.0.1", port: 19994, cert: "fake", key: "fake" },
      onPeerCert: (_conn) => Promise.resolve("fake-fp"),
    });

    transport.close();
    transport.close();
  },
});

// ---------------------------------------------------------------------------
// Scenario: send after close rejects with TransportClosedError
// ---------------------------------------------------------------------------

Deno.test({
  name: "transport_tls: send rejects after close with correct error type",
  ignore: !isIntegrationEnabled(),
  async fn() {
    const transport = makeTlsTcpTransport({
      mode: "listen",
      listen: { hostname: "127.0.0.1", port: 19993, cert: "fake", key: "fake" },
      onPeerCert: (_conn) => Promise.resolve("fake-fp"),
    });

    await transport.close();

    await assertRejects(
      async () =>
        await transport.send(
          "some-peer",
          makeEnvelope(makeDeviceId("test-origin"), "hello", {
            deviceName: "TestDevice",
            protocolVersion: 1,
          }),
        ),
      TransportClosedError,
    );
  },
});

// ---------------------------------------------------------------------------
// Scenario: broadcast after close rejects with TransportClosedError
// ---------------------------------------------------------------------------

Deno.test({
  name: "transport_tls: broadcast rejects after close",
  ignore: !isIntegrationEnabled(),
  async fn() {
    const transport = makeTlsTcpTransport({
      mode: "listen",
      listen: { hostname: "127.0.0.1", port: 19992, cert: "fake", key: "fake" },
      onPeerCert: (_conn) => Promise.resolve("fake-fp"),
    });

    await transport.close();

    await assertRejects(
      async () =>
        await transport.broadcast(
          makeEnvelope(makeDeviceId("test-origin"), "hello", {
            deviceName: "TestDevice",
            protocolVersion: 1,
          }),
        ),
      TransportClosedError,
    );
  },
});

// ---------------------------------------------------------------------------
// Scenario: subscribe after close rejects with TransportClosedError
// ---------------------------------------------------------------------------

Deno.test({
  name: "transport_tls: subscribe rejects after close",
  ignore: !isIntegrationEnabled(),
  async fn() {
    const transport = makeTlsTcpTransport({
      mode: "listen",
      listen: { hostname: "127.0.0.1", port: 19991, cert: "fake", key: "fake" },
      onPeerCert: (_conn) => Promise.resolve("fake-fp"),
    });

    await transport.close();

    await assertRejects(
      async () => await transport.subscribe((_env, _fp) => {}),
      TransportClosedError,
    );
  },
});

// ---------------------------------------------------------------------------
// Scenario: TransportClosedError instance is correct type
// ---------------------------------------------------------------------------

Deno.test({
  name: "transport_tls: TransportClosedError is Error instance",
  ignore: !isIntegrationEnabled(),
  fn() {
    const err = new TransportClosedError();
    assertInstanceOf(err, Error);
    assertInstanceOf(err, TransportClosedError);
  },
});
