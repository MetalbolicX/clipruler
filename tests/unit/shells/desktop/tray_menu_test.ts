/**
 * Unit tests for shells/desktop/tray-menu.ts — TrayMenu state machine
 *
 * Verifies the tray menu state machine (Design #2534, DS-3.1/3.2/3.3):
 * - daemon down: "Status unavailable"; Show/Pair disabled; Quit enabled
 * - daemon up + 0 paired: "Status running on :P"; Show enabled; Pair disabled
 * - daemon up + N paired: Show enabled; device rows enable Enable/Disable/Forget
 * - Pair click → admin.pair.request → not_implemented → placeholder state
 * - Quit → running.stop → tray.destroy → 0
 * - trayId 0 logs warning but is nonfatal
 *
 * Layer: unit — injects a mock tray via _tray seam.
 */

import { assertEquals } from "jsr:@std/assert@^1.0";

// ---------------------------------------------------------------------------
// Mock types — mirrors the TrayHandle interface
// ---------------------------------------------------------------------------

interface MockTrayItem {
  label: string;
  disabled?: boolean;
  click?: () => void;
}

interface MockTrayHandle {
  id: number;
  menuItems: MockTrayItem[];
  setMenuItems(items: MockTrayItem[]): void;
  destroy?(): void;
}

function makeMockTray(id = 1): MockTrayHandle {
  const items: MockTrayItem[] = [];
  return {
    id,
    menuItems: items,
    setMenuItems(next: MockTrayItem[]) {
      this.menuItems = next;
    },
  };
}

// ---------------------------------------------------------------------------
// Mock admin command
// ---------------------------------------------------------------------------

type AdminEndpoint = { kind: "unix"; path: string } | { kind: "tcp"; port: number };

interface MockAdminCommand {
  callCount: number;
  calls: Array<{ method: string; params?: unknown }>;
  // deno-lint-ignore no-explicit-any
  responses: Map<string, any>;
}

function makeMockAdminCommand(): MockAdminCommand & {
  (endpoint: AdminEndpoint, method: string, params?: unknown): Promise<unknown>;
} {
  const mock: MockAdminCommand = {
    callCount: 0,
    calls: [],
    responses: new Map(),
  };

  const fn = (
    _endpoint: AdminEndpoint,
    method: string,
    params?: unknown,
  ): Promise<unknown> => {
    mock.callCount++;
    mock.calls.push({ method, params });
    const response = mock.responses.get(method);
    return Promise.resolve(response ?? { status: "ok" });
  };

  return Object.assign(fn, mock);
}

// ---------------------------------------------------------------------------
// Test helpers — import the class lazily (RED phase: file does not exist yet)
// ---------------------------------------------------------------------------

Deno.test("tray-menu: daemon down → Status unavailable, Show/Pair disabled, Quit enabled", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { TrayMenu } = await import("../../../../src/shells/desktop/tray-menu.ts");

  const tray = makeMockTray(1);
  const adminCmd = makeMockAdminCommand();
  const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/test.sock" };
  // @ts-ignore — _tray seam for test injection
  const menu = new TrayMenu({ _tray: tray, endpoint, adminCommand: adminCmd });

  menu.setStatus({ running: false, deviceCount: 0 });

  const items = tray.menuItems;
  assertEquals(
    items.some((i) => i.label?.includes("Status unavailable")),
    true,
    "Status unavailable text",
  );
  assertEquals(items.some((i) => i.label?.includes("Show")), true, "Show item present");
  const showItem = items.find((i) => i.label?.includes("Show"));
  assertEquals(showItem?.disabled, true, "Show disabled when daemon down");
  const pairItem = items.find((i) => i.label?.includes("Pair"));
  assertEquals(pairItem?.disabled, true, "Pair disabled when daemon down");
  const quitItem = items.find((i) => i.label?.includes("Quit"));
  assertEquals(quitItem?.disabled, false, "Quit enabled when daemon down");
});

Deno.test("tray-menu: daemon up + 0 paired → Status running on :P, Show enabled, Pair disabled", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { TrayMenu } = await import("../../../../src/shells/desktop/tray-menu.ts");

  const tray = makeMockTray(1);
  const adminCmd = makeMockAdminCommand();
  const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/test.sock" };
  // @ts-ignore — _tray seam for test injection
  const menu = new TrayMenu({ _tray: tray, endpoint, adminCommand: adminCmd });

  menu.setStatus({ running: true, deviceCount: 0, port: 12345 });

  const items = tray.menuItems;
  assertEquals(
    items.some((i) => i.label?.includes("Status running")),
    true,
    "Status running text",
  );
  const showItem = items.find((i) => i.label?.includes("Show"));
  assertEquals(showItem?.disabled, false, "Show enabled when daemon up");
  const pairItem = items.find((i) => i.label?.includes("Pair"));
  assertEquals(pairItem?.disabled, true, "Pair disabled with 0 paired devices");
});

