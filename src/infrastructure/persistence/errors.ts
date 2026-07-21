/**
 * infrastructure/persistence/errors.ts
 *
 * Typed error classes for the persistence layer.
 * Exported as tagged classes extending Error for instanceof checks.
 */

/**
 * Thrown when the persisted state file has a schema version that does not
 * match the expected version (currently 1).
 */
export class SchemaVersionMismatchError extends Error {
  readonly tag = "SchemaVersionMismatchError" as const;
  readonly expectedVersion: number;
  readonly actualVersion: unknown;

  constructor(expectedVersion: number, actualVersion: unknown) {
    super(
      `Schema version mismatch: expected ${expectedVersion}, got ${JSON.stringify(actualVersion)}`,
    );
    this.name = "SchemaVersionMismatchError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

/**
 * Thrown when the state file exists but its JSON content is malformed
 * or fails structural validation.
 */
export class CorruptedStateError extends Error {
  readonly tag = "CorruptedStateError" as const;
  override readonly cause: string;

  constructor(cause: string) {
    super(`Corrupted state file: ${cause}`);
    this.name = "CorruptedStateError";
    this.cause = cause;
  }
}
