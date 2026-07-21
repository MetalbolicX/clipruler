import { VERSION } from "./src/version.ts";

const HELP = `clipruler ${VERSION}
LAN clipboard sharing.

Usage:
  clipruler daemon     Run the background sync daemon (foreground process)
  clipruler desktop    Run the Deno Desktop tray app (Tier 1 platforms)
  clipruler pair       Pair with a discovered device
  clipruler list       List known and available devices
  clipruler enable     Enable clipboard sharing with a device
  clipruler disable    Disable clipboard sharing with a device
  clipruler forget     Remove a paired device
  clipruler status     Show daemon status
  clipruler --help     Show this help
  clipruler --version  Show version

Platform support:
  Tier 1 (full): Windows x86_64, Linux glibc x86_64/arm64 (Wayland + X11)
  Tier 2 (daemon only): Alpine desktop
  Tier 3 (relay only): Alpine headless / any headless server
`;

const args = Deno.args;
if (args.includes("--help") || args.includes("-h")) {
  console.log(HELP);
  Deno.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  Deno.exit(0);
}

if (args[0] === "daemon") {
  const deviceName = Deno.env.get("CLIPRULER_DEVICE_NAME") ?? Deno.hostname();
  await import("./src/shells/daemon.ts").then((m) => m.daemonMain(deviceName));
  Deno.exit(0);
}

console.error("No subcommand provided. Run `clipruler --help`.");
Deno.exit(1);
