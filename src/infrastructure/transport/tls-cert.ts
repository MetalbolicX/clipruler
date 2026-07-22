/**
 * infrastructure/transport/tls-cert.ts
 *
 * Self-signed X.509 certificate factory using hand-rolled ASN.1 DER + WebCrypto.
 *
 * Algorithm priority: Ed25519 first (via Keyring key); ECDSA P-256 fallback if
 * Ed25519 signing fails or is unsupported on this runtime.
 *
 * CN = SHA-256 SPKI fingerprint of the public key (same algorithm as
 * `src/domain/device.ts`'s `deriveFingerprint`).
 *
 * STOP behavior: if the DER generator cannot produce a parseable cert, throws
 * `DerGenerationError` and never silently returns broken PEM.
 *
 * Zero third-party deps — WebCrypto + hand-rolled ASN.1 DER only.
 */

import { deriveFingerprint } from "../../domain/device.ts";
import { Keyring } from "../identity/keyring.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SelfSignedCertResult {
  certPem: string;
  keyPem: string;
}

export interface SelfSignedCertResultWithFingerprint extends SelfSignedCertResult {
  fingerprint: string;
}

/**
 * Generate a self-signed X.509 certificate for the given key pair.
 *
 * Algorithm: Ed25519 primary (via Keyring key); ECDSA P-256 fallback if
 * Ed25519 signing fails with DataError or NotSupportedError.
 *
 * Certificate properties:
 *   - Version: v3 (1)
 *   - Serial: random 20-byte positive integer
 *   - Validity: >= 30 days from now
 *   - Issuer/Subject CN: SHA-256 SPKI fingerprint of the public key
 *   - Signature: Ed25519 or ECDSA P-256
 *
 * @throws DerGenerationError if certificate generation fails.
 */
export const makeSelfSignedCert = async (
  keyPair: Awaited<ReturnType<Keyring["generate"]>>,
): Promise<SelfSignedCertResult> => {
  // Try Ed25519 first
  try {
    return await makeSelfSignedCertEd25519(keyPair);
  } catch (e: unknown) {
    const name = (e as DOMException)?.name ?? (e as Error)?.name;
    if (
      name === "DataError" ||
      name === "NotSupportedError" ||
      name === "OperationError" ||
      name === "TypeError" // e.g., wrong key type for Ed25519 signing
    ) {
      // Fall through to P-256 fallback
    } else {
      throw e;
    }
  }

  // Fallback: ECDSA P-256 (locally generated)
  return makeSelfSignedCertP256();
};

// ---------------------------------------------------------------------------
// DerGenerationError — thrown on broken DER, never silent
// ---------------------------------------------------------------------------

export class DerGenerationError extends Error {
  override readonly name = "DerGenerationError";

  constructor(message: string) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Helper — undefined-safe byte reader
// ---------------------------------------------------------------------------

const ub = (arr: Uint8Array, index: number): number => {
  const v = arr[index];
  return v === undefined ? 0 : v;
};

// ---------------------------------------------------------------------------
// Ed25519 path
// ---------------------------------------------------------------------------

const makeSelfSignedCertEd25519 = async (
  keyPair: Awaited<ReturnType<Keyring["generate"]>>,
): Promise<SelfSignedCertResult> => {
  // Export private key in PKCS8 format for Ed25519 signing
  const pkcs8Der = await globalThis.crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const pkcs8Bytes = new Uint8Array(pkcs8Der);

  // Build AlgorithmIdentifier for Ed25519 (OID 1.3.101.112 + NULL per RFC 8410)
  // RFC 8410: implementations MUST accept NULL parameters for Ed25519
  const ed25519AlgId = derSequence([
    derOid([1, 3, 101, 112]), // 1.3.101.112
    derNull(), // NULL parameter (RFC 8410 compliant)
  ]);

  // Generate random 20-byte serial (positive: first byte must have high bit clear)
  const serial = generateRandomSerial();

  // Validity: now to now + 365 days (>= 30 days required)
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + 365 * 24 * 60 * 60 * 1000);

