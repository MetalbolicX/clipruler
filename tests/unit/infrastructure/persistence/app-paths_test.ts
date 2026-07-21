/**
 * Unit tests for infrastructure/persistence/app-paths.ts.
 *
 * Verifies:
 * - POSIX: XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME honored
 * - POSIX fallback: ~/.config, ~/.local/share, ~/.cache when env vars absent
 * - Windows: %APPDATA% for config/data; %LOCALAPPDATA% for cache
 * - All paths are absolute and rooted under the app subdirectory "clipruler"
 * - Derived files (stateFile, pidFile) are correctly placed under dataDir
 *
 * Layer: unit.
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0";
import { isAbsolute } from "@std/path";
import { makeAppPaths } from "../../../../src/infrastructure/persistence/app-paths.ts";

function makeFakeEnv(
  env: Record<string, string>,
): (key: string) => string | undefined {
  return (key: string) => env[key];
}

Deno.test("POSIX with XDG env vars — all paths are absolute and use env values", () => {
  const paths = makeAppPaths(makeFakeEnv({
    OS: "Linux",
    XDG_CONFIG_HOME: "/custom/config",
    XDG_DATA_HOME: "/custom/data",
    XDG_CACHE_HOME: "/custom/cache",
  }));

  assertEquals(paths.configDir, "/custom/config/clipruler");
  assertEquals(paths.dataDir, "/custom/data/clipruler");
  assertEquals(paths.cacheDir, "/custom/cache/clipruler");
  assertEquals(isAbsolute(paths.stateFile), true);
  assertEquals(isAbsolute(paths.pidFile), true);
  assertStringIncludes(paths.stateFile, "/custom/data/clipruler/");
  assertStringIncludes(paths.pidFile, "/custom/data/clipruler/");
});

Deno.test(
  "POSIX without XDG env vars — falls back to ~/.config, ~/.local/share, ~/.cache",
  () => {
    const paths = makeAppPaths(makeFakeEnv({
      OS: "Linux",
      HOME: "/home/testuser",
    }));

    assertEquals(paths.configDir, "/home/testuser/.config/clipruler");
    assertEquals(paths.dataDir, "/home/testuser/.local/share/clipruler");
    assertEquals(paths.cacheDir, "/home/testuser/.cache/clipruler");
    assertEquals(isAbsolute(paths.stateFile), true);
    assertEquals(isAbsolute(paths.pidFile), true);
  },
);

Deno.test(
  "Windows — uses %APPDATA% for config/data and %LOCALAPPDATA% for cache",
  () => {
    const paths = makeAppPaths(makeFakeEnv({
      OS: "Windows_NT",
      APPDATA: "C:/Users/testuser/AppData/Roaming",
      LOCALAPPDATA: "C:/Users/testuser/AppData/Local",
    }));

    assertEquals(paths.configDir, "C:/Users/testuser/AppData/Roaming/clipruler");
    assertEquals(paths.dataDir, "C:/Users/testuser/AppData/Roaming/clipruler");
    assertEquals(paths.cacheDir, "C:/Users/testuser/AppData/Local/clipruler");
    assertEquals(isAbsolute(paths.stateFile), true);
    assertEquals(isAbsolute(paths.pidFile), true);
  },
);

Deno.test("stateFile and pidFile are under dataDir with correct filenames", () => {
  const paths = makeAppPaths(makeFakeEnv({
    OS: "Linux",
    HOME: "/home/user",
  }));

  assertStringIncludes(paths.stateFile, "state.json");
  assertStringIncludes(paths.pidFile, "clipruler.pid");
});
