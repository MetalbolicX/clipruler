/**
 * shells/cli/mod.ts
 *
 * CLI shell entry point — parses args and dispatches to handlers.
 *
 * Design (Plan 010):
 * - Uses `@std/cli` `parseArgs` for argument parsing
 * - Reads admin endpoint via `readAdminEndpoint()`
 * - Subcommands: list, status, pair, toggle, forget, help
 * - All subcommands communicate with the daemon via `adminCommand()`
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

async function resolveEndpoint(): Promise<AdminEndpoint | null> {
  const paths = resolveAppPaths();
  try {
    return await readAdminEndpoint(paths.adminEndpointFile);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

/**
 * Main CLI entry point.
 *
 * Subcommands:
 *   list   — list paired and available devices
 *   status — show daemon status
 *   pair   — initiate pairing with a nearby device
 *   toggle — toggle clipboard sharing for a device
 *   forget — remove a paired device
 *   help   — show this help text
 */
export async function cliMain(args: string[]): Promise<void> {
  const flags = parseArgs(args, {
    boolean: ["help", "h"],
    string: [],
    stopEarly: false,
  });

  // Handle help flag
  if (flags.help || flags.h) {
    printHelp();
    Deno.exit(0);
    return;
  }

  // Flatten to subcommand (first non-flag arg)
  const subcommands = ["list", "status", "pair", "toggle", "forget", "help"];
  const positionalArgs = args.filter((a) => !a.startsWith("-"));
  const subcommand = positionalArgs.find((a) => subcommands.includes(a));

  // Unknown subcommand (positional arg that isn't a known subcommand)
  if (positionalArgs.length > 0 && !subcommand) {
    console.error(`Unknown subcommand: ${positionalArgs[0]}`);
    printHelp();
    Deno.exit(2);
    return;
  }

  // No subcommand at all → show help
  if (!subcommand) {
    printHelp();
    Deno.exit(0);
    return;
  }

  // Resolve admin endpoint
  const endpoint = await resolveEndpoint();
  if (!endpoint) {
    console.error("Error: daemon not reachable (admin endpoint not found)");
    Deno.exit(2);
    return;
  }

  // Dispatch subcommands
  switch (subcommand) {
    case "list": {
      const response = await adminCommand(endpoint, "admin.list", { _kind: "admin.list" });
      if (response.status === "error") {
        console.error(`Error: ${response.message ?? "unknown error"}`);
        Deno.exit(1);
        return;
      }
      await renderDevices(
        response.data as import("../../application/list-devices.ts").DeviceListView,
      );
      Deno.exit(0);
      break;
    }

    case "status": {
      const response = await adminCommand(endpoint, "admin.status", { _kind: "admin.status" });
      if (response.status === "error") {
        console.error(`Error: ${response.message ?? "unknown error"}`);
        Deno.exit(1);
        return;
      }
      await renderStatus(response as Parameters<typeof renderStatus>[0]);
      Deno.exit(0);
      break;
    }

    case "pair": {
      // Pairing uses the local device name from the daemon's perspective.
      // We use a placeholder here; the daemon fills in the device name.
      const response = await adminCommand(endpoint, "admin.pair.request", { deviceName: "" });
      if (response.status === "error") {
        console.error(`Pairing failed: ${response.message ?? "unknown error"}`);
        Deno.exit(1);
        return;
      }
      await renderPairResult(response as Parameters<typeof renderPairResult>[0]);
      Deno.exit(0);
      break;
    }

    case "toggle": {
      // toggle requires device-id and --enable/--disable
      const deviceId = args.find(
        (a) => !a.startsWith("-") && a !== "toggle",
      );
      const enableFlag = args.includes("--enable");
      const disableFlag = args.includes("--disable");

      if (!deviceId || (!enableFlag && !disableFlag)) {
        console.error("Usage: clipruler toggle <device-id> {--enable|--disable}");
        Deno.exit(2);
        return;
      }

      const kind = enableFlag ? "admin.enable" : "admin.disable";
      const response = await adminCommand(endpoint, kind, { fingerprint: deviceId });

      if (response.status === "error") {
        console.error(`Error: ${response.message ?? "unknown error"}`);
        Deno.exit(1);
        return;
      }

      console.log("OK");
      Deno.exit(0);
      break;
    }

    case "forget": {
      const deviceId = args.find(
        (a) => !a.startsWith("-") && a !== "forget",
      );
      if (!deviceId) {
        console.error("Usage: clipruler forget <device-id>");
        Deno.exit(2);
        return;
      }

      const response = await adminCommand(endpoint, "admin.forget", { fingerprint: deviceId });
      if (response.status === "error") {
        console.error(`Error: ${response.message ?? "unknown error"}`);
        Deno.exit(1);
        return;
      }

      console.log("Device removed.");
      Deno.exit(0);
      break;
    }

    case "help": {
      printHelp();
      Deno.exit(0);
      break;
    }

    default: {
      console.error(`Unknown subcommand: ${subcommand}`);
      printHelp();
      Deno.exit(2);
    }
  }
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`Usage: clipruler <subcommand> [options]

Subcommands:
  list                List paired and available devices
  status              Show daemon status
  pair                Initiate pairing with a nearby device
  toggle <device-id> {--enable|--disable}
                      Toggle clipboard sharing for a device
  forget <device-id>  Remove a paired device
  help                Show this help text

Options:
  --help, -h          Show this help text
`);
}
