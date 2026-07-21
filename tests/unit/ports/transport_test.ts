/**
 * Unit tests for ports/transport.ts — Transport port contract.
 *
 * Layer: unit.
 * R1 scenarios: send delivers to one peer, broadcast to all,
 * operations after close reject, ordered handlers.
 *
 * Strict TDD: tests written BEFORE implementation.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0";
import type { Envelope } from "../../../src/protocol/envelope.ts";
import { makeEnvelope } from "../../../src/protocol/envelope.ts";
import { makeDeviceId } from "../../../src/domain/device.ts";

// ---------------------------------------------------------------------------
// Helper: minimal Envelope for testing
// ---------------------------------------------------------------------------

function makeTestEnvelope(): Envelope<"hello"> {
  return makeEnvelope(makeDeviceId("test-origin"), "hello", {
    deviceName: "TestDevice",
    protocolVersion: 1,
  });
}

// ---------------------------------------------------------------------------
// In-memory loopback Transport test double — implements Transport port
// so we can test the interface contract without real TLS/TCP.
// ---------------------------------------------------------------------------

import type { Transport } from "../../../src/ports/transport.ts";

class LoopbackTransport implements Transport {
  readonly #handlers: Array<(envelope: Envelope, peerFingerprint: string) => void> = [];
  #closed = false;

  send(peerFingerprint: string, envelope: Envelope): Promise<void> {
    if (this.#closed) throw new Error("transport closed");
    // In loopback: deliver to self
    for (const h of this.#handlers) {
      h(envelope, peerFingerprint);
    }
    return Promise.resolve();
  }

  broadcast(envelope: Envelope): Promise<void> {
    if (this.#closed) throw new Error("transport closed");
    // In loopback: broadcast to self; catch handler errors to continue
    for (const h of this.#handlers) {
      try {
        h(envelope, "broadcast");
      } catch {
        // Mid-broadcast handler error does not abort delivery to remaining peers
      }
    }
    return Promise.resolve();
  }

  subscribe(
    handler: (envelope: Envelope, peerFingerprint: string) => void,
  ): Promise<void> {
    if (this.#closed) throw new Error("transport closed");
    this.#handlers.push(handler);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#handlers.length = 0;
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Scenario: send delivers to one peer
// ---------------------------------------------------------------------------

Deno.test("Transport: send delivers envelope to registered handler", async () => {
  const transport = new LoopbackTransport();
  const received: Array<{ env: Envelope; fp: string }> = [];

  await transport.subscribe((env, fp) => {
    received.push({ env, fp });
  });

  const env = makeTestEnvelope();
  await transport.send("peer-fp-1", env);

  assertEquals(received.length, 1);
  const r0 = received[0]!;
  assertEquals(r0.fp, "peer-fp-1");
  assertEquals(r0.env.kind, "hello");
});

// ---------------------------------------------------------------------------
// Scenario: broadcast delivers to all peers
// ---------------------------------------------------------------------------

Deno.test("Transport: broadcast delivers to all registered handlers", async () => {
  const transport = new LoopbackTransport();
  const received1: Envelope[] = [];
  const received2: Envelope[] = [];

  await transport.subscribe((env, _fp) => received1.push(env));
  await transport.subscribe((env, _fp) => received2.push(env));

  const env = makeTestEnvelope();
  await transport.broadcast(env);

  assertEquals(received1.length, 1);
  assertEquals(received2.length, 1);
  assertEquals(received1[0]!.kind, "hello");
  assertEquals(received2[0]!.kind, "hello");
});

// ---------------------------------------------------------------------------
// Scenario: broadcast mid-disconnect does not abort remaining peers
// ---------------------------------------------------------------------------

Deno.test("Transport: broadcast continues even if one handler throws", async () => {
  const transport = new LoopbackTransport();
  const received: Envelope[] = [];

  // First handler throws — should not abort delivery to second
  await transport.subscribe((_env, _fp) => {
    throw new Error("handler error");
  });
  await transport.subscribe((env, _fp) => {
    received.push(env);
  });

  const env = makeTestEnvelope();
  await transport.broadcast(env);

  assertEquals(received.length, 1);
});

// ---------------------------------------------------------------------------
// Scenario: ordered handlers are invoked in registration order
// ---------------------------------------------------------------------------

Deno.test("Transport: handlers are invoked in registration order", async () => {
  const transport = new LoopbackTransport();
  const order: number[] = [];

  await transport.subscribe((_env, _fp) => order.push(1));
  await transport.subscribe((_env, _fp) => order.push(2));
  await transport.subscribe((_env, _fp) => order.push(3));

  await transport.broadcast(makeTestEnvelope());

  assertEquals(order, [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// Scenario: send after close rejects with transport-closed error
// ---------------------------------------------------------------------------

Deno.test("Transport: send rejects after close", async () => {
  const transport = new LoopbackTransport();
  await transport.close();

  await assertRejects(
    async () => await transport.send("peer", makeTestEnvelope()),
    Error,
    "transport closed",
  );
});

// ---------------------------------------------------------------------------
// Scenario: broadcast after close rejects with transport-closed error
// ---------------------------------------------------------------------------

Deno.test("Transport: broadcast rejects after close", async () => {
  const transport = new LoopbackTransport();
  await transport.close();

  await assertRejects(
    async () => await transport.broadcast(makeTestEnvelope()),
    Error,
    "transport closed",
  );
});

// ---------------------------------------------------------------------------
// Scenario: subscribe after close rejects with transport-closed error
// ---------------------------------------------------------------------------

Deno.test("Transport: subscribe rejects after close", async () => {
  const transport = new LoopbackTransport();
  await transport.close();

  await assertRejects(
    async () => await transport.subscribe((_env, _fp) => {}),
    Error,
    "transport closed",
  );
});

// ---------------------------------------------------------------------------
// Scenario: close is idempotent (calling twice does not throw)
// ---------------------------------------------------------------------------

Deno.test("Transport: close is idempotent", async () => {
  const transport = new LoopbackTransport();
  await transport.close();
  await transport.close(); // should not throw
});
