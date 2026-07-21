/**
 * Unit tests for ports/key-store.ts — interface-shape smoke tests.
 * Verifies the KeyStore interface contract surface is reachable.
 * Layer: unit.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import type { KeyStore, PrivateKeyMaterial } from "../../../src/ports/key-store.ts";

/**
 * Scenario: KeyStore interface has all five required method signatures.
 * Each method is callable with the correct parameter types.
 */
Deno.test("KeyStore interface: all five methods are callable", () => {
  const mock: KeyStore = {
    getOrCreateLocal(): Promise<PrivateKeyMaterial> {
      return Promise.resolve({
        format: "pkcs8-spki",
        algorithm: "Ed25519",
        privateKeyBase64: "",
        publicKeyBase64: "",
      });
    },
    storePeerPublicKey(_fingerprint: string, _publicKeyBase64: string): Promise<void> {
      return Promise.resolve();
    },
    getPeerPublicKey(_fingerprint: string): Promise<string | null> {
      return Promise.resolve(null);
    },
    deletePeerPublicKey(_fingerprint: string): Promise<void> {
      return Promise.resolve();
    },
  };
  assertEquals(typeof mock.getOrCreateLocal, "function");
  assertEquals(typeof mock.storePeerPublicKey, "function");
  assertEquals(typeof mock.getPeerPublicKey, "function");
  assertEquals(typeof mock.deletePeerPublicKey, "function");
});

/**
 * Scenario: PrivateKeyMaterial has the required fields.
 */
Deno.test("PrivateKeyMaterial has required fields", () => {
  const mat: PrivateKeyMaterial = {
    format: "pkcs8-spki",
    algorithm: "Ed25519",
    privateKeyBase64: "YWJj",
    publicKeyBase64: "ZGVm",
  };
  assertEquals(mat.format, "pkcs8-spki");
  assertEquals(mat.algorithm, "Ed25519");
  assertEquals(typeof mat.privateKeyBase64, "string");
  assertEquals(typeof mat.publicKeyBase64, "string");
});

/**
 * Scenario: getPeerPublicKey resolves null when peer is unknown.
 */
Deno.test("getPeerPublicKey resolves null for unknown peer", async () => {
  const mock: KeyStore = {
    getOrCreateLocal() {
      return Promise.resolve({
        format: "pkcs8-spki",
        algorithm: "Ed25519",
        privateKeyBase64: "x",
        publicKeyBase64: "y",
      });
    },
    storePeerPublicKey(_fp: string, _key: string): Promise<void> {
      return Promise.resolve();
    },
    getPeerPublicKey(_fp: string): Promise<string | null> {
      return Promise.resolve(null);
    },
    deletePeerPublicKey(_fp: string): Promise<void> {
      return Promise.resolve();
    },
  };
  const result = await mock.getPeerPublicKey("unknown-fp");
  assertEquals(result, null);
});

/**
 * Scenario: storePeerPublicKey and deletePeerPublicKey are fire-and-forget (void).
 */
Deno.test("storePeerPublicKey and deletePeerPublicKey return void", async () => {
  const mock: KeyStore = {
    getOrCreateLocal() {
      return Promise.resolve({
        format: "pkcs8-spki",
        algorithm: "Ed25519",
        privateKeyBase64: "x",
        publicKeyBase64: "y",
      });
    },
    storePeerPublicKey(_fp: string, _key: string): Promise<void> {
      return Promise.resolve();
    },
    getPeerPublicKey(_fp: string): Promise<string | null> {
      return Promise.resolve(null);
    },
    deletePeerPublicKey(_fp: string): Promise<void> {
      return Promise.resolve();
    },
  };
  const r1 = await mock.storePeerPublicKey("fp", "key");
  const r2 = await mock.deletePeerPublicKey("fp");
  assertEquals(r1, undefined);
  assertEquals(r2, undefined);
});
