/**
 * infrastructure/persistence/state-store.ts
 *
 * StateStore — loads and saves the StateFileV1 to the filesystem using
 * an atomic write pattern: write-to-tmp → fsync → rename → fsync directory.
 *
 * Uses Deno runtime APIs (Deno.writeFile, Deno.rename, Deno.open, Deno.fsync)
 * for the file I/O operations.
 */

import type { AppPaths } from "./app-paths.ts";
import { isStateFileV1 } from "./state-file-v1.ts";
import { CorruptedStateError, SchemaVersionMismatchError } from "./errors.ts";
import type { StateFileV1 } from "./state-file-v1.ts";
const SCHEMA_VERSION = 1;
const TMP_SUFFIX = ".tmp";

export class StateStore {
  constructor(
    private readonly appPaths: AppPaths,
  ) {}

  /**
   * Loads the persisted state file.
   *
   * @returns StateFileV1 if the file exists and is valid.
   * @returns null if the file does not exist.
   * @throws CorruptedStateError if the file exists but is not valid JSON
   *         or fails structural validation.
   * @throws SchemaVersionMismatchError if the schema version is not 1.
   */
  async load(): Promise<StateFileV1 | null> {
    const { stateFile } = this.appPaths;

    let fileContent: string;
    try {
      fileContent = await Deno.readTextFile(stateFile);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        return null;
      }
      throw new CorruptedStateError(`Read error: ${(err as Error).message}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fileContent);
    } catch {
      throw new CorruptedStateError("File content is not valid JSON");
    }

    if (!isStateFileV1(parsed)) {
      const version = (parsed as Record<string, unknown>)["schemaVersion"];
      if (version !== undefined && version !== SCHEMA_VERSION) {
        throw new SchemaVersionMismatchError(SCHEMA_VERSION, version);
      }
      throw new CorruptedStateError("State file failed structural validation");
    }

    return parsed;
  }

  /**
   * Saves the given state to the filesystem atomically.
   *
   * Atomic write sequence:
   * 1. Write JSON to a temp file (<stateFile>.tmp.<uuid>)
   * 2. fsync the temp file to disk
   * 3. Rename temp file → final stateFile
   * 4. fsync the data directory to commit the rename
   *
   * On success: the final stateFile exists and no .tmp.* file remains.
   * On rename failure: the prior stateFile is unchanged.
   */
  async save(state: StateFileV1): Promise<void> {
    const { stateFile, dataDir } = this.appPaths;

    // Serialize to JSON
    const content = JSON.stringify(state, null, 2);

    // Temp file path — use crypto.randomUUID for uniqueness
    const tmpId = globalThis.crypto.randomUUID();
    const tmpFile = `${stateFile}${TMP_SUFFIX}.${tmpId}`;

    // Step 1: write to temp file (replace if exists)
    await Deno.writeTextFile(tmpFile, content);

    // Step 2: fsync the temp file
    const tmpFileHandle = await Deno.open(tmpFile, { read: true, write: false });
    try {
      await tmpFileHandle.syncData();
    } finally {
      tmpFileHandle.close();
    }

    // Step 3: rename temp → final
    try {
      await Deno.rename(tmpFile, stateFile);
    } catch (err) {
      // On rename failure, attempt to clean up the temp file and propagate
      try {
        await Deno.remove(tmpFile);
      } catch {
        // best-effort cleanup of temp file
      }
      throw err;
    }

    // Step 4: fsync the data directory to commit the rename
    const dirHandle = await Deno.open(dataDir, { read: true, write: false });
    try {
      await dirHandle.syncData();
    } finally {
      dirHandle.close();
    }
  }
}
