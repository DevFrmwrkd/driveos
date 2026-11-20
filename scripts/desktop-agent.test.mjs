import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The override lets the same regressions prove an older source tree fails.
const desktop = process.env.DRIVEOS_TEST_DESKTOP_SOURCE_ROOT || fileURLToPath(new URL("../apps/desktop", import.meta.url));

function bridge(reply) {
  const calls = [];
  const filename = path.join(desktop, "src/agentBridge.ts");
  const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const context = vm.createContext({
    exports, process, __dirname: path.dirname(filename),
    require(name) {
      if (name === "electron") return { app: { isPackaged: false } };
      if (name === "path") return path;
      if (name === "fs") return fs;
      if (name === "child_process") return {
        execFile(binary, args, options, callback) {
          calls.push({ binary, args, options });
          callback(reply.error || null, reply.stdout || "", reply.stderr || "");
        },
        spawn() { throw new Error("These one-shot bridge tests must not start a daemon."); },
      };
      throw new Error(`Unexpected desktop dependency: ${name}`);
    },
  });
  vm.runInContext(javascript, context, { filename });
  return { agent: exports, calls };
}

test("desktop scan accepts only a successful final cycle, not an individual root", async () => {
  for (const [stdout, error, ok] of [
    ["[Scan Complete] root — errors: 0\n[Sync Cycle Complete] 1 file(s) — 1 uploaded", null, true],
    ["[Scan Complete] root — errors: 1\n[Sync Cycle Partial] 1 file(s) — errors: 1", { code: 1 }, false],
    ["[Scan Complete] root — errors: 0\n[Sync Cycle Partial] Upload budget exhausted; errors: 0", { code: 1 }, false],
    ["[Sync Cycle Complete] old cycle\n[Sync Cycle Partial] final cycle", null, false],
    ["[Scan Complete] root — errors: 0", null, false],
  ]) {
    const { agent, calls } = bridge({ stdout, error });
    const result = await agent.scanNow();
    assert.equal(result.ok, ok, stdout);
    if (stdout.includes("[Sync Cycle Partial]")) assert.match(result.message, /^\[Sync Cycle Partial\]/);
    if (ok) assert.match(result.message, /^\[Sync Cycle Complete\]/);
    assert.equal(calls[0].args.at(-1), "scan-now");
    assert.equal(calls[0].options.timeout, 2 * 60 * 60 * 1000);
  }
});

for (const [reason, error] of [
  ["nonzero exit", { code: 1 }],
  ["forced termination", { killed: true, signal: "SIGTERM" }],
  ["output limit", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }],
]) {
  test(`desktop scan rejects ${reason} even after completion output`, async () => {
    const { agent } = bridge({ stdout: "[Scan Complete] one root — errors: 0\n[Sync Cycle Complete] all roots", error });
    const result = await agent.scanNow();
    assert.equal(result.ok, false);
    assert.match(result.message, /failed|interrupted/i);
    assert.doesNotMatch(result.message, /Cycle Complete/);
  });
}

test("desktop scan preserves partial results and useful failure or no-op reasons", async () => {
  for (const line of [
    "[Sync] Agent is paused — skipping this cycle.",
    "[Sync] No folders are being tracked yet. Add a drive or folder to start scanning.",
    "[Sync] Another scan is already running — skipping this cycle to avoid duplicate work.",
    "[Sync] Scan of root failed: Backend returned a redirect (HTTP 307).",
  ]) {
    const { agent } = bridge({ stdout: line.includes("failed") ? "[Scan Complete] first root — errors: 0" : line,
      stderr: line.includes("failed") ? line : "", error: line.includes("failed") ? { code: 1 } : undefined });
    const result = await agent.scanNow();
    assert.equal(result.ok, false);
    assert.equal(result.message, line);
  }
});

test("desktop connect gives the CLI deadline room to finish and rejects killed children", async () => {
  for (const error of [null, { killed: true, signal: "SIGTERM" }]) {
    const { agent, calls } = bridge({ stdout: '[Connect] Connected as "synthetic".', error });
    const result = await agent.connect({ token: "synthetic-token", machine: "synthetic", convexUrl: "http://127.0.0.1:9" });
    assert.equal(calls[0].options.timeout, 35_000);
    assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(result.ok, error === null);
  }
});

function renderer(scanNow) {
  const html = fs.readFileSync(path.join(desktop, "renderer/index.html"), "utf8");
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    textContent: "", className: "", disabled: false, style: {}, value: "", handlers: {},
    classList: { toggle() {} }, appendChild() {},
    addEventListener(name, handler) { this.handlers[name] = handler; },
  }]));
  const intervals = [];
  const api = {
    scanNow, status: async () => ({ connected: true, paused: false, machineName: "synthetic", scanRoots: [] }),
    getAutoLaunch: async () => false, logs: async () => [], onLog() {},
  };
  const context = vm.createContext({
    window: { driveos: api },
    document: { getElementById: id => elements.get(id), createElement: () => ({ appendChild() {} }) },
    setTimeout() { throw new Error("A scan result must not schedule an independent button reset."); },
    setInterval(callback) { intervals.push(callback); },
  });
  vm.runInContext(fs.readFileSync(path.join(desktop, "renderer/renderer.js"), "utf8"), context);
  return { html, elements, intervals, click: () => elements.get("scan-btn").handlers.click() };
}

test("scan result is live, remains pending until completion, and displays partial failure", async () => {
  let finish;
  const ui = renderer(() => new Promise(resolve => { finish = resolve; }));
  assert.match(ui.html, /id="scan-msg"[^>]*aria-live="polite"/);
  const pending = ui.click();
  assert.equal(ui.elements.get("scan-btn").disabled, true);
  assert.equal(ui.elements.get("scan-btn").textContent, "Scanning…");
  assert.equal(ui.elements.get("scan-msg").textContent, "Scanning…");
  await Promise.resolve();
  assert.equal(ui.elements.get("scan-btn").disabled, true);
  const message = "[Sync Cycle Partial] 1 root failed; 0 uploaded.";
  finish({ ok: false, message });
  await pending;
  assert.equal(ui.elements.get("scan-btn").disabled, false);
  assert.equal(ui.elements.get("scan-btn").textContent, "Scan Now");
  assert.equal(ui.elements.get("scan-msg").textContent, message);
  assert.equal(ui.elements.get("scan-msg").className, "msg err");
});

test("scan IPC rejection is visible and always resets the button", async () => {
  const ui = renderer(async () => { throw new Error("The agent IPC connection closed."); });
  await ui.click();
  assert.equal(ui.elements.get("scan-btn").disabled, false);
  assert.equal(ui.elements.get("scan-btn").textContent, "Scan Now");
  assert.match(ui.elements.get("scan-msg").textContent, /failed.*IPC connection closed/i);
  assert.equal(ui.elements.get("scan-msg").className, "msg err");
});

test("successful scans display the completion message and clear the pending state", async () => {
  const ui = renderer(async () => ({ ok: true, message: "[Sync Cycle Complete] 1 file uploaded." }));
  await ui.click();
  assert.equal(ui.elements.get("scan-btn").disabled, false);
  assert.equal(ui.elements.get("scan-msg").className, "msg ok");
  assert.equal(ui.elements.get("scan-msg").textContent, "[Sync Cycle Complete] 1 file uploaded.");
});
