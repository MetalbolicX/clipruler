/**
 * infrastructure/clipboard/which.ts
 *
 * Probes whether a binary is available on PATH by running `which <bin>`.
 * Used by adapter constructors to lazily detect available clipboard tools
 * without spawning subprocesses until first use.
 */

/**
 * Returns true if `bin` is found on PATH, false otherwise.
 */
export async function which(bin: string): Promise<boolean> {
  const proc = new Deno.Command("which", {
    args: [bin],
    stdout: "null",
    stderr: "null",
  });
  const { code } = await proc.output();
  return code === 0;
}
