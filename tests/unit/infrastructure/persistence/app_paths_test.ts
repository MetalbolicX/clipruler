/**
 * Unit tests for infrastructure/persistence/app-paths.ts.
 *
 * Verifies:
 * - adminEndpointFile resolves to ${dataDir}/admin.endpoint
 * - Both POSIX (XDG) and Windows paths are correct
 *
 * Layer: unit — uses makeAppPaths with fake env.
 */
import { assertEquals } from "jsr:@std/assert@^1.0";
import { makeAppPaths } from "/home/metalbolicx/Documents/clipruler/src/infrastructure/persistence/app-paths.ts";

Deno.test("adminEndpointFile resolves to ${dataDir}/admin.endpoint on POSIX", () => {
  const paths = makeAppPaths((key) => {
    if (key === "HOME") return "/home/testuser";
    if (key === "XDG_CONFIG_HOME") return undefined;
    if (key === "XDG_DATA_HOME") return undefined;
    if (key === "XDG_CACHE_HOME") return undefined;
    if (key === "OS") return "";
    return undefined;
  });

  const expected = `${paths.dataDir}/admin.endpoint`;
  assertEquals(paths.adminEndpointFile, expected);
});

Deno.test("adminEndpointFile resolves to ${dataDir}/admin.endpoint on Windows", () => {
  const paths = makeAppPaths((key) => {
    if (key === "APPDATA") return "C:/Users/testuser/AppData/Roaming";
    if (key === "LOCALAPPDATA") return "C:/Users/testuser/AppData/Local";
    if (key === "OS") return "Windows_NT";
    return undefined;
  });

  const expected = `${paths.dataDir}/admin.endpoint`;
  assertEquals(paths.adminEndpointFile, expected);
});