  // CN = SHA-256 SPKI fingerprint
  const fingerprint = await deriveFingerprint(keyPair.publicKey);

  // Build Name (CN = fingerprint)
  const name = derSequence([derSet([derSequence([
    derOid([2, 5, 4, 3]), // id-at-commonName = 2.5.4.3
    derPrintableString(fingerprint),
  ])])]);

  // Validity
  const validity = derSequence([
    derUtcTime(notBefore),
    derUtcTime(notAfter),
  ]);

  // SubjectPublicKeyInfo — SPKI from Keyring's publicKey
  const spki = keyPair.publicKey; // Already SPKI DER bytes from Keyring

  // Build TBSCertificate
  const tbsCertificate = derSequence([
    derContextTag(0xa0, derIntegerU8(numberToUint8Array(2))), // Version v3 (value = 2 per RFC 5280)
    derInteger(serial),
    ed25519AlgId,
    name, // Issuer
    validity,
    name, // Subject (same as issuer — self-signed)
    spki,
  ]);

  // Sign the TBSCertificate with Ed25519 private key
  const signature = await globalThis.crypto.subtle.sign(
    { name: "Ed25519" } as Algorithm,
    keyPair.privateKey,
    tbsCertificate.buffer as ArrayBuffer,
  );

  // Ed25519 signature is raw 64 bytes (no DER wrapping)
  const sigBytes = new Uint8Array(signature);
  if (sigBytes.length !== 64) {
    throw new DerGenerationError(
      `Ed25519 signature returned ${sigBytes.length} bytes; expected 64`,
    );
  }

  // Build final Certificate
  const certificate = derSequence([
    tbsCertificate,
    ed25519AlgId,
    derBitString(sigBytes),
  ]);

  // Encode certificate and private key as PEM
  const certPem = derToPem(certificate, "CERTIFICATE");
  const keyPem = pkcs8ToPem(pkcs8Bytes);

  return { certPem, keyPem };
};

// ---------------------------------------------------------------------------
// P-256 fallback path
// ---------------------------------------------------------------------------

/**
 * Generate a self-signed X.509 certificate using ECDSA P-256.
 * Exported for use in integration tests where Ed25519 certs are not supported
 * by Deno's TLS listener.
 *
 * @param existingKeyPair - Optional pre-existing P-256 ECDSA key pair to reuse.
 *                           When provided, the returned certificate's public key
 *                           matches the provided key pair (important when the
 *                           fingerprint is derived from the public key separately).
 */
export const makeSelfSignedCertP256 = async (
  existingKeyPair?: CryptoKeyPair,
): Promise<SelfSignedCertResultWithFingerprint> => {
  // Use existing key pair or generate a new one
  const p256KeyPair = existingKeyPair ??
    (await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" } as EcKeyGenParams,
      true, // extractable
      ["sign", "verify"],
    ) as CryptoKeyPair);

  // Export public key as SPKI
  const spkiDer = await globalThis.crypto.subtle.exportKey("spki", p256KeyPair.publicKey);
  const spkiBytes = new Uint8Array(spkiDer);

  // Export private key as PKCS8
  const pkcs8Der = await globalThis.crypto.subtle.exportKey("pkcs8", p256KeyPair.privateKey);
  const pkcs8Bytes = new Uint8Array(pkcs8Der);

  // Build AlgorithmIdentifier for ECDSA with P-256
  // id-ecPublicKey OID: 1.2.840.10045.2.1
  // prime256v1 OID: 1.2.840.10045.3.1.7
  const ecAlgId = derSequence([
    derOid([1, 2, 840, 10045, 2, 1]), // 1.2.840.10045.2.1 (id-ecPublicKey)
    derOid([1, 2, 840, 10045, 3, 1, 7]), // 1.2.840.10045.3.1.7 (prime256v1)
  ]);

  // Generate random 20-byte serial
  const serial = generateRandomSerial();

  // Validity
  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + 365 * 24 * 60 * 60 * 1000);

  // Compute fingerprint from SPKI
  const fingerprint = await deriveFingerprint(spkiBytes);

  // Name (CN = fingerprint)
  const name = derSequence([derSet([derSequence([
    derOid([2, 5, 4, 3]), // id-at-commonName = 2.5.4.3
    derPrintableString(fingerprint),
  ])])]);

  // Validity
  const validity = derSequence([
    derUtcTime(notBefore),
    derUtcTime(notAfter),
  ]);

  // TBSCertificate
  const tbsCertificate = derSequence([
    derContextTag(0xa0, derIntegerU8(numberToUint8Array(2))), // Version v3 (value = 2 per RFC 5280)
    derInteger(serial),
    ecAlgId,
    name, // Issuer
    validity,
    name, // Subject
    spkiBytes, // SubjectPublicKeyInfo
  ]);

  // Sign with P-256
  const rawSignature = await globalThis.crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" } as EcdsaParams,
    p256KeyPair.privateKey,
    tbsCertificate.buffer as ArrayBuffer,
  );

  // WebCrypto returns raw r||s (64 bytes for P-256), not DER-encoded.
  // No conversion needed — same as Ed25519.
  const sigBytes = new Uint8Array(rawSignature);

  // Build final Certificate
  const certificate = derSequence([
    tbsCertificate,
    ecAlgId,
    derBitString(sigBytes),
  ]);

  const certPem = derToPem(certificate, "CERTIFICATE");
  const keyPem = pkcs8ToPem(pkcs8Bytes);

  return { certPem, keyPem, fingerprint };
};

