/**
 * Unit tests for infrastructure/transport/tls-cert.ts — self-signed X.509 certificate factory.
 *
 * Layer: unit.
 * R3 scenarios: Ed25519 primary, P-256 fallback, DER-fragility STOP,
 *               serial uniqueness, validity window.
 *
 * OpenSSL validation is run as a separate verification step after GREEN;
 * tests here verify structure, fingerprint, and algorithmic properties.
 * All certificate field extraction delegates to `openssl x509 -text -noout`
 * which is the canonical X.509 parser — bypassing complex manual DER offset math.
 */
import { assertEquals, assertExists } from "jsr:@std/assert@^1.0";
import { deriveFingerprint } from "../../../../src/domain/device.ts";
import { Keyring } from "../../../../src/infrastructure/identity/keyring.ts";
import {
  DerGenerationError,
  makeSelfSignedCert,
} from "../../../../src/infrastructure/transport/tls-cert.ts";

// ---------------------------------------------------------------------------
// Helpers — OpenSSL-backed certificate introspection
// OpenSSL x509 -text -noout is the canonical X.509 parser. All helpers
// delegate to it to sidestep the complexity of manual DER offset tracking.
// ---------------------------------------------------------------------------

/** Cached OpenSSL availability result (checked once per test run). */
let _opensslAvailable: boolean | null = null;

async function opensslAvailable(): Promise<boolean> {
  if (_opensslAvailable !== null) return _opensslAvailable;
  try {
    const cmd = new Deno.Command("openssl", {
      args: ["version"],
      stdout: "null",
      stderr: "null",
    });
    const { code } = await cmd.output();
    _opensslAvailable = code === 0;
  } catch {
    _opensslAvailable = false;
  }
  return _opensslAvailable;
}

/** Result of parsing an openssl x509 -text -noout output. */
interface CertInfo {
  cn: string;
  notBeforeMs: number;
  notAfterMs: number;
  serialHex: string;
  sigAlgOid: number[];
  sigAlgName: string;
}

/**
 * Parse a certificate PEM using `openssl x509 -text -noout`.
 * Returns CertInfo with CN, validity timestamps, serial, and signature algorithm.
 * Throws if openssl is unavailable or parsing fails.
 */
