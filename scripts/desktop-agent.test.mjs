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
    ["[Scan Complete] root — errors: 0\n[Sync Cycle Complete] 1 file(s) — 1 uploaded\n[Analysis Queued] Automatic analysis will run after scanning.", null, true],
    ["[Scan Complete] root — errors: 1\n[Sync Cycle Partial] 1 file(s) — errors: 1", { code: 1 }, false],
    ["[Scan Complete] root — errors: 0\n[Sync Cycle Partial] Upload budget exhausted; errors: 0", { code: 1 }, false],
    ["[Sync Cycle Complete] old cycle\n[Sync Cycle Partial] final cycle", null, false],
    ["[Scan Complete] root — errors: 0", null, false],
  ]) {
    const { agent, calls } = bridge({ stdout, error });
    const result = await agent.scanNow();
    assert.equal(result.ok, ok, stdout);
    if (stdout.includes("[Sync Cycle Partial]")) assert.match(result.message, /^\[Sync Cycle Partial\]/);
    if (ok) {
      assert.match(result.message, /^\[Sync Cycle Complete\]/);
      assert.match(result.message, /\[Analysis Queued\]/);
      assert.doesNotMatch(result.message, /Analysis complete/i);
    }
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
    const { agent } = bridge({ stdout: "[Scan Complete] one root — errors: 0\n[Sync Cycle Complete] all roots\n[Analysis Queued] Waiting for the worker.", error });
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

function renderer(scanNow, status = async () => ({ connected: true, paused: false, machineName: "synthetic", scanRoots: [] })) {
  const html = fs.readFileSync(path.join(desktop, "renderer/index.html"), "utf8");
  const elements = new Map([...html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)].map(([tag, id]) => {
    const classes = new Set((tag.match(/\bclass="([^"]*)"/)?.[1] || "").split(/\s+/).filter(Boolean));
    return [id, {
      textContent: "", className: [...classes].join(" "), disabled: false, style: {}, value: "", handlers: {},
      classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } },
      appendChild() {}, addEventListener(name, handler) { this.handlers[name] = handler; },
    }];
  }));
  const intervals = [];
  const api = {
    scanNow, status,
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
  assert.equal(ui.elements.get("scan-msg").textContent, "Scanning files. Analysis will be queued after the scan succeeds.");
  await Promise.resolve();
  assert.equal(ui.elements.get("scan-btn").disabled, true);
  const message = "[Sync Cycle Partial] 1 root failed; 0 uploaded.";
  finish({ ok: false, message });
  await pending;
  assert.equal(ui.elements.get("scan-btn").disabled, false);
  assert.equal(ui.elements.get("scan-btn").textContent, "Scan & Analyze");
  assert.equal(ui.elements.get("scan-msg").textContent, message);
  assert.equal(ui.elements.get("scan-msg").className, "msg err");
});

test("scan IPC rejection is visible and always resets the button", async () => {
  const ui = renderer(async () => { throw new Error("The agent IPC connection closed."); });
  await ui.click();
  assert.equal(ui.elements.get("scan-btn").disabled, false);
  assert.equal(ui.elements.get("scan-btn").textContent, "Scan & Analyze");
  assert.match(ui.elements.get("scan-msg").textContent, /failed.*IPC connection closed/i);
  assert.equal(ui.elements.get("scan-msg").className, "msg err");
});

test("scan errors stay visible through a status IPC outage and periodic retries, then status recovers", async () => {
  let unavailable = false, machineName = "initial";
  const ui = renderer(async () => { unavailable = true; throw new Error("IPC connection closed."); }, async () => {
    if (unavailable) throw new Error("Status IPC connection closed.");
    return { connected: true, paused: false, machineName, scanRoots: [] };
  });
  await new Promise(setImmediate); // Finish the actual renderer's initial refresh.
  assert.equal(ui.elements.get("status-view").classList.contains("hidden"), false);
  assert.equal(ui.elements.get("s-machine").textContent, "initial");
  await ui.click();
  const message = ui.elements.get("scan-msg").textContent;
  assert.match(message, /Scan & Analyze failed.*IPC connection closed/i);
  assert.equal(ui.elements.get("scan-btn").disabled, false);
  assert.equal(ui.elements.get("status-view").classList.contains("hidden"), false);
  assert.equal(ui.elements.get("connect-view").classList.contains("hidden"), true);
  assert.equal(ui.intervals.length, 1);
  await ui.intervals[0]();
  assert.equal(ui.elements.get("status-view").classList.contains("hidden"), false);
  assert.equal(ui.elements.get("scan-msg").textContent, message);
  unavailable = false; machineName = "recovered";
  await ui.intervals[0]();
  assert.equal(ui.elements.get("s-machine").textContent, "recovered");
  assert.equal(ui.elements.get("status-view").classList.contains("hidden"), false);
});

test("an unavailable initial status preserves the disconnected HTML view", async () => {
  const ui = renderer(async () => ({ ok: true, message: "unused" }), async () => { throw new Error("Status IPC unavailable."); });
  await new Promise(setImmediate);
  assert.equal(ui.elements.get("status-view").classList.contains("hidden"), true);
  assert.equal(ui.elements.get("connect-view").classList.contains("hidden"), false);
});

test("successful scans display the completion message and clear the pending state", async () => {
  const message = "[Sync Cycle Complete] 1 file uploaded.\n[Analysis Queued] Waiting for the worker.";
  const ui = renderer(async () => ({ ok: true, message }));
  await ui.click();
  assert.equal(ui.elements.get("scan-btn").disabled, false);
  assert.equal(ui.elements.get("scan-msg").className, "msg ok");
  assert.equal(ui.elements.get("scan-msg").textContent, message);
  assert.doesNotMatch(ui.elements.get("scan-msg").textContent, /Analysis complete/i);
});

test("desktop Scan & Analyze requires analysis acknowledgment after a complete scan", async () => {
  const { agent } = bridge({ stdout: "[Sync Cycle Complete] All files scanned." });
  const result = await agent.scanNow();
  assert.equal(result.ok, false);
  assert.match(result.message, /Scan completed.*analysis was not confirmed/);
});

test("desktop Scan & Analyze reports analysis failure and never hides a partial scan", async () => {
  for (const code of [0, 1]) {
    const { agent } = bridge({ stdout: "[Sync Cycle Complete] All files scanned.",
      stderr: "[Analysis Failed] Backend is unavailable; retry Scan & Analyze.", error: code ? { code } : null });
    const result = await agent.scanNow();
    assert.equal(result.ok, false);
    assert.match(result.message, /^\[Analysis Failed\]/);
  }
  const { agent } = bridge({ stdout: "[Sync Cycle Partial] One root failed.\n[Analysis Queued] Worker pending." });
  const result = await agent.scanNow();
  assert.equal(result.ok, false);
  assert.match(result.message, /^\[Sync Cycle Partial\]/);
});