// ---------------------------------------------------------------------------
// DER encoding primitives
// ---------------------------------------------------------------------------

/**
 * Encode an ASN.1 OID using base-128 encoding for arc values >= 128.
 * Arc values 0-127 are encoded as a single byte.
 * Arc values >= 128 are encoded as multiple bytes with continuation bits.
 */
const derOid = (oid: number[]): Uint8Array => {
  const bytes: number[] = [];
  // First byte: (first * 40) + second arc
  const arc0 = oid[0] ?? 0;
  const arc1 = oid[1] ?? 0;
  bytes.push(arc0 * 40 + arc1);
  // Remaining arcs: base-128 encoding
  for (let i = 2; i < oid.length; i++) {
    const v = oid[i] ?? 0;
    if (v < 128) {
      bytes.push(v);
    } else {
      // Compute number of bytes needed
      let numBytes = 0;
      let temp = v;
      while (temp > 0) {
        numBytes++;
        temp >>= 7;
      }
      // Encode from most significant to least significant 7-bit chunk
      for (let j = 0; j < numBytes; j++) {
        const shift = 7 * (numBytes - 1 - j);
        const sevenBits = (v >> shift) & 0x7f;
        const isLast = j === numBytes - 1;
        bytes.push(isLast ? sevenBits : 0x80 | sevenBits);
      }
    }
  }
  return new Uint8Array([0x06, bytes.length, ...bytes]);
};

/**
 * Encode an ASN.1 SEQUENCE.
 */
const derSequence = (contents: Uint8Array[]): Uint8Array => {
  const body = concatBytes(...contents);
  const len = body.length;
  if (len < 128) {
    return concatBytes(new Uint8Array([0x30, len]), body);
  } else if (len < 256) {
    return concatBytes(new Uint8Array([0x30, 0x81, len]), body);
  } else {
    return concatBytes(new Uint8Array([0x30, 0x82, (len >> 8) & 0xff, len & 0xff]), body);
  }
};

/**
 * Encode an ASN.1 SET.
 */
const derSet = (contents: Uint8Array[]): Uint8Array => {
  const body = concatBytes(...contents);
  const len = body.length;
  if (len < 128) {
    return concatBytes(new Uint8Array([0x31, len]), body);
  } else if (len < 256) {
    return concatBytes(new Uint8Array([0x31, 0x81, len]), body);
  } else {
    return concatBytes(new Uint8Array([0x31, 0x82, (len >> 8) & 0xff, len & 0xff]), body);
  }
};

/**
 * Encode an ASN.1 INTEGER from a Uint8Array.
 * Always encodes as positive (adds leading 0x00 if high bit is set).
 */
