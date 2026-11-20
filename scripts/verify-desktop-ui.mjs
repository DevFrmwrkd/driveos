// This launches a GUI only on a disposable GitHub Actions runner. Never use it
// as a fallback for a locally blocked desktop launch.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function inside(directory, filename) {
  const relative = path.relative(path.resolve(directory), path.resolve(filename));
  return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
async function cdp(url) {
  const parsed = new URL(url);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname));
  const socket = new WebSocket(url), pending = new Map();
  let sequence = 0;
  socket.addEventListener("message", event => {
    const value = JSON.parse(String(event.data)), callback = pending.get(value.id);
    if (callback) { pending.delete(value.id); value.error ? callback.reject(new Error(value.error.message)) : callback.resolve(value.result); }
  });
  socket.addEventListener("close", () => {
    for (const callback of pending.values()) callback.reject(new Error("Desktop debugging connection closed."));
    pending.clear();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Desktop debugging connection timed out.")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Desktop debugging connection failed.")); }, { once: true });
  });
  return {
    close: () => socket.close(),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Desktop protocol timed out: ${method}`)); }, 15_000);
        pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

export async function verifyDesktopUi({ executable, fixture, home, env, release, platform, version }) {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Desktop GUI smoke runs only on disposable GitHub Actions runners.");
  assert.ok(process.env.RUNNER_TEMP, "An isolated runner temporary directory is required.");
  assert.ok(inside(process.env.RUNNER_TEMP, fixture));
  assert.ok(inside(fixture, executable) && inside(fixture, home));
  assert.ok(["win32", "darwin"].includes(process.platform));
  const profile = path.join(fixture, "electron-profile"), evidence = path.join(fixture, "ui-evidence");
  fs.mkdirSync(profile); fs.mkdirSync(evidence);
  const guiEnv = { ...env, DRIVEOS_AGENT_HOME: home, DRIVEOS_CONVEX_URL: "http://127.0.0.1:9" };
  delete guiEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ["--user-data-dir=" + profile, "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check"], {
    cwd: fixture, env: guiEnv, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
  });
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
  let output = "", childError, exited = false, page, browser;
  const exit = new Promise(resolve => child.once("exit", () => { exited = true; resolve(); }));
  child.on("error", error => { childError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + chunk.toString()).slice(-64_000); });
  try {
    const started = Date.now();
    let base, versionInfo, target;
    while (Date.now() - started < 45_000) {
      if (childError) throw childError;
      assert.equal(exited, false, `Packaged desktop exited during startup: ${output}`);
      let port;
      try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]); } catch { /* Wait for Chromium. */ }
      port ||= Number(output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        base = `http://127.0.0.1:${port}`;
        try {
          versionInfo = await (await fetch(base + "/json/version", { signal: AbortSignal.timeout(2_000) })).json();
          const targets = await (await fetch(base + "/json/list", { signal: AbortSignal.timeout(2_000) })).json();
          target = targets.find(candidate => candidate.type === "page" && candidate.url.startsWith("file:") && candidate.url.includes("renderer/index.html"));
          if (target) break;
        } catch { /* Chromium is still starting. */ }
      }
      await delay(100);
    }
    assert.ok(target?.webSocketDebuggerUrl, `Packaged renderer did not become available: ${output}`);
    page = await cdp(target.webSocketDebuggerUrl);
    browser = await cdp(versionInfo.webSocketDebuggerUrl);
    await page.send("Page.enable");
    await page.send("Network.enable");
    await page.send("Network.setBlockedURLs", { urls: ["http://*", "https://*"] });
    async function evaluate(expression) {
      const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      ready = await evaluate("document.readyState === 'complete' && !!window.driveos?.status && !!document.getElementById('connect-btn')");
      if (ready) break;
      await delay(100);
    }
    assert.equal(ready, true, "Actual renderer and isolated preload bridge must load.");
    const status = await evaluate("window.driveos.status()");
    assert.equal(status.connected, false);
    assert.equal(path.resolve(status.appDataDir), path.resolve(home));
    assert.equal(status.convexUrl, "http://127.0.0.1:9");
    const message = await evaluate(`(() => {
      document.getElementById('machine').value = '';
      document.getElementById('token').value = '';
      document.getElementById('connect-btn').click();
      return document.getElementById('connect-msg').textContent;
    })()`);
    assert.equal(message, "Enter both a machine name and a token.");
    assert.equal(await evaluate("window.driveos.pause().then(() => window.driveos.status()).then(s => s.paused)"), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "driveos-agent-state.json"), "utf8")).paused, true);
    assert.equal(await evaluate("window.driveos.resume().then(() => window.driveos.status()).then(s => s.paused)"), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "driveos-agent-state.json"), "utf8")).paused, false);
    const screenshot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const png = path.join(evidence, `DriveOS-Agent-${platform}-ui-smoke.png`);
    fs.writeFileSync(png, Buffer.from(screenshot.data, "base64"));
    fs.writeFileSync(path.join(evidence, "ui-smoke.json"), JSON.stringify({ version, platform, passed: [
      "actual packaged renderer and preload", "private disconnected profile", "empty Connect form validation",
      "pause IPC and persisted agent state", "resume IPC and persisted agent state", "renderer screenshot",
    ] }, null, 2));
    const archive = path.join(release, `DriveOS-Agent-${platform}-ui-smoke.zip`);
    if (process.platform === "darwin") execFileSync("ditto", ["-c", "-k", "--keepParent", evidence, archive]);
    else execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Compress-Archive -LiteralPath $env:DRIVEOS_UI_EVIDENCE -DestinationPath $env:DRIVEOS_UI_ARCHIVE -Force"],
      { env: { ...process.env, DRIVEOS_UI_EVIDENCE: evidence, DRIVEOS_UI_ARCHIVE: archive }, windowsHide: true });
    console.log(`Packaged desktop GUI smoke passed; screenshot/report artifact: ${path.basename(archive)}`);
  } finally {
    if (browser) { try { await browser.send("Browser.close"); } catch { /* The browser may close the socket before replying. */ } }
    if (!exited) await Promise.race([exit, delay(3_000)]);
    if (!exited) {
      if (process.platform === "win32") execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      else { try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
      await Promise.race([exit, delay(5_000)]);
      assert.equal(exited, true, "Owned desktop process must exit before fixture cleanup.");
    }
    page?.close(); browser?.close();
  }
}
