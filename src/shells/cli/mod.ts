/**
 * shells/cli/mod.ts
 *
 * CLI shell entry point — parses args and dispatches to handlers.
 *
 * Design (Plan 010):
 * - Uses `@std/cli` `parseArgs` for argument parsing
 * - Reads admin endpoint via `readAdminEndpoint()`
 * - Subcommands: list, status, pair, enable, disable, forget, help
 * - All subcommands communicate with the daemon via `adminCommand()`
 * - Returns an exit code; never calls Deno.exit. main.ts owns process exit.
 */

import { parseArgs } from "@std/cli";
import { resolveAppPaths } from "../../infrastructure/persistence/app-paths.ts";
import { readAdminEndpoint } from "./admin-client.ts";
import { adminCommand } from "./admin-client.ts";
import { renderDevices } from "./render.ts";
import { renderStatus } from "./render.ts";
import { renderPairResult } from "./render.ts";
import type { AdminEndpoint } from "./admin-client.ts";

// ---------------------------------------------------------------------------
// Admin endpoint resolution
// ---------------------------------------------------------------------------

const resolveEndpoint = async (): Promise<AdminEndpoint | null> => {
  const paths = resolveAppPaths();
  try {
    return await readAdminEndpoint(paths.adminEndpointFile);
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

/**
 * Main CLI entry point.
 *
 * Subcommands:
 *   list    — list paired and available devices
 *   status  — show daemon status
 *   pair    — initiate pairing with a nearby device
 *   enable  — enable clipboard sharing for a device
 *   disable — disable clipboard sharing for a device
 *   forget  — remove a paired device
 *   help    — show this help text
 *
 * Returns an exit code:
 *   0 — success
 *   1 — daemon error (request failed or threw)
 *   2 — daemon not reachable / unknown subcommand / usage error
 */
export const cliMain = async (args: string[]): Promise<number> => {
  const flags = parseArgs(args, {
    boolean: ["help", "h"],
    string: [],
    stopEarly: false,
  });

  // Handle help flag
  if (flags.help || flags.h) {
    printHelp();
    return 0;
  }

  // Flatten to subcommand (first non-flag arg)
  const subcommands = [
    "list",
    "status",
    "pair",
    "enable",
    "disable",
    "forget",
    "help",
  ];
  const positionalArgs = args.filter((a) => !a.startsWith("-"));
  const subcommand = positionalArgs.find((a) => subcommands.includes(a));

  // Unknown subcommand (positional arg that isn't a known subcommand)
  if (positionalArgs.length > 0 && !subcommand) {
    console.error(`Unknown subcommand: ${positionalArgs[0]}`);
    printHelp();
    return 2;
  }

  // No subcommand at all → show help
  if (!subcommand) {
    printHelp();
    return 0;
  }

  // Resolve admin endpoint
  const endpoint = await resolveEndpoint();
  if (!endpoint) {
    console.error("Error: daemon not reachable (admin endpoint not found)");
    return 2;
  }

  // Top-level error handler — any thrown error maps to exit 1 (daemon error).
  try {
    return await dispatchSubcommand(subcommand, args, endpoint);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
};

/**
 * Dispatch a subcommand. Extracted for top-level error handling.
 * Returns an exit code.
 */
const dispatchSubcommand = async (
  subcommand: string,
  args: string[],
  endpoint: AdminEndpoint,
): Promise<number> => {
  switch (subcommand) {
    case "list": {
      const response = await adminCommand(endpoint, "admin.list", {
        _kind: "admin.list",
      });
      if (response.status === "error") {
        console.error(`Error: ${response.message ?? "unknown error"}`);
        return 1;
      }
      await renderDevices(
        response.data as import("../../application/list-devices.ts").DeviceListView,
      );
      return 0;
    }

    case "status": {
      const response = await adminCommand(endpoint, "admin.status", {
        _kind: "admin.status",
      });
      if (response.status === "error") {
        console.error(`Error: ${response.message ?? "unknown error"}`);
        return 1;
      }
      await renderStatus(response as Parameters<typeof renderStatus>[0]);
      return 0;
    }

    case "pair": {
      const response = await adminCommand(endpoint, "admin.pair.request", {
        deviceName: "",
      });
      if (response.status === "error") {
        console.error(`Pairing failed: ${response.message ?? "unknown error"}`);
        return 1;
      }
      await renderPairResult(response as Parameters<typeof renderPairResult>[0]);
      return 0;
    }

    case "enable": {
      const deviceId = args.find((a) => !a.startsWith("-") && a !== "enable");
      if (!deviceId) {
        console.error("Usage: clipruler enable <device-id>");
        return 2;
      }
      const response = await adminCommand(endpoint, "admin.enable", {
        fingerprint: deviceId,
      });
      if (response.status === "error") {
        console.error(`Error: ${response.message ?? "unknown error"}`);
        return 1;
      }
      console.log("OK");
      return 0;
    }

    case "disable": {
      const deviceId = args.find((a) => !a.startsWith("-") && a !== "disable");
      if (!deviceId) {
        console.error("Usage: clipruler disable <device-id>");
        return 2;
      }
      const response = await adminCommand(endpoint, "admin.disable", {
        fingerprint: deviceId,
      });
      if (response.status === "error") {
        console.error(`Error: ${response.message ?? "unknown error"}`);
        return 1;
      }
      console.log("OK");
      return 0;
    }

    case "forget": {
      const deviceId = args.find((a) => !a.startsWith("-") && a !== "forget");
      if (!deviceId) {
        console.error("Usage: clipruler forget <device-id>");
        return 2;
      }
      const response = await adminCommand(endpoint, "admin.forget", {
        fingerprint: deviceId,
      });
      if (response.status === "error") {
        console.error(`Error: ${response.message ?? "unknown error"}`);
        return 1;
      }
      console.log("Device removed.");
      return 0;
    }

    case "help": {
      printHelp();
      return 0;
    }

    default: {
      console.error(`Unknown subcommand: ${subcommand}`);
      printHelp();
      return 2;
    }
  }
};

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const printHelp = (): void => {
  console.log(`Usage: clipruler <subcommand> [options]

Subcommands:
  list                List paired and available devices
  status              Show daemon status
  pair                Initiate pairing with a nearby device
  enable <device-id>  Enable clipboard sharing for a device
  disable <device-id> Disable clipboard sharing for a device
  forget <device-id>  Remove a paired device
  help                Show this help text

Options:
  --help, -h          Show this help text
`);
};
