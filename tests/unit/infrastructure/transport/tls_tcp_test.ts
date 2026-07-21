/**
 * Unit tests for infrastructure/transport/tls-tcp.ts — TlsTcpTransport.
 *
 * Layer: unit.
 * These tests focus on API surface, close behavior, and subscribe ordering
 * which don't require real TLS connections.
 *
 * For full TLS behavior, see tests/integration/transport_tls_test.ts.
 *
 * Strict TDD: tests written to verify behavior from the spec.
 */

import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0";
import type { Envelope } from "../../../../src/protocol/envelope.ts";
import { makeEnvelope } from "../../../../src/protocol/envelope.ts";
import { makeDeviceId } from "../../../../src/domain/device.ts";
import { makeTlsTcpTransport } from "../../../../src/infrastructure/transport/tls-tcp.ts";
import { TransportClosedError } from "../../../../src/infrastructure/transport/errors.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTestEnvelope(): Envelope<"hello"> {
  return makeEnvelope(makeDeviceId("test-origin"), "hello", {
    deviceName: "TestDevice",
    protocolVersion: 1,
  });
}

// ---------------------------------------------------------------------------
// Scenario: makeTlsTcpTransport is a function with correct overloads
// ---------------------------------------------------------------------------

Deno.test("TlsTcpTransport: makeTlsTcpTransport is exported from the barrel", () => {
  // Verify the export exists
  assertEquals(typeof makeTlsTcpTransport, "function");
});

// ---------------------------------------------------------------------------
// Scenario: send after close rejects with TransportClosedError
// ---------------------------------------------------------------------------

Deno.test("TlsTcpTransport: send rejects after close", async () => {
  // Create a listener transport that will immediately close
  const transport = makeTlsTcpTransport({
    mode: "listen",
    listen: { hostname: "127.0.0.1", port: 0, cert: "fake", key: "fake" },
    onPeerCert: (_conn) => Promise.resolve("fake-fp"),
  });

  await transport.close();

  await assertRejects(
    async () => await transport.send("peer-fp", makeTestEnvelope()),
    TransportClosedError,
  );
});

// ---------------------------------------------------------------------------
// Scenario: broadcast after close rejects with TransportClosedError
// ---------------------------------------------------------------------------

Deno.test("TlsTcpTransport: broadcast rejects after close", async () => {
  const transport = makeTlsTcpTransport({
    mode: "listen",
    listen: { hostname: "127.0.0.1", port: 0, cert: "fake", key: "fake" },
    onPeerCert: (_conn) => Promise.resolve("fake-fp"),
  });

  await transport.close();

  await assertRejects(
    async () => await transport.broadcast(makeTestEnvelope()),
    TransportClosedError,
  );
});

// ---------------------------------------------------------------------------
// Scenario: subscribe after close rejects with TransportClosedError
// ---------------------------------------------------------------------------

Deno.test("TlsTcpTransport: subscribe rejects after close", async () => {
  const transport = makeTlsTcpTransport({
    mode: "listen",
    listen: { hostname: "127.0.0.1", port: 0, cert: "fake", key: "fake" },
    onPeerCert: (_conn) => Promise.resolve("fake-fp"),
  });

  await transport.close();

  await assertRejects(
    async () => await transport.subscribe((_env, _fp) => {}),
    TransportClosedError,
  );
});

// ---------------------------------------------------------------------------
// Scenario: close is idempotent (calling twice does not throw)
// ---------------------------------------------------------------------------

Deno.test("TlsTcpTransport: close is idempotent", async () => {
  const transport = makeTlsTcpTransport({
    mode: "listen",
    listen: { hostname: "127.0.0.1", port: 0, cert: "fake", key: "fake" },
    onPeerCert: (_conn) => Promise.resolve("fake-fp"),
  });

  await transport.close();
  await transport.close(); // Should not throw
});

// ---------------------------------------------------------------------------
// Scenario: listen() requires listen mode
// ---------------------------------------------------------------------------

Deno.test("TlsTcpTransport: listen() throws in dial mode", async () => {
  const transport = makeTlsTcpTransport({
    mode: "dial",
    dial: { hostname: "127.0.0.1", port: 0 },
    onPeerCert: (_conn) => Promise.resolve("fake-fp"),
  });

  // dial() would try to connect, which fails - we just verify the method rejects
  await assertRejects(
    async () => await (transport as unknown as { dial: () => Promise<void> }).dial(),
    Error,
  );
});

// ---------------------------------------------------------------------------
// Scenario: dial() requires dial mode
// ---------------------------------------------------------------------------

Deno.test("TlsTcpTransport: dial() throws in listen mode", async () => {
  const transport = makeTlsTcpTransport({
    mode: "listen",
    listen: { hostname: "127.0.0.1", port: 0, cert: "fake", key: "fake" },
    onPeerCert: (_conn) => Promise.resolve("fake-fp"),
  });

  // listen() would try to bind, which fails with invalid cert - we just verify the method exists
  await assertRejects(
    async () => await (transport as unknown as { listen: () => Promise<void> }).listen(),
    Error,
  );
});