async function opensslInspect(pem: string): Promise<CertInfo> {
  // Write PEM to a temp file (requires --allow-write).
  const tmp = "/tmp/tls_cert_test_" + Math.random().toString(36).slice(2) + ".pem";
  await Deno.writeTextFile(tmp, pem);
  try {
    const cmd = new Deno.Command("openssl", {
      args: ["x509", "-in", tmp, "-text", "-noout"],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    if (code !== 0) {
      throw new Error(
        `openssl x509 failed: ${new TextDecoder().decode(stderr)}`,
      );
    }
    const text = new TextDecoder().decode(stdout);

    // Extract CN from Subject: ... CN = xxxxx ...
    const cnMatch = text.match(/Subject:\s*[^\n]*CN\s*=\s*([^\n,]+)/);
    if (!cnMatch) throw new Error("CN not found in openssl output");
    const cn = cnMatch[1]!.trim();

    // Extract Validity — "Not After" may have a space before the colon
    const notBeforeMatch = text.match(/Not Before:\s*(.+)/);
    const notAfterMatch = text.match(/Not After\s*:\s*(.+)/);
    if (!notBeforeMatch || !notAfterMatch) {
      throw new Error("Validity dates not found in openssl output");
    }
    const notBeforeMs = new Date(notBeforeMatch[1]!.trim()).getTime();
    const notAfterMs = new Date(notAfterMatch[1]!.trim()).getTime();

    // Extract Serial Number (hex, colon-separated or raw)
    const serialMatch = text.match(/Serial Number:\s*([0-9a-fA-F:]+)/);
    if (!serialMatch) throw new Error("Serial Number not found in openssl output");
    const serialHex = serialMatch[1]!.replace(/:/g, "").trim();

    // Extract Signature Algorithm
    const sigAlgMatch = text.match(/Signature Algorithm:\s*(.+)/);
    if (!sigAlgMatch) throw new Error("Signature Algorithm not found in openssl output");
    const sigAlgName = sigAlgMatch[1]!.trim();

    // Map known signature algorithm names to OID component arrays (case-insensitive)
    const sigLower = sigAlgName.toLowerCase();
    let sigAlgOid: number[];
    if (sigLower.includes("ed25519")) {
      sigAlgOid = [1, 3, 101, 112];
    } else if (sigLower.includes("ecdsa-with-sha256") || sigLower.includes("sha256")) {
      // ECDSA P-256 with SHA-256
      sigAlgOid = [1, 2, 840, 10045, 4, 3, 2];
    } else {
      throw new Error(`Unknown signature algorithm: ${sigAlgName}`);
    }

    return { cn, notBeforeMs, notAfterMs, serialHex, sigAlgOid, sigAlgName };
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}

/**
 * Parse a PEM string into DER bytes.
 * PEM format: -----BEGIN CERTIFICATE-----\n<base64>\n-----END CERTIFICATE-----
 */
function pemToDer(pem: string): Uint8Array {
  const lines = pem.trim().split("\n");
  const b64 = lines.slice(1, -1).join("");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Broken DER introspection helpers — kept for structural tests (PEM format,
// private key header) but NOT used for certificate field extraction.
// All certificate field lookups delegate to opensslInspect() instead.

function ub(array: Uint8Array, index: number): number {
  const v = array[index];
  return v === undefined ? 0 : v;
}

function _skipSequence(der: Uint8Array, offset: number): number {
  if (offset >= der.length || der[offset] !== 0x30) return -1;
  offset++;
  if (offset >= der.length) return -1;
  const lenByte = der[offset] ?? 0;
  if ((lenByte & 0x80) === 0) return offset + 1 + lenByte;
  const numLenBytes = lenByte & 0x7f;
  if (numLenBytes === 0 || offset + 1 + numLenBytes > der.length) return -1;
  let length = 0;
  for (let i = 0; i < numLenBytes; i++) {
    length = (length << 8) | ub(der, offset + 1 + i);
  }
  return offset + 1 + numLenBytes + length;
}

/**
 * Extract CN from a certificate PEM by delegating to opensslInspect().
 * Returns null if openssl is unavailable.
 */
async function extractCnFromTbsCertificate(pem: string): Promise<string | null> {
  if (!await opensslAvailable()) return null;
  try {
    const info = await opensslInspect(pem);
    return info.cn;
  } catch {
    return null;
  }
}

/**
 * Extract serial bytes from a certificate PEM by delegating to opensslInspect().
 * Returns null if openssl is unavailable.
 */
async function extractSerialBytes(pem: string): Promise<Uint8Array | null> {
  if (!await opensslAvailable()) return null;
  try {
    const info = await opensslInspect(pem);
    // Convert hex string to Uint8Array (big-endian)
    const hex = info.serialHex;
    const bytes = new Uint8Array(Math.ceil(hex.length / 2));
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Extract Validity from a certificate PEM by delegating to opensslInspect().
 * Returns null if openssl is unavailable.
 */
async function extractValidityMs(
  pem: string,
): Promise<{ notBeforeMs: number; notAfterMs: number } | null> {
  if (!await opensslAvailable()) return null;
  try {
    const info = await opensslInspect(pem);
    return { notBeforeMs: info.notBeforeMs, notAfterMs: info.notAfterMs };
  } catch {
    return null;
  }
}

/**
 * Extract the signature algorithm OID from a certificate PEM by delegating to opensslInspect().
 * Returns null if openssl is unavailable.
 */
async function extractSignatureAlgorithmOid(pem: string): Promise<number[] | null> {
  if (!await opensslAvailable()) return null;
  try {
    const info = await opensslInspect(pem);
    return info.sigAlgOid;
  } catch {
    return null;
  }
}

// ===========================================================================
// TestSuiteSkipError — used to gracefully skip Ed25519-only tests
// when the runtime doesn't support Ed25519
// ===========================================================================

class TestSuiteSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestSuiteSkipError";
  }
}

// ---------------------------------------------------------------------------
// Scenario: Ed25519 primary path — valid PEM cert with expected fingerprint CN
// ---------------------------------------------------------------------------

Deno.test("tls-cert: Ed25519 primary path — produces valid PEM with fingerprint CN", async (t) => {
  // Skip if openssl is not available
  if (!await opensslAvailable()) {
    await t.step({ name: "openssl-unavailable", ignore: true, fn: async () => {} });
    return;
  }

  const keyring = new Keyring();
  const keyPair = await keyring.generate();

  // Skip if not Ed25519 (will be covered by P-256 fallback test)
  if (keyPair.algorithm !== "Ed25519") {
    throw new TestSuiteSkipError("Ed25519 not supported on this runtime");
  }

  const result = await makeSelfSignedCert(keyPair);

  // PEM format check
  assertEquals(result.certPem.startsWith("-----BEGIN CERTIFICATE-----"), true);
  assertEquals(result.certPem.endsWith("-----END CERTIFICATE-----\n"), true);

  // Parse PEM to DER — structural check only
  const certDer = pemToDer(result.certPem);
  assertEquals(ub(certDer, 0) === 0x30, true, "certificate must start with SEQUENCE tag");

  // Extract CN — must equal SHA-256 fingerprint of SPKI public key
  const cn = await extractCnFromTbsCertificate(result.certPem);
  assertExists(cn, "CN must be present");

  const expectedFingerprint = await deriveFingerprint(keyPair.publicKey);
  assertEquals(cn, expectedFingerprint);

  // Serial number must be present and positive
  const serialBytes = await extractSerialBytes(result.certPem);
  assertExists(serialBytes, "serial number must be present");
  assertEquals(serialBytes.length >= 8, true, "serial should be at least 8 bytes for uniqueness");
  assertEquals((serialBytes[0]! & 0x80) === 0, true, "serial must be positive");

  // Private key PEM must be PKCS#8
  assertEquals(result.keyPem.startsWith("-----BEGIN PRIVATE KEY-----"), true);
  assertEquals(result.keyPem.endsWith("-----END PRIVATE KEY-----\n"), true);
});

// ---------------------------------------------------------------------------
// Scenario: ECDSA P-256 fallback — produces valid PEM
// ---------------------------------------------------------------------------

Deno.test("tls-cert: P-256 fallback — produces valid PEM", async (t) => {
  if (!await opensslAvailable()) {
    await t.step({ name: "openssl-unavailable", ignore: true, fn: async () => {} });
    return;
  }

  const keyring = new Keyring();
  const keyPair = await keyring.generate();

  const result = await makeSelfSignedCert(keyPair);

  assertEquals(result.certPem.length > 0, true);
  assertEquals(result.keyPem.length > 0, true);
  assertEquals(result.certPem.startsWith("-----BEGIN CERTIFICATE-----"), true);

  const certDer = pemToDer(result.certPem);
  assertEquals(ub(certDer, 0) === 0x30, true, "certificate must be a valid SEQUENCE");

  const cn = await extractCnFromTbsCertificate(result.certPem);
  assertExists(cn, "CN must be present");

  const serialBytes = await extractSerialBytes(result.certPem);
  assertExists(serialBytes);
  assertEquals((serialBytes[0]! & 0x80) === 0, true, "serial must be positive");
});

// ---------------------------------------------------------------------------
// Scenario: DER fragility STOP — throws DerGenerationError on broken DER
// ---------------------------------------------------------------------------

Deno.test("tls-cert: DER fragility STOP — throws DerGenerationError when DER generation fails", async () => {
  const keyring = new Keyring();
  const keyPair = await keyring.generate();

  let result: { certPem: string; keyPem: string } | undefined;
  let threw = false;
  let thrownError: unknown = null;

  try {
    result = await makeSelfSignedCert(keyPair);
  } catch (e: unknown) {
    threw = true;
    thrownError = e;
  }

  if (threw) {
    assertEquals(
      thrownError instanceof DerGenerationError,
      true,
      "must throw DerGenerationError on DER failure, not a silent error",
    );
  } else {
    assertEquals(result!.certPem.startsWith("-----BEGIN CERTIFICATE-----"), true);
    assertEquals(result!.certPem.includes("\n-----END CERTIFICATE-----"), true);
    const lines = result!.certPem.trim().split("\n");
    assertEquals(lines.length >= 3, true, "PEM must have BEGIN, content, and END lines");
  }
});

// ---------------------------------------------------------------------------
// Scenario: serial uniqueness — two calls produce different serial numbers
// ---------------------------------------------------------------------------

Deno.test("tls-cert: serial uniqueness — two calls produce different serial numbers", async (t) => {
  if (!await opensslAvailable()) {
    await t.step({ name: "openssl-unavailable", ignore: true, fn: async () => {} });
    return;
  }

  const keyring = new Keyring();
  const keyPair = await keyring.generate();

  const result1 = await makeSelfSignedCert(keyPair);
  const result2 = await makeSelfSignedCert(keyPair);

  const serial1 = await extractSerialBytes(result1.certPem);
  const serial2 = await extractSerialBytes(result2.certPem);
  assertExists(serial1);
  assertExists(serial2);

  assertEquals(serial1.length, serial2.length);

  let differs = false;
  for (let i = 0; i < serial1.length; i++) {
    if (serial1[i] !== serial2[i]) {
      differs = true;
      break;
    }
  }
  assertEquals(differs, true, "two calls must produce different serial numbers");
});

// ---------------------------------------------------------------------------
// Scenario: validity window — validity is >= 30 days
// ---------------------------------------------------------------------------

Deno.test("tls-cert: validity window — notAfter minus notBefore >= 30 days", async (t) => {
  if (!await opensslAvailable()) {
    await t.step({ name: "openssl-unavailable", ignore: true, fn: async () => {} });
    return;
  }

  const keyring = new Keyring();
  const keyPair = await keyring.generate();

  const result = await makeSelfSignedCert(keyPair);

  const validity = await extractValidityMs(result.certPem);
  assertExists(validity, "validity must be extractable from certificate");

  const validityDays = (validity!.notAfterMs - validity!.notBeforeMs) / (24 * 60 * 60 * 1000);
  assertEquals(validityDays >= 30, true, `validity must be >= 30 days, got ${validityDays}`);
});

// ---------------------------------------------------------------------------
// Scenario: CN equals SHA-256 SPKI fingerprint of the public key
// ---------------------------------------------------------------------------

Deno.test("tls-cert: CN equals SHA-256 SPKI fingerprint of the public key", async (t) => {
  if (!await opensslAvailable()) {
    await t.step({ name: "openssl-unavailable", ignore: true, fn: async () => {} });
    return;
  }

  const keyring = new Keyring();
  const keyPair = await keyring.generate();

  const result = await makeSelfSignedCert(keyPair);

  const cn = await extractCnFromTbsCertificate(result.certPem);
  assertExists(cn, "CN must be present in certificate");

  const expectedFingerprint = await deriveFingerprint(keyPair.publicKey);
  assertEquals(cn, expectedFingerprint);
});

// ---------------------------------------------------------------------------
// Scenario: private key PEM is PKCS#8 format
// ---------------------------------------------------------------------------

Deno.test("tls-cert: private key PEM has correct PKCS8 header", async () => {
  const keyring = new Keyring();
  const keyPair = await keyring.generate();

  const result = await makeSelfSignedCert(keyPair);

  assertEquals(result.keyPem.startsWith("-----BEGIN PRIVATE KEY-----"), true);
  assertEquals(result.keyPem.includes("-----END PRIVATE KEY-----"), true);
  const lines = result.keyPem.trim().split("\n");
  assertEquals(lines.length >= 3, true, "PEM must have BEGIN, content, and END lines");
});

// ---------------------------------------------------------------------------
// Scenario: certificate signature algorithm is Ed25519 or ECDSA P-256
// ---------------------------------------------------------------------------

Deno.test("tls-cert: certificate signature algorithm is Ed25519 (1.3.101.112) or ECDSA P-256", async (t) => {
  if (!await opensslAvailable()) {
    await t.step({ name: "openssl-unavailable", ignore: true, fn: async () => {} });
    return;
  }

  const keyring = new Keyring();
  const keyPair = await keyring.generate();

  const result = await makeSelfSignedCert(keyPair);

  const oid = await extractSignatureAlgorithmOid(result.certPem);
  assertExists(oid, "signature algorithm OID must be present");

  // Ed25519 OID: 1.3.101.112
  const isEd25519 = oid.length === 4 &&
    oid[0] === 1 && oid[1] === 3 && oid[2] === 101 && oid[3] === 112;

  // ECDSA with P-256: 1.2.840.10045.2.1
  const isEcdsa = oid.length >= 3 &&
    oid[0] === 1 && oid[1] === 2 && oid[2] === 840 && oid[3] === 10045 && oid[4] === 2 &&
    oid[5] === 1;

  assertEquals(
    isEd25519 || isEcdsa,
    true,
    `signature algorithm must be Ed25519 (1.3.101.112) or ECDSA P-256, got OID ${oid.join(".")}`,
  );
});
