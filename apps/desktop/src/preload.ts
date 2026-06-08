import { contextBridge, ipcRenderer } from "electron";

// Secure bridge: the renderer can only call this fixed, audited surface.
contextBridge.exposeInMainWorld("driveos", {
  status: () => ipcRenderer.invoke("agent:status"),
  logs: () => ipcRenderer.invoke("agent:logs"),
  connect: (opts: { token: string; machine: string; convexUrl?: string; owner?: string }) =>
    ipcRenderer.invoke("agent:connect", opts),
  scanNow: () => ipcRenderer.invoke("agent:scanNow"),
  pause: () => ipcRenderer.invoke("agent:pause"),
  resume: () => ipcRenderer.invoke("agent:resume"),
  addDrive: (opts: { name?: string; allowCloud?: boolean }) => ipcRenderer.invoke("agent:addDrive", opts),
  getAutoLaunch: () => ipcRenderer.invoke("autolaunch:get"),
  setAutoLaunch: (enabled: boolean) => ipcRenderer.invoke("autolaunch:set", enabled),
  openDashboard: (url: string) => ipcRenderer.invoke("app:openDashboard", url),
  onLog: (cb: (lines: string[]) => void) => ipcRenderer.on("agent:log", (_e, lines) => cb(lines)),
});