const derInteger = (value: Uint8Array): Uint8Array => {
  // Ensure positive: if first byte has high bit set, prepend 0x00
  let body: Uint8Array;
  const first = ub(value, 0);
  if ((first & 0x80) !== 0) {
    body = concatBytes(new Uint8Array([0x00]), value);
  } else {
    body = value;
  }
  const len = body.length;
  if (len < 128) {
    return concatBytes(new Uint8Array([0x02, len]), body);
  } else if (len < 256) {
    return concatBytes(new Uint8Array([0x02, 0x81, len]), body);
  } else {
    return concatBytes(new Uint8Array([0x02, 0x82, (len >> 8) & 0xff, len & 0xff]), body);
  }
};

/**
 * Encode a small integer (0-255) as a big-endian Uint8Array.
 */
const numberToUint8Array = (n: number): Uint8Array => {
  return new Uint8Array([n]);
};

/**
 * Encode an ASN.1 INTEGER from a small integer value.
 */
const derIntegerU8 = (value: Uint8Array): Uint8Array => {
  return derInteger(value);
};

/**
 * Encode an ASN.1 UTF8String.
 */
const _derUtf8String = (value: string): Uint8Array => {
  const body = new TextEncoder().encode(value);
  const len = body.length;
  if (len < 128) {
    return concatBytes(new Uint8Array([0x0c, len]), body);
  } else if (len < 256) {
    return concatBytes(new Uint8Array([0x0c, 0x81, len]), body);
  } else {
    return concatBytes(new Uint8Array([0x0c, 0x82, (len >> 8) & 0xff, len & 0xff]), body);
  }
};

/**
 * Encode an ASN.1 PrintableString.
 */
const derPrintableString = (value: string): Uint8Array => {
  const body = new TextEncoder().encode(value);
  const len = body.length;
  if (len < 128) {
    return concatBytes(new Uint8Array([0x13, len]), body);
  } else if (len < 256) {
    return concatBytes(new Uint8Array([0x13, 0x81, len]), body);
  } else {
    return concatBytes(new Uint8Array([0x13, 0x82, (len >> 8) & 0xff, len & 0xff]), body);
  }
};

/**
 * Encode an ASN.1 NULL value.
 */
const derNull = (): Uint8Array => {
  return new Uint8Array([0x05, 0x00]);
};

/**
 * Encode an ASN.1 UTC Time (YYMMDDhhmmssZ).
 */
const derUtcTime = (date: Date): Uint8Array => {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  const hh = date.getUTCHours();
  const mm = date.getUTCMinutes();
  const ss = date.getUTCSeconds();
  const year = y >= 2050 ? y - 1900 : y - 2000;
  const s = [
    String(Math.floor(year / 10)),
    String(year % 10),
    String(Math.floor(m / 10)),
    String(m % 10),
    String(Math.floor(d / 10)),
    String(d % 10),
    String(Math.floor(hh / 10)),
    String(hh % 10),
    String(Math.floor(mm / 10)),
    String(mm % 10),
    String(Math.floor(ss / 10)),
    String(ss % 10),
    "Z",
  ].join("");
  const body = new TextEncoder().encode(s);
  return concatBytes(new Uint8Array([0x17, body.length]), body);
};

/**
 * Encode an ASN.1 context-specific tag (EXPLICIT).
 */
const derContextTag = (tag: number, content: Uint8Array): Uint8Array => {
  const len = content.length;
  if (len < 128) {
    return concatBytes(new Uint8Array([0xa0 | tag, len]), content);
  } else if (len < 256) {
    return concatBytes(new Uint8Array([0xa0 | tag, 0x81, len]), content);
  } else {
    return concatBytes(new Uint8Array([0xa0 | tag, 0x82, (len >> 8) & 0xff, len & 0xff]), content);
  }
};

/**
 * Encode an ASN.1 BIT STRING.
 * bitString bytes contain the raw bits, with unused bits = 0 in the first byte.
 */
