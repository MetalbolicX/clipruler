/**
 * infrastructure/persistence/app-paths.ts
 *
 * Resolves application paths for config, data, cache, state, and PID files.
 *
 * POSIX: honors XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME;
 * falls back to ~/.config, ~/.local/share, ~/.cache when absent.
 * Windows: uses %APPDATA% for config/data and %LOCALAPPDATA% for cache.
 *
 * All resolved paths are absolute and live under a "clipruler" subdirectory.
 *
 * The `makeAppPaths` factory accepts an optional env getter for testability.
 * Production code calls `makeAppPaths()` with no arguments to use the real
 * Deno.env.get.
 */

import { resolve } from "@std/path";

const APP_NAME = "clipruler";
const STATE_FILENAME = "state.json";
const PID_FILENAME = "clipruler.pid";

export interface AppPaths {
  readonly configDir: string;
  readonly dataDir: string;
  readonly cacheDir: string;
  readonly stateFile: string;
  readonly pidFile: string;
  readonly adminEndpointFile: string;
}

type EnvGetter = (key: string) => string | undefined;

/**
 * Factory — creates AppPaths using the provided EnvGetter.
 * Pass `Deno.env.get.bind(Deno.env)` in production, or a fake for tests.
 * When called with no args, uses the real Deno environment.
 */
export const makeAppPaths = (env: EnvGetter = Deno.env.get.bind(Deno.env)): AppPaths => {
  const os = env("OS") ?? "";

  if (os === "Windows_NT") {
    return makeWindowsPaths(env);
  }
  return makePosixPaths(env);
};

const makePosixPaths = (env: EnvGetter): AppPaths => {
  const home = env("HOME") ?? "/tmp";
  const configHome = env("XDG_CONFIG_HOME") ?? resolve(home, ".config");
  const dataHome = env("XDG_DATA_HOME") ?? resolve(home, ".local", "share");
  const cacheHome = env("XDG_CACHE_HOME") ?? resolve(home, ".cache");

  const configDir = resolve(configHome, APP_NAME);
  const dataDir = resolve(dataHome, APP_NAME);
  const cacheDir = resolve(cacheHome, APP_NAME);
  const stateFile = resolve(dataDir, STATE_FILENAME);
  const pidFile = resolve(dataDir, PID_FILENAME);

  return {
    configDir,
    dataDir,
    cacheDir,
    stateFile,
    pidFile,
    adminEndpointFile: resolve(dataDir, "admin.endpoint"),
  };
};

const makeWindowsPaths = (env: EnvGetter): AppPaths => {
  const appData = env("APPDATA") ?? "C:/Users/Unknown/AppData/Roaming";
  const localAppData = env("LOCALAPPDATA") ?? "C:/Users/Unknown/AppData/Local";

  // On Windows, these paths are already absolute (C:/...).  On a non-Windows
  // platform running this code (e.g. a Linux test runner), we cannot rely on
  // std/path resolve() to handle Windows drive letters — detect absolute
  // Windows paths by the drive-letter prefix and treat them as already absolute.
  const winAbs = (p: string) => /^[A-Za-z]:[/\\]/.test(p) ? p : resolve(p);

  const configDir = winAbs(appData) + "/" + APP_NAME;
  const dataDir = winAbs(appData) + "/" + APP_NAME;
  const cacheDir = winAbs(localAppData) + "/" + APP_NAME;
  const stateFile = resolve(dataDir, STATE_FILENAME);
  const pidFile = resolve(dataDir, PID_FILENAME);
  const adminEndpointFile = dataDir + "/admin.endpoint";

  return { configDir, dataDir, cacheDir, stateFile, pidFile, adminEndpointFile };
};

/**
 * Resolve the application paths using the real Deno environment.
 * Alias for makeAppPaths() with no arguments.
 */
export const resolveAppPaths = (): AppPaths => {
  return makeAppPaths();
};

/**
 * Ensure all required application directories exist.
 * Creates configDir, dataDir, and cacheDir recursively.
 */
export const ensureAppDirs = async (paths: AppPaths): Promise<void> => {
  for (const dir of [paths.configDir, paths.dataDir, paths.cacheDir]) {
    try {
      await Deno.mkdir(dir, { recursive: true });
    } catch (err) {
      if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
    }
  }
};