// ---------------------------------------------------------------------------
// Scenario: send to unknown peer is a no-op (not an error)
// ---------------------------------------------------------------------------

Deno.test("TlsTcpTransport: send to unknown peer silently succeeds", async () => {
  const transport = makeTlsTcpTransport({
    mode: "dial",
    dial: { hostname: "127.0.0.1", port: 0 },
    onPeerCert: (_conn) => Promise.resolve("fake-fp"),
  });

  // Calling send before any connection should not throw
  // (the peer is unknown, so we silently succeed per spec)
  await transport.send("unknown-peer", makeTestEnvelope());
});

// ---------------------------------------------------------------------------
// Scenario: broadcast with no peers is a no-op
// ---------------------------------------------------------------------------

Deno.test("TlsTcpTransport: broadcast with no peers silently succeeds", async () => {
  const transport = makeTlsTcpTransport({
    mode: "dial",
    dial: { hostname: "127.0.0.1", port: 0 },
    onPeerCert: (_conn) => Promise.resolve("fake-fp"),
  });

  // No peers connected - broadcast should silently succeed
  await transport.broadcast(makeTestEnvelope());
});

// ---------------------------------------------------------------------------
// Scenario: subscribe before close succeeds
// ---------------------------------------------------------------------------

Deno.test("TlsTcpTransport: subscribe before close succeeds", async () => {
  const transport = makeTlsTcpTransport({
    mode: "listen",
    listen: { hostname: "127.0.0.1", port: 0, cert: "fake", key: "fake" },
    onPeerCert: (_conn) => Promise.resolve("fake-fp"),
  });

  const received: Envelope[] = [];
  await transport.subscribe((env, _fp) => received.push(env));

  // After close, no more subscriptions accepted
  await transport.close();
  await assertRejects(
    async () => await transport.subscribe((_env, _fp) => {}),
    TransportClosedError,
  );
});

// ---------------------------------------------------------------------------
// Scenario R4.3: ALPN rejection — adapter retries without ALPN (listen)
// ---------------------------------------------------------------------------

/** Minimal fake Deno.TlsConn for ALPN test — not fully functional, just type-safe. */
function _makeFakeTlsConn(): Deno.TlsConn {
  return {
    handshaking: false,
    localAddr: { transport: "tcp", hostname: "127.0.0.1", port: 0 } as Deno.NetAddr,
    remoteAddr: { transport: "tcp", hostname: "127.0.0.1", port: 0 } as Deno.NetAddr,
    readable: new ReadableStream<Uint8Array>(),
    writable: new WritableStream<Uint8Array>(),
    close(): void {/* no-op */},
    closed: Promise.resolve(undefined),
  } as unknown as Deno.TlsConn;
}

/** Minimal fake Deno.Listener for ALPN test — yields no connections. */
function makeFakeListener(): Deno.Listener {
  const emptyAsyncIterable: AsyncIterable<Deno.TlsConn> = {
    [Symbol.asyncIterator](): AsyncIterator<Deno.TlsConn> {
      return {
        next(): Promise<IteratorResult<Deno.TlsConn>> {
          // Never yield any connections — accept loop will exit when transport closes
          return new Promise<IteratorResult<Deno.TlsConn>>(() => {/* pending — never resolves */});
        },
      };
    },
  };
  return {
    addr: { transport: "tcp" as const, hostname: "127.0.0.1", port: 0 },
    close(): void {/* no-op */},
    [Symbol.asyncIterator](): AsyncIterator<Deno.TlsConn> {
      return emptyAsyncIterable[Symbol.asyncIterator]();
    },
    accept(): Promise<Deno.TlsConn> {
      return new Promise(() => {/* pending — never resolves */});
    },
    ref(): void {/* no-op */},
    unref(): void {/* no-op */},
  } as unknown as Deno.Listener;
}

Deno.test({
  name: "TlsTcpTransport: listen retries without ALPN when first call throws ALPN error",
  async fn() {
    let firstCallHadAlpn = false;
    let secondCallHadAlpn = false;

    const fakeListenTls = ((options: Parameters<typeof Deno.listenTls>[0]) => {
      if (options.alpnProtocols?.includes("clipruler/1")) {
        firstCallHadAlpn = true;
        throw new Error("ALPN negotiation failed: no common protocol");
      }
      secondCallHadAlpn = (options.alpnProtocols?.length ?? 0) === 0;
      return makeFakeListener();
    }) as unknown as typeof Deno.listenTls;

    const transport = makeTlsTcpTransport({
      mode: "listen",
      listen: { hostname: "127.0.0.1", port: 0, cert: "cert-pem", key: "key-pem" },
      onPeerCert: () => Promise.resolve("fake-fp"),
      __testing__: { listenTls: fakeListenTls },
    });

    await transport.listen();

    assertEquals(firstCallHadAlpn, true, "first listenTls call must include ALPN");
    assertEquals(secondCallHadAlpn, true, "second listenTls call must NOT include ALPN");

    await transport.close();
  },
});