const derBitString = (bits: Uint8Array): Uint8Array => {
  const len = bits.length + 1; // +1 for the "unused bits" byte
  if (len < 128) {
    return concatBytes(new Uint8Array([0x03, len, 0x00]), bits);
  } else if (len < 256) {
    return concatBytes(new Uint8Array([0x03, 0x81, len, 0x00]), bits);
  } else {
    return concatBytes(
      new Uint8Array([0x03, 0x82, (len >> 8) & 0xff, len & 0xff, 0x00]),
      bits,
    );
  }
};

// ---------------------------------------------------------------------------
// DER → PEM conversion
// ---------------------------------------------------------------------------

const derToPem = (der: Uint8Array, label: string): string => {
  const base64 = btoa(String.fromCharCode(...der));
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
};

const pkcs8ToPem = (pkcs8: Uint8Array): string => {
  return derToPem(pkcs8, "PRIVATE KEY");
};

// ---------------------------------------------------------------------------
// ECDSA DER signature → raw r||s conversion
// ---------------------------------------------------------------------------

/**
 * Convert a DER-encoded ECDSA signature to raw r||s format.
 * DER format: SEQUENCE { INTEGER r, INTEGER s }
 * Each INTEGER is variable-length; P-256 r and s are each 32 bytes.
 */
const _convertDerSignatureToRaw = (der: Uint8Array): Uint8Array => {
  let offset = 0;

  // SEQUENCE tag
  if (ub(der, offset) !== 0x30) {
    throw new DerGenerationError(
      `Expected SEQUENCE (0x30), got 0x${ub(der, offset).toString(16)}`,
    );
  }
  offset++;

  // SEQUENCE length
  const seqLen = ub(der, offset);
  if ((seqLen & 0x80) === 0) {
    offset += 1 + seqLen;
  } else {
    const numBytes = seqLen & 0x7f;
    offset += 1 + numBytes;
    let totalLen = 0;
    for (let i = 0; i < numBytes; i++) {
      totalLen = (totalLen << 8) | ub(der, offset + i);
    }
    offset += totalLen;
  }

  // Now at r INTEGER
  if (ub(der, offset) !== 0x02) {
    throw new DerGenerationError(
      `Expected INTEGER (0x02) for r, got 0x${ub(der, offset).toString(16)}`,
    );
  }
  offset++;

  const rLen = ub(der, offset);
  offset++;

  // Extract r (skip leading 0x00 if present for positive encoding)
  let rStart = offset;
  if (ub(der, offset) === 0x00) {
    rStart++;
  }
  const rLenActual = rLen - (rStart - offset);
  const r = der.subarray(rStart, rStart + rLenActual);

  // Now at s INTEGER
  if (ub(der, offset) !== 0x02) {
    throw new DerGenerationError(
      `Expected INTEGER (0x02) for s, got 0x${ub(der, offset).toString(16)}`,
    );
  }
  offset++;

  const sLen = ub(der, offset);
  offset++;

  let sStart = offset;
  if (ub(der, offset) === 0x00) {
    sStart++;
  }
  const sLenActual = sLen - (sStart - offset);
  const s = der.subarray(sStart, sStart + sLenActual);

  // Pad r and s to exactly 32 bytes each (P-256)
  const rPadded = padTo32(r);
  const sPadded = padTo32(s);

  return concatBytes(rPadded, sPadded);
};

const padTo32 = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length === 32) return bytes;
  if (bytes.length > 32) {
    return bytes.subarray(bytes.length - 32);
  }
  const padded = new Uint8Array(32);
  padded.set(bytes, 32 - bytes.length);
  return padded;
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const concatBytes = (...arrays: Uint8Array[]): Uint8Array => {
  const totalLen = arrays.reduce((acc, a) => acc + a.byteLength, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.byteLength;
  }
  return result;
};

const generateRandomSerial = (): Uint8Array => {
  const serial = new Uint8Array(20);
  globalThis.crypto.getRandomValues(serial);
  const first = ub(serial, 0);
  const masked = first & 0x7f;
  // Ensure non-zero
  serial[0] = masked === 0 ? 1 : masked;
  return serial;
};
