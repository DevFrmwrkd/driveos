import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  const completed: { driveId: string; status: string }[] = [];
  const sessions = new Map<string, string>();
  const failures: string[] = [];
  let sessionSequence = 0;
  let redirectEndpoint: string | undefined;
  let connectReplyStatus: number | undefined;
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
      if (endpoint === "/api/registerMachine" && connectReplyStatus !== undefined) {
        response.writeHead(connectReplyStatus, { "Content-Type": "application/json", "Content-Length": "100000000" });
        response.write(Buffer.alloc(65536, 65));
        return; // Connect needs the status, not an unused never-ending body.
      }
      if (endpoint === "/api/registerMachine") return json(200, { success: true, machineId: `machine-${payload.name}` });
      if (endpoint === "/api/registerDrive") {
        const driveId = `drive-${payload.machineId}`;
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
          const stored = { ...previous, ...file, fileId: `file-${payload.driveId}`, catalogVersion: (previous?.catalogVersion || 0) + 1,
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
      if (endpoint === "/api/pollPendingJobs") return json(200, []);
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
    assert.match(rejected.output, /redirect|HTTP.{0,10}307/i);
    assert.equal(targets, targetCount); assertUnlocked(home);
    assert.equal(catalogs.get("drive-machine-upload-redirect")!.size, 0);
    const cache = JSON.parse(fs.readFileSync(path.join(home, "driveos-hash-cache.json"), "utf8"));
    assert.ok(Object.values(cache).length > 0);
    for (const value of Object.values(cache) as any[]) { assert.equal(value.uploadedFp, undefined); assert.equal(value.catalogReceipt, undefined); }
    assert.ok(completed.some(scan => scan.driveId === "drive-machine-upload-redirect" && scan.status === "partial"));
    const retry = await agent(home, ["scan", "--path", path.dirname(media), "--full-hash"]);
    assert.equal(retry.code, 0, retry.output); assert.match(retry.output, /1 uploaded/); assertMetadata("upload-redirect"); assertUnlocked(home);
  });

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
