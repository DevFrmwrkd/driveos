import { app } from "electron";
import { spawn, execFile } from "child_process";
import path from "path";
import fs from "fs";

// Bridges the desktop app to the DriveOS agent CLI. We run the agent as a child
// process (Node script bundled with the app) rather than importing it, so the
// well-tested CLI stays the single source of truth for all scan/sync/safety logic.

export interface AgentStatus {
  connected: boolean;
  machineName?: string;
  convexUrl?: string;
  paused: boolean;
  pausedAt?: string;
  scanRoots: string[];
  lastSyncStartedAt?: string;
  lastSyncCompletedAt?: string;
  lastSyncFiles?: number;
  lastSyncTB?: string;
  appDataDir?: string;
}

// Resolve the self-contained agent bundle (one CJS file, all deps inlined). In a
// packaged build it's unpacked under resources/agent; in dev it's the monorepo dist.
function agentEntry(): string {
  const packaged = path.join(process.resourcesPath || "", "agent", "agent-bundle.cjs");
  if (app.isPackaged && fs.existsSync(packaged)) return packaged;
  // Dev: apps/desktop/dist/main.js -> repo root -> apps/agent/dist/agent-bundle.cjs
  return path.resolve(__dirname, "..", "..", "agent", "dist", "agent-bundle.cjs");
}

function nodeBin(): string {
  // In a packaged Electron app, the Electron binary can run Node scripts when
  // ELECTRON_RUN_AS_NODE=1. In dev, use the current Node executable.
  return process.execPath;
}

function runAgent(args: string[], timeoutMs = 0): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      nodeBin(),
      [agentEntry(), ...args],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        timeout: timeoutMs || undefined,
        maxBuffer: 1024 * 1024 * 16,
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
        // The agent exits 0 on most paths; treat non-zero as soft failure with output.
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), code });
      }
    );
  });
}

export async function getStatus(): Promise<AgentStatus> {
  const { stdout } = await runAgent(["status", "--json"], 15000);
  const line = stdout.trim().split("\n").filter(Boolean).pop() || "{}";
  try {
    return JSON.parse(line) as AgentStatus;
  } catch {
    return { connected: false, paused: false, scanRoots: [] };
  }
}

export async function connect(opts: {
  token: string;
  machine: string;
  convexUrl?: string;
  owner?: string;
}): Promise<{ ok: boolean; message: string }> {
  const args = ["connect", "--token", opts.token, "--machine", opts.machine];
  if (opts.convexUrl) args.push("--convex", opts.convexUrl);
  if (opts.owner) args.push("--owner", opts.owner);
  const { stdout, stderr, code } = await runAgent(args, 30000);
  const out = (stdout + stderr).trim();
  const ok = code === 0 && /\[Connect\] Connected/i.test(out);
  return { ok, message: out.split("\n").filter(Boolean).slice(-2).join(" ") || "Connect finished." };
}

export async function scanNow(): Promise<{ ok: boolean; message: string }> {
  // Cap the scan so the "Scanning…" button always clears. Previously this ran
  // with no timeout (0), so a hung upload left the button spinning forever. Two
  // hours is well beyond a real large-drive scan; past that it's stuck, not slow.
  // (The agent's own per-request fetch timeout normally prevents reaching this.)
  const { stdout, stderr } = await runAgent(["scan-now"], 2 * 60 * 60 * 1000);
  const out = (stdout + stderr).trim();
  const ok = /Sync Cycle Complete|Scan Complete/i.test(out);
  const summary = out.split("\n").filter((l) => /Cycle Complete|paused|Unauthorized|unavailable|already running/i.test(l)).pop();
  return { ok, message: summary || "Scan finished." };
}

export async function pause(): Promise<void> {
  await runAgent(["pause"], 15000);
}

export async function resume(): Promise<void> {
  await runAgent(["resume"], 15000);
}

export async function addDrive(opts: { path: string; name?: string; allowCloud?: boolean }): Promise<{ ok: boolean; message: string }> {
  const args = ["install-drive", "--path", opts.path];
  if (opts.name) args.push("--name", opts.name);
  if (opts.allowCloud) args.push("--allow-cloud-root");
  const { stdout, stderr, code } = await runAgent(args, 30000);
  const out = (stdout + stderr).trim();
  return { ok: code === 0 && /\[Success\]/i.test(out), message: out.split("\n").filter(Boolean).slice(-1)[0] || "Done." };
}

export async function removeDrive(opts: { path: string }): Promise<{ ok: boolean; message: string }> {
  const { stdout, stderr, code } = await runAgent(["forget-drive", "--path", opts.path], 30000);
  const out = (stdout + stderr).trim();
  return { ok: code === 0 && /\[Success\]/i.test(out), message: out.split("\n").filter(Boolean).slice(-1)[0] || "Done." };
}

// Long-running scheduler. Returns the child so the caller can stop it on quit.
export function startSyncDaemon(onLog: (line: string) => void) {
  const child = spawn(nodeBin(), [agentEntry(), "sync", "--interval-minutes", "60"], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.stdout.on("data", (d) => onLog(d.toString()));
  child.stderr.on("data", (d) => onLog(d.toString()));
  return child;
}
