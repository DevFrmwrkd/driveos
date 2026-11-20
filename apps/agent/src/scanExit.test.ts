import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProcessLock } from "./scanLock.js";

test("real one-shot CLI commands exit naturally and reject unfinished redirect responses", { timeout: 120_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveos-scan-exit-"));
  const media = path.join(root, "media", "06_RENDERS_CACHE");
  const filename = path.join(media, "preview.dat");
  fs.mkdirSync(media, { recursive: true });
  // One shared 1 MiB file keeps all subprocess scenarios below 3 MiB on disk.
  fs.writeFileSync(filename, Buffer.alloc(1024 * 1024, 65));
  const stable = new Date(Date.now() - 120_000); fs.utimesSync(filename, stable, stable);
  const fullHash = crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
  const token = "synthetic-loopback-scan-exit-token";
  const children = new Set<ChildProcess>();
  const catalogs = new Map<string, Map<string, any>>();
  const driveIds = new Map<string, string>();
  const completed: { driveId: string; status: string }[] = [];
  const sessions = new Map<string, string>();
  const failures: string[] = [];
  let sessionSequence = 0;
  let redirectEndpoint: string | undefined;
  let connectReplyStatus: number | undefined;
  let failureEndpoint: string | undefined;
  let failureStatus = 500;
  let queuedScanJob: any;
  const jobReports: any[] = [];
  let targets = 0;
  let uploads = 0;
  const entry = process.env.DRIVEOS_TEST_AGENT_ENTRY || fileURLToPath(new URL("./index.js", import.meta.url));
  assert.ok(path.isAbsolute(entry), "The selected CLI or packaged agent entry must be absolute.");
  assert.ok(fs.statSync(entry).isFile());

  const server = http.createServer(async (request, response) => {
    response.on("error", () => { /* The rejected redirect intentionally closes this response. */ });
    const json = (status: number, body: unknown) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const endpoint = request.url || "";
      if (request.headers.authorization !== `Bearer ${token}`) return json(401, { error: "Invalid synthetic fixture token" });
      if (endpoint.startsWith("/final/")) {
        targets++;
        // Default fetch follows this response and reports scan success while
        // the unfinished intermediate body keeps referenced sockets alive.
        return json(200, { success: true, machineId: "redirected-machine", receipts: [] });
      }
      if (endpoint === redirectEndpoint) {
        response.writeHead(307, { Location: `/final/${endpoint.slice(1)}`, "Content-Type": "application/json", "Content-Length": "100000000" });
        response.write(Buffer.alloc(65536, 65));
        return; // Intentionally never end the intermediate redirect body.
      }
      if (endpoint === failureEndpoint) {
        if (failureStatus === 429) response.setHeader("Retry-After", "1");
        return json(failureStatus, { error: `Synthetic HTTP ${failureStatus} failure` });
      }
      if (endpoint === "/api/registerMachine" && connectReplyStatus !== undefined) {
        response.writeHead(connectReplyStatus, { "Content-Type": "application/json", "Content-Length": "100000000" });
        response.write(Buffer.alloc(65536, 65));
        return; // Connect needs the status, not an unused never-ending body.
      }
      if (endpoint === "/api/registerMachine") return json(200, { success: true, machineId: `machine-${payload.name}` });
      if (endpoint === "/api/registerDrive") {
        const scope = `${payload.machineId}|${payload.volumeId}`;
        let driveId = driveIds.get(scope);
        if (!driveId) {
          const count = [...driveIds.keys()].filter(key => key.startsWith(`${payload.machineId}|`)).length;
          driveId = `drive-${payload.machineId}${count ? `-root-${count + 1}` : ""}`;
          driveIds.set(scope, driveId);
        }
        if (!catalogs.has(driveId)) catalogs.set(driveId, new Map());
        const hasCatalog = catalogs.get(driveId)!.size > 0;
        return json(200, { success: true, driveId, isNew: !hasCatalog, hasCatalog });
      }
      if (endpoint === "/api/startScan") {
        const sessionId = `scan-${++sessionSequence}`; sessions.set(sessionId, payload.driveId);
        return json(200, { success: true, sessionId });
      }
      if (endpoint === "/api/uploadBatch") {
        uploads++;
        const catalog = catalogs.get(payload.driveId)!;
        const receipts = payload.files.map((file: any) => {
          const previous = catalog.get(file.path);
          const stored = { ...previous, ...file, fileId: previous?.fileId || `file-${payload.driveId}-${catalog.size + 1}`, catalogVersion: (previous?.catalogVersion || 0) + 1,
            driveId: payload.driveId, machineId: payload.machineId };
          catalog.set(file.path, stored);
          return { path: stored.path, fileId: stored.fileId, catalogVersion: stored.catalogVersion,
            driveId: stored.driveId, machineId: stored.machineId, sizeBytes: stored.sizeBytes, modifiedAtFile: stored.modifiedAtFile,
            ...(stored.quickHash ? { quickHash: stored.quickHash } : {}), ...(stored.fullHash ? { fullHash: stored.fullHash } : {}) };
        });
        return json(200, { success: true, receipts });
      }
      if (endpoint === "/api/completeScan") {
        completed.push({ driveId: sessions.get(payload.sessionId)!, status: payload.status });
        return json(200, { success: true });
      }
      if (endpoint === "/api/pollPendingJobs") return json(200, queuedScanJob && ["approved", "queued", "running"].includes(queuedScanJob.status) ? [queuedScanJob] : []);
      if (endpoint === "/api/updateJobStatus") {
        if (!queuedScanJob || payload.jobId !== queuedScanJob._id || typeof payload.claimToken !== "string")
          return json(200, { claimed: false, reason: "Unknown synthetic job" });
        if (payload.status === "running") {
          if (queuedScanJob.status === "approved") { queuedScanJob.status = "running"; queuedScanJob.claimToken = payload.claimToken; }
          else if (queuedScanJob.status !== "running" || queuedScanJob.claimToken !== payload.claimToken)
            return json(200, { claimed: false, reason: "Synthetic lease mismatch" });
        } else {
          if (queuedScanJob.status !== "running" || queuedScanJob.claimToken !== payload.claimToken)
            return json(200, { claimed: false, reason: "Synthetic lease mismatch" });
          jobReports.push(payload); queuedScanJob.status = payload.status; queuedScanJob.result = payload.result;
        }
        return json(200, { claimed: true, leaseExpiresAt: Date.now() + 120_000 });
      }
      failures.push(`Unexpected fixture endpoint ${endpoint}`);
      return json(404, { error: "Unexpected fixture endpoint" });
    } catch (error) {
      failures.push(String(error));
      if (!response.headersSent) json(500, { error: "Synthetic fixture failed" });
      else response.destroy();
    }
  });
  server.keepAliveTimeout = 30_000;
  t.after(async () => {
    await Promise.all([...children].map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("close", () => resolve()); child.kill();
    })));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  async function agent(home: string, args: string[]) {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, windowsHide: true,
      env: { ...process.env, DRIVEOS_AGENT_HOME: home, DRIVEOS_CONVEX_URL: baseUrl }, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let output = "", timedOut = false;
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
    try {
      const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(timedOut, false, `CLI did not exit naturally:\n${output}`);
      assert.equal(outcome.signal, null, output);
      return { ...outcome, output };
    } finally { clearTimeout(timer); children.delete(child); }
  }
  async function initialize(name: string) {
    const home = path.join(root, `home-${name}`);
    const result = await agent(home, ["init", "--machine", name, "--owner", "scan-exit@driveos.test", "--convex", baseUrl,
      "--auth-token", token, "--roots", path.dirname(media), "--central-quarantine", "--quarantine", path.join(root, `quarantine-${name}`)]);
    assert.equal(result.code, 0, result.output);
    return home;
  }
  const assertUnlocked = (home: string) => assert.equal(fs.existsSync(path.join(home, "driveos-scan.lock")), false, "A finished one-shot scan must release its process lock.");
  const assertMetadata = (name: string) => {
    const catalog = catalogs.get(`drive-machine-${name}`)!;
    assert.equal(catalog.size, 1);
    assert.equal(catalog.get(filename).sizeBytes, 1024 * 1024);
    assert.equal(catalog.get(filename).fullHash, fullHash);
    assert.equal(catalog.get(filename).path, filename);
  };
  const statePath = (home: string) => path.join(home, "driveos-agent-state.json");
  const readState = (home: string) => JSON.parse(fs.readFileSync(statePath(home), "utf8"));
  const lastSuccess = "2001-02-03T04:05:06.000Z";
  const lastSuccessFiles = 37, lastSuccessBytes = 9_876_543_210;
  const seedLastSuccess = (home: string) => fs.writeFileSync(statePath(home), JSON.stringify({ paused: false,
    lastSyncCompletedAt: lastSuccess, lastSyncFiles: lastSuccessFiles, lastSyncBytes: lastSuccessBytes }));
  const assertLastSuccess = (home: string) => {
    const state = readState(home);
    assert.equal(state.lastSyncCompletedAt, lastSuccess, "Incomplete attempts preserve the last successful timestamp.");
    assert.equal(state.lastSyncFiles, lastSuccessFiles, "Counts must describe that same successful attempt.");
    assert.equal(state.lastSyncBytes, lastSuccessBytes, "Bytes must describe that same successful attempt.");
  };
  const commands = [
    { name: "scan", args: ["scan", "--path", path.dirname(media), "--full-hash"], cycle: false },
    { name: "scan-now", args: ["scan-now", "--full-hash"], cycle: true },
    { name: "sync-once", args: ["sync", "--once", "--full-hash"], cycle: true },
  ];
  const assertNotOverallComplete = (output: string) => assert.doesNotMatch(output, /\[Sync Cycle Complete\]/);
  const assertUnstamped = (home: string) => {
    const cache = JSON.parse(fs.readFileSync(path.join(home, "driveos-hash-cache.json"), "utf8"));
    assert.ok(Object.keys(cache).length > 0);
    for (const entry of Object.values(cache) as any[]) { assert.equal(entry.uploadedFp, undefined); assert.equal(entry.catalogReceipt, undefined); }
  };

  await t.test("normal full-hash, unchanged, forced and scheduled-once scans exit with metadata intact", async () => {
    const home = await initialize("normal");
    const first = await agent(home, ["scan", "--path", path.dirname(media), "--full-hash"]);
    assert.equal(first.code, 0, first.output); assert.match(first.output, /1 uploaded/); assertUnlocked(home); assertMetadata("normal");
    const count = uploads;
    const unchanged = await agent(home, ["scan", "--path", path.dirname(media)]);
    assert.equal(unchanged.code, 0, unchanged.output); assert.match(unchanged.output, /0 uploaded, 1 unchanged/); assert.equal(uploads, count); assertUnlocked(home);
    const forced = await agent(home, ["scan", "--path", path.dirname(media), "--force-full"]);
    assert.equal(forced.code, 0, forced.output); assert.equal(uploads, count + 1); assertUnlocked(home); assertMetadata("normal");
    for (const args of [["scan-now"], ["sync", "--once"]]) {
      const once = await agent(home, args);
      assert.equal(once.code, 0, once.output); assert.match(once.output, /Sync Cycle Complete/); assertUnlocked(home); assertMetadata("normal");
    }
  });

  await t.test("completeScan redirect exits unsuccessfully without following or inventing scan completion, then releases its lock", async () => {
    const home = await initialize("complete-redirect");
    const targetCount = targets;
    redirectEndpoint = "/api/completeScan";
    let rejected;
    try { rejected = await agent(home, ["scan", "--path", path.dirname(media), "--full-hash"]); }
    finally { redirectEndpoint = undefined; }
    assert.equal(rejected.code, 1, rejected.output);
    assert.match(rejected.output, /redirect|HTTP.{0,10}307/i);
    assert.doesNotMatch(rejected.output, /\[Scan Complete\]/);
    assert.equal(targets, targetCount);
    assertUnlocked(home); assertMetadata("complete-redirect");
    const retry = await agent(home, ["scan", "--path", path.dirname(media)]);
    assert.equal(retry.code, 0, retry.output); assert.match(retry.output, /\[Scan Complete\]/); assertUnlocked(home);
  });

  await t.test("upload redirect cannot stamp an unacknowledged batch in the cache", async () => {
    const home = await initialize("upload-redirect"), targetCount = targets;
    redirectEndpoint = "/api/uploadBatch";
    let rejected;
    try { rejected = await agent(home, ["scan", "--path", path.dirname(media), "--full-hash"]); }
    finally { redirectEndpoint = undefined; }
    assert.equal(rejected.code, 1, rejected.output);
    assert.match(rejected.output, /redirect|HTTP.{0,10}307/i);
    assert.doesNotMatch(rejected.output, /\[Scan Complete\]/);
    assert.equal(targets, targetCount); assertUnlocked(home);
    assert.equal(catalogs.get("drive-machine-upload-redirect")!.size, 0);
    const cache = JSON.parse(fs.readFileSync(path.join(home, "driveos-hash-cache.json"), "utf8"));
    assert.ok(Object.values(cache).length > 0);
    for (const value of Object.values(cache) as any[]) { assert.equal(value.uploadedFp, undefined); assert.equal(value.catalogReceipt, undefined); }
    assert.ok(completed.some(scan => scan.driveId === "drive-machine-upload-redirect" && scan.status === "partial"));
    const retry = await agent(home, ["scan", "--path", path.dirname(media), "--full-hash"]);
    assert.equal(retry.code, 0, retry.output); assert.match(retry.output, /1 uploaded/); assertMetadata("upload-redirect"); assertUnlocked(home);
  });

  for (const status of [500, 307, 429]) {
    for (const command of commands) {
      await t.test(`${command.name} reports rejected HTTP ${status} uploads as partial and retries without losing metadata`, async () => {
        const name = `${command.name}-upload-${status}`, home = await initialize(name);
        seedLastSuccess(home);
        const targetCount = targets;
        if (status === 307) redirectEndpoint = "/api/uploadBatch";
        else { failureEndpoint = "/api/uploadBatch"; failureStatus = status; }
        let rejected;
        try { rejected = await agent(home, command.args); }
        finally { redirectEndpoint = undefined; failureEndpoint = undefined; }
        assert.equal(rejected.code, 1, rejected.output);
        assert.match(rejected.output, /\[Scan Partial\]/);
        assertNotOverallComplete(rejected.output);
        if (command.cycle) assert.match(rejected.output, /\[Sync Cycle Partial\]/);
        else assert.doesNotMatch(rejected.output, /\[Scan Complete\]/);
        assert.equal(targets, targetCount);
        assert.equal(catalogs.get(`drive-machine-${name}`)!.size, 0);
        assert.ok(completed.some(scan => scan.driveId === `drive-machine-${name}` && scan.status === "partial"));
        assertUnstamped(home); assertUnlocked(home);
        if (command.cycle) {
          const state = readState(home);
          assert.equal(state.lastSyncStatus, "partial");
          assertLastSuccess(home);
          if (status === 429) assert.equal(state.lastSyncErrors, 0, "A rate-limited scan is partial even without file errors.");
          else assert.ok(state.lastSyncErrors > 0);
        }
        const retry = await agent(home, command.args);
        assert.equal(retry.code, 0, retry.output);
        assert.doesNotMatch(retry.output, /\[(?:Scan|Sync Cycle) Partial\]/);
        assert.match(retry.output, command.cycle ? /\[Sync Cycle Complete\]/ : /\[Scan Complete\]/);
        assertMetadata(name); assertUnlocked(home);
        if (command.cycle) {
          const state = readState(home);
          assert.equal(state.lastSyncStatus, "completed");
          assert.equal(state.lastSyncErrors, 0);
          assert.notEqual(state.lastSyncCompletedAt, lastSuccess);
        }
      });
    }
  }

  for (const status of [500, 307, 429]) {
    await t.test(`a modern new file rejected with HTTP ${status} on an existing catalog is uploaded on normal retry`, async () => {
      const name = `existing-catalog-${status}`, home = await initialize(name);
      const baseline = await agent(home, ["scan", "--path", path.dirname(media), "--full-hash"]);
      assert.equal(baseline.code, 0, baseline.output); assertMetadata(name);
      const cachePath = path.join(home, "driveos-hash-cache.json");
      const originalKey = `${filename}-${fs.statSync(filename).size}`;
      const original = JSON.parse(fs.readFileSync(cachePath, "utf8"))[originalKey];
      assert.ok(original.uploadedFp); assert.ok(original.catalogReceipt);
      const added = path.join(media, "new-after-baseline.dat");
      fs.writeFileSync(added, Buffer.alloc(1024 * 1024, status % 255));
      fs.utimesSync(added, stable, stable);
      const addedHash = crypto.createHash("sha256").update(fs.readFileSync(added)).digest("hex");
      const addedKey = `${added}-${fs.statSync(added).size}`;
      try {
        if (status === 307) redirectEndpoint = "/api/uploadBatch";
        else { failureEndpoint = "/api/uploadBatch"; failureStatus = status; }
        let rejected;
        try { rejected = await agent(home, ["scan", "--path", path.dirname(media), "--full-hash"]); }
        finally { redirectEndpoint = undefined; failureEndpoint = undefined; }
        assert.equal(rejected.code, 1, rejected.output);
        assert.match(rejected.output, /\[Scan Partial\]/);
        const failedCache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        assert.equal(failedCache[addedKey].uploadedFp, undefined);
        assert.equal(failedCache[addedKey].catalogReceipt, undefined);
        assert.equal(failedCache[addedKey].observationInvalidated, true, "Modern pending metadata must not be mistaken for an agent-1.0 baseline.");
        assert.equal(failedCache[originalKey].uploadedFp, original.uploadedFp);
        assert.deepEqual(failedCache[originalKey].catalogReceipt, original.catalogReceipt);
        assert.equal(catalogs.get(`drive-machine-${name}`)!.size, 1);
        assertUnlocked(home);
        const retry = await agent(home, ["scan", "--path", path.dirname(media), "--full-hash"]);
        assert.equal(retry.code, 0, retry.output);
        assert.match(retry.output, /1 uploaded, 1 unchanged, 0 baselined/);
        const catalog = catalogs.get(`drive-machine-${name}`)!;
        assert.equal(catalog.size, 2);
        assert.equal(catalog.get(added).fullHash, addedHash);
        assert.equal(catalog.get(added).sizeBytes, 1024 * 1024);
        assert.equal(catalog.get(filename).fullHash, fullHash);
        const recovered = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        assert.ok(recovered[addedKey].uploadedFp);
        assert.ok(recovered[addedKey].catalogReceipt);
        assert.equal(recovered[originalKey].uploadedFp, original.uploadedFp);
        assert.deepEqual(recovered[originalKey].catalogReceipt, original.catalogReceipt);
        assertUnlocked(home);
      } finally {
        redirectEndpoint = undefined; failureEndpoint = undefined;
        fs.unlinkSync(added);
      }
    });
  }

  for (const command of commands) {
    await t.test(`${command.name} cannot report success when registration fails before a scan session opens`, async () => {
      const home = await initialize(`${command.name}-registration-failure`);
      seedLastSuccess(home);
      failureEndpoint = "/api/registerMachine"; failureStatus = 500;
      let rejected;
      try { rejected = await agent(home, command.args); }
      finally { failureEndpoint = undefined; }
      assert.equal(rejected.code, 1, rejected.output);
      assert.doesNotMatch(rejected.output, /\[(?:Scan|Sync Cycle) Complete\]/);
      assertUnlocked(home);
      if (command.cycle) {
        assert.match(rejected.output, /\[Sync Cycle Partial\]/);
        assert.equal(readState(home).lastSyncStatus, "partial");
        assert.ok(readState(home).lastSyncErrors > 0);
        assertLastSuccess(home);
      }
      const retry = await agent(home, command.args);
      assert.equal(retry.code, 0, retry.output); assertUnlocked(home);
    });
  }

  await t.test("a healthy later root cannot mask an earlier root's partial result", async () => {
    const name = "multiple-roots", home = await initialize(name), configPath = path.join(home, "driveos-config.json");
    const extra = path.join(root, "healthy-empty-root"); fs.mkdirSync(extra);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")); config.scanRoots.push(extra);
    fs.writeFileSync(configPath, JSON.stringify(config)); seedLastSuccess(home);
    failureEndpoint = "/api/uploadBatch"; failureStatus = 500;
    let rejected;
    try { rejected = await agent(home, ["sync", "--once", "--full-hash"]); }
    finally { failureEndpoint = undefined; }
    assert.equal(rejected.code, 1, rejected.output);
    assert.match(rejected.output, /\[Scan Complete\]/, "The healthy root/pass really completed.");
    assert.match(rejected.output, /\[Sync Cycle Partial\]/); assertNotOverallComplete(rejected.output);
    assert.equal(completed.at(-1)?.status, "completed", "The final healthy root must not overwrite the aggregate partial result.");
    assert.equal(readState(home).lastSyncStatus, "partial");
    assertLastSuccess(home);
    assertUnstamped(home); assertUnlocked(home);
    const retry = await agent(home, ["sync", "--once", "--full-hash"]);
    assert.equal(retry.code, 0, retry.output); assert.match(retry.output, /\[Sync Cycle Complete\]/); assertUnlocked(home);
  });

  await t.test("paused, rootless and concurrently locked cycles remain harmless successful no-ops", async () => {
    const home = await initialize("no-ops"), configPath = path.join(home, "driveos-config.json");
    const config = fs.readFileSync(configPath, "utf8"); seedLastSuccess(home);
    await agent(home, ["pause"]);
    for (const args of [["scan-now"], ["sync", "--once"]]) {
      const result = await agent(home, args);
      assert.equal(result.code, 0, result.output); assert.doesNotMatch(result.output, /\[Sync Cycle (?:Complete|Partial)\]/);
    }
    await agent(home, ["resume"]);
    fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(config), scanRoots: [] }));
    for (const args of [["scan-now"], ["sync", "--once"]]) {
      const result = await agent(home, args);
      assert.equal(result.code, 0, result.output); assert.doesNotMatch(result.output, /\[Sync Cycle (?:Complete|Partial)\]/);
    }
    fs.writeFileSync(configPath, config);
    const lockPath = path.join(home, "driveos-scan.lock"), lock = createProcessLock(lockPath, { honorLegacyOwner: true });
    assert.equal(await lock.acquire(), true);
    try {
      for (const args of [["scan-now"], ["sync", "--once"]]) {
        const result = await agent(home, args);
        assert.equal(result.code, 0, result.output); assert.match(result.output, /already running/i);
        assert.doesNotMatch(result.output, /\[Sync Cycle (?:Complete|Partial)\]/);
        assert.equal(fs.existsSync(lockPath), true, "A skipped process must not release the active owner's lock.");
      }
    } finally { await lock.release(); }
    assertLastSuccess(home); assertUnlocked(home);
  });

  await t.test("a resident scheduler stays alive after a partial first attempt without a sticky failure exit code", async () => {
    const home = await initialize("resident-partial"); seedLastSuccess(home);
    const observation = path.join(root, "observe-daemon-exit-code.cjs");
    // Observe the real process after its async cycle returns; do not alter its
    // timers, scheduler, exit code, or production behavior.
    fs.writeFileSync(observation, `const log=console.log;console.log=(...args)=>{log(...args);if(String(args[0]).startsWith('[Sync Cycle Partial]')){setTimeout(()=>log('[Observed Daemon Exit Code] '+(process.exitCode??0)),50).unref();}};`);
    failureEndpoint = "/api/uploadBatch"; failureStatus = 500;
    const child = spawn(process.execPath, ["--require", observation, entry, "sync", "--interval-minutes", "1"], {
      cwd: root, windowsHide: true, env: { ...process.env, DRIVEOS_AGENT_HOME: home, DRIVEOS_CONVEX_URL: baseUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let output = "";
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!output.includes("[Observed Daemon Exit Code]") && Date.now() < deadline && child.exitCode === null && child.signalCode === null)
        await new Promise(resolve => setTimeout(resolve, 25));
      assert.match(output, /\[Sync Cycle Partial\]/);
      assert.match(output, /\[Scheduler Started\]/);
      assert.match(output, /\[Observed Daemon Exit Code\] 0/);
      assert.equal(child.exitCode, null, output); assert.equal(child.signalCode, null, output);
      assert.equal(readState(home).lastSyncStatus, "partial");
      assertLastSuccess(home);
      assertUnlocked(home);
    } finally {
      failureEndpoint = undefined;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const outcome = await closed;
      if (process.platform !== "win32") assert.equal(outcome.code, 0, output);
      children.delete(child);
    }
  });

  for (const status of [500, 429]) {
    await t.test(`a queued scan job reports HTTP ${status} upload failure as failed, including rate limits with zero file errors`, async () => {
      const name = `job-scan-${status}`, home = await initialize(name), configPath = path.join(home, "driveos-config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")); config.fullHash = true;
      fs.writeFileSync(configPath, JSON.stringify(config));
      queuedScanJob = { _id: `scan-job-${status}`, action: "scan", status: "approved", machineId: `machine-${name}`,
        affectedFileIds: [], result: { rootPath: path.dirname(media) } };
      failureEndpoint = "/api/uploadBatch"; failureStatus = status;
      try {
        const run = await agent(home, ["run-jobs"]);
        assert.equal(run.code, 0, run.output); // Queue execution succeeded; its individual scan job failed.
        assert.match(run.output, /\[Scan Partial\]/);
        assert.doesNotMatch(run.output, /\[Scan Complete\]/);
        assert.equal(queuedScanJob.status, "failed");
        const report = jobReports.at(-1);
        assert.equal(report.jobId, queuedScanJob._id);
        assert.equal(report.status, "failed");
        assert.equal(report.result.partial, true);
        if (status === 429) assert.equal(report.result.errorsCount, 0);
        else assert.ok(report.result.errorsCount > 0);
        assertUnstamped(home); assertUnlocked(home);
        assert.deepEqual(fs.readdirSync(path.join(home, "jobs")).filter(file => file.endsWith(".lock")), []);
        failureEndpoint = undefined;
        queuedScanJob = { ...queuedScanJob, _id: `scan-job-${status}-retry`, status: "approved", claimToken: undefined,
          result: { rootPath: path.dirname(media) } };
        const retry = await agent(home, ["run-jobs"]);
        assert.equal(retry.code, 0, retry.output);
        assert.equal(queuedScanJob.status, "completed");
        assert.equal(jobReports.at(-1).result.partial, false);
        assertMetadata(name); assertUnlocked(home);
        assert.deepEqual(fs.readdirSync(path.join(home, "jobs")).filter(file => file.endsWith(".lock")), []);
      } finally { failureEndpoint = undefined; queuedScanJob = undefined; }
    });
  }

  await t.test("connect redirect exits without following or saving replacement credentials", async () => {
    const home = await initialize("connect-before"), targetCount = targets;
    const config = path.join(home, "driveos-config.json"), before = fs.readFileSync(config, "utf8");
    redirectEndpoint = "/api/registerMachine";
    let rejected;
    try { rejected = await agent(home, ["connect", "--token", token, "--machine", "connect-after", "--owner", "replacement@driveos.test", "--convex", baseUrl]); }
    finally { redirectEndpoint = undefined; }
    assert.equal(rejected.code, 1, rejected.output);
    assert.match(rejected.output, /redirect|HTTP.{0,10}307/i);
    assert.equal(targets, targetCount);
    assert.equal(fs.readFileSync(config, "utf8"), before);
    const connected = await agent(home, ["connect", "--token", token, "--machine", "connect-after", "--owner", "replacement@driveos.test", "--convex", baseUrl]);
    assert.equal(connected.code, 0, connected.output);
    assert.match(connected.output, /\[Connect\] Connected/);
    const saved = JSON.parse(fs.readFileSync(config, "utf8"));
    assert.equal(saved.machineName, "connect-after");
    assert.deepEqual(saved.scanRoots, JSON.parse(before).scanRoots);
    assert.equal(saved.quarantineRoot, JSON.parse(before).quarantineRoot);
  });

  await t.test("connect handles 401, 503 and success without waiting for unused unfinished bodies", async () => {
    const home = await initialize("connect-body"), config = path.join(home, "driveos-config.json");
    const before = fs.readFileSync(config, "utf8");
    for (const status of [401, 503, 200]) {
      connectReplyStatus = status;
      let outcome;
      try { outcome = await agent(home, ["connect", "--token", token, "--machine", `connect-status-${status}`, "--owner", "updated@driveos.test", "--convex", baseUrl]); }
      finally { connectReplyStatus = undefined; }
      if (status !== 200) {
        assert.equal(outcome.code, 1, outcome.output);
        assert.match(outcome.output, new RegExp(String(status)));
        assert.equal(fs.readFileSync(config, "utf8"), before);
      } else {
        assert.equal(outcome.code, 0, outcome.output);
        assert.match(outcome.output, /\[Connect\] Connected/);
        assert.equal(JSON.parse(fs.readFileSync(config, "utf8")).machineName, "connect-status-200");
      }
    }
  });
  assert.deepEqual(failures, []);
});