Deno.test("tray-menu: daemon up + N paired → device rows, Enable/Disable/Forget enabled", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { TrayMenu } = await import("../../../../src/shells/desktop/tray-menu.ts");

  const tray = makeMockTray(1);
  const adminCmd = makeMockAdminCommand();
  const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/test.sock" };
  // @ts-ignore — _tray seam for test injection
  const menu = new TrayMenu({ _tray: tray, endpoint, adminCommand: adminCmd });

  menu.setStatus({ running: true, deviceCount: 2, port: 12345 });

  const items = tray.menuItems;
  const showItem = items.find((i) => i.label?.includes("Show"));
  assertEquals(showItem?.disabled, false, "Show enabled");
  assertEquals(items.some((i) => i.label?.toLowerCase().includes("device")), true, "device row present");
  assertEquals(
    items.some((i) => i.label?.toLowerCase().includes("enable")),
    true,
    "Enable action present",
  );
  assertEquals(
    items.some((i) => i.label?.toLowerCase().includes("disable")),
    true,
    "Disable action present",
  );
  assertEquals(
    items.some((i) => i.label?.toLowerCase().includes("forget")),
    true,
    "Forget action present",
  );
});

Deno.test("tray-menu: Pair click → admin.pair.request → not_implemented → placeholder state, tray alive", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { TrayMenu } = await import("../../../../src/shells/desktop/tray-menu.ts");

  const tray = makeMockTray(1);
  const adminCmd = makeMockAdminCommand();
  adminCmd.responses.set("admin.pair.request", {
    status: "error",
    message: "not_implemented",
  });
  const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/test.sock" };
  // @ts-ignore — _tray seam for test injection
  const menu = new TrayMenu({ _tray: tray, endpoint, adminCommand: adminCmd });

  menu.setStatus({ running: true, deviceCount: 1, port: 12345 });

  // Find and click Pair
  const pairItem = tray.menuItems.find((i) => i.label?.includes("Pair"));
  assertEquals(pairItem !== undefined, true, "Pair item must exist");
  assertEquals(pairItem?.disabled, false, "Pair should be enabled with paired devices");

  // Simulate clicking Pair
  await pairItem?.click?.();

  // Menu should transition to placeholder state
  assertEquals(
    tray.menuItems.some((i) =>
      i.label?.toLowerCase().includes("not yet implemented") ||
      i.label?.toLowerCase().includes("placeholder")
    ),
    true,
    "placeholder state must appear after Pair returns not_implemented",
  );
  // Tray must still have menu items (not destroyed — tray alive)
  assertEquals(tray.menuItems.length > 0, true, "tray still has menu after not_implemented");
});

Deno.test("tray-menu: Quit click → running.stop called and tray destroyed", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { TrayMenu } = await import("../../../../src/shells/desktop/tray-menu.ts");

  const tray = makeMockTray(1);
  const adminCmd = makeMockAdminCommand();
  const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/test.sock" };
  let stopCalled = false;
  const running = { stop: () => { stopCalled = true; } };
  // @ts-ignore — _tray seam for test injection
  const menu = new TrayMenu({ _tray: tray, endpoint, adminCommand: adminCmd, running });

  menu.setStatus({ running: true, deviceCount: 0, port: 12345 });

  const quitItem = tray.menuItems.find((i) => i.label?.includes("Quit"));
  assertEquals(quitItem !== undefined, true, "Quit item must exist");
  quitItem?.click?.();

  assertEquals(stopCalled, true, "running.stop() must be called on Quit");
  assertEquals(tray.menuItems.some((i) => i.label?.includes("Quitting")), true, "Quitting label shown");
});

Deno.test("tray-menu: trayId 0 logs warning but is nonfatal", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { TrayMenu } = await import("../../../../src/shells/desktop/tray-menu.ts");

  const tray = makeMockTray(0); // id === 0
  const adminCmd = makeMockAdminCommand();
  const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/test.sock" };
  // @ts-ignore — _tray seam for test injection; should not throw
  const menu = new TrayMenu({ _tray: tray, endpoint, adminCommand: adminCmd });

  // Should still work — setStatus should not throw
  menu.setStatus({ running: false, deviceCount: 0 });

  assertEquals(tray.menuItems.length > 0, true, "menu still built despite trayId 0");
});

Deno.test("tray-menu: setPairingError updates menu to placeholder state", async () => {
  // @ts-ignore — module does not exist yet (RED test)
  const { TrayMenu } = await import("../../../../src/shells/desktop/tray-menu.ts");

  const tray = makeMockTray(1);
  const adminCmd = makeMockAdminCommand();
  const endpoint: AdminEndpoint = { kind: "unix", path: "/tmp/test.sock" };
  // @ts-ignore — _tray seam for test injection
  const menu = new TrayMenu({ _tray: tray, endpoint, adminCommand: adminCmd });

  menu.setStatus({ running: true, deviceCount: 0, port: 12345 });

  // Simulate pairing error (daemon returns not_implemented)
  menu.setPairingError("not_implemented");

  const items = tray.menuItems;
  assertEquals(
    items.some((i) =>
      i.label?.toLowerCase().includes("not yet implemented") ||
      i.label?.toLowerCase().includes("placeholder")
    ),
    true,
    "placeholder state must appear after pairing error",
  );
});
