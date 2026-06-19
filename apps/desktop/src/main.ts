import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, shell } from "electron";
import path from "path";
import type { ChildProcess } from "child_process";
import AutoLaunch from "auto-launch";
import * as agent from "./agentBridge";

// Single-instance: tray apps must not launch twice.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let syncChild: ChildProcess | null = null;
const recentLogs: string[] = [];

const autoLauncher = new AutoLaunch({ name: "DriveOS Agent" });

function pushLog(line: string) {
  for (const l of line.split("\n").map((s) => s.trim()).filter(Boolean)) {
    recentLogs.push(`${new Date().toLocaleTimeString()}  ${l}`);
  }
  while (recentLogs.length > 200) recentLogs.shift();
  if (win) win.webContents.send("agent:log", recentLogs.slice(-50));
}

// Tray icon: use the bundled brand logo when present, else a generated square.
function trayIcon() {
  const candidates = [
    path.join(__dirname, "..", "build", "icon.png"),          // dev
    path.join(process.resourcesPath || "", "build", "icon.png"), // packaged (extraResources)
  ];
  for (const p of candidates) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
    } catch { /* fall through */ }
  }
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 0x6c; buf[i * 4 + 1] = 0x7b; buf[i * 4 + 2] = 0x9b; buf[i * 4 + 3] = 0xff;
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function showWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 460,
    height: 620,
    resizable: false,
    fullscreenable: false,
    title: "DriveOS Agent",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.on("closed", () => { win = null; });
}

async function refreshTrayMenu() {
  if (!tray) return;
  let status: agent.AgentStatus = { connected: false, paused: false, scanRoots: [] };
  try { status = await agent.getStatus(); } catch { /* keep default */ }

  const last = status.lastSyncCompletedAt
    ? new Date(status.lastSyncCompletedAt).toLocaleString()
    : "never";

  const menu = Menu.buildFromTemplate([
    { label: status.connected ? `Connected: ${status.machineName || "this machine"}` : "Not connected", enabled: false },
    { label: `Last sync: ${last}`, enabled: false },
    { label: status.paused ? "Status: Paused" : "Status: Running", enabled: false },
    { type: "separator" },
    { label: "Open DriveOS…", click: () => showWindow() },
    {
      label: "Scan Now",
      enabled: status.connected && !status.paused,
      click: async () => { pushLog("Scan Now requested…"); const r = await agent.scanNow(); pushLog(r.message); refreshTrayMenu(); },
    },
    status.paused
      ? { label: "Resume hourly sync", click: async () => { await agent.resume(); pushLog("Resumed."); refreshTrayMenu(); } }
      : { label: "Pause hourly sync", click: async () => { await agent.pause(); pushLog("Paused."); refreshTrayMenu(); } },
    { type: "separator" },
    { label: "Quit DriveOS", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(status.connected ? `DriveOS — ${status.paused ? "paused" : "running"}` : "DriveOS — not connected");
}

function startDaemonIfConnected() {
  agent.getStatus().then((s) => {
    if (s.connected && !syncChild) {
      syncChild = agent.startSyncDaemon(pushLog);
      pushLog("Hourly sync scheduler started.");
    }
  }).catch(() => { /* ignore */ });
}

// ---- IPC: renderer <-> main ----
ipcMain.handle("agent:status", async () => agent.getStatus());
ipcMain.handle("agent:logs", async () => recentLogs.slice(-50));
ipcMain.handle("agent:connect", async (_e, opts) => {
  const r = await agent.connect(opts);
  if (r.ok) { startDaemonIfConnected(); refreshTrayMenu(); }
  pushLog(r.message);
  return r;
});
ipcMain.handle("agent:scanNow", async () => { const r = await agent.scanNow(); pushLog(r.message); refreshTrayMenu(); return r; });
ipcMain.handle("agent:pause", async () => { await agent.pause(); pushLog("Paused."); refreshTrayMenu(); });
ipcMain.handle("agent:resume", async () => { await agent.resume(); pushLog("Resumed."); refreshTrayMenu(); });
ipcMain.handle("agent:addDrive", async (_e, { name, allowCloud }) => {
  const picked = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Choose a drive or folder to track" });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, message: "Cancelled." };
  const r = await agent.addDrive({ path: picked.filePaths[0], name, allowCloud });
  pushLog(r.message); refreshTrayMenu(); return r;
});
ipcMain.handle("agent:removeDrive", async (_e, { path: drivePath }) => {
  const choice = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Stop tracking", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: "Stop tracking this drive?",
    detail: `${drivePath}\n\nDriveOS will stop scanning it and remove it from the dashboard. The actual files on the drive are NOT deleted.`,
  });
  if (choice.response !== 0) return { ok: false, message: "Cancelled." };
  const r = await agent.removeDrive({ path: drivePath });
  pushLog(r.message); refreshTrayMenu(); return r;
});
ipcMain.handle("autolaunch:get", async () => { try { return await autoLauncher.isEnabled(); } catch { return false; } });
ipcMain.handle("autolaunch:set", async (_e, enabled: boolean) => {
  try { enabled ? await autoLauncher.enable() : await autoLauncher.disable(); return true; } catch { return false; }
});
ipcMain.handle("app:openDashboard", async (_e, url: string) => { if (url) await shell.openExternal(url); });

app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock?.hide(); // tray-only on macOS
  tray = new Tray(trayIcon());
  tray.on("click", () => showWindow());
  refreshTrayMenu();
  setInterval(refreshTrayMenu, 60_000);
  startDaemonIfConnected();
  showWindow(); // show the window on first launch so users can connect
});

app.on("second-instance", () => showWindow());
// Keep running in the tray when the window is closed (don't call app.quit()).
app.on("window-all-closed", () => { /* intentionally no-op: tray app stays resident */ });
app.on("before-quit", () => { if (syncChild) syncChild.kill(); });
