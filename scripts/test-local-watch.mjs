// Watcher/cache regression against a disposable, already-running local backend.
// Build the agent first. This test waits for the watcher's normal one-minute flush.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = process.env.DRIVEOS_TEST_URL || "http://127.0.0.1:3210";
const siteUrl = process.env.DRIVEOS_TEST_SITE_URL || "http://127.0.0.1:3211";
for (const value of [backendUrl, siteUrl]) {
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname), "Watcher regression requires loopback endpoints.");
}
const fixture = fs.mkdtempSync(path.join(process.env.DRIVEOS_TEST_DIRECTORY || os.tmpdir(), "driveos-watch-e2e-"));
const media = path.join(fixture, "media");
const watched = path.join(media, "06_RENDERS_CACHE");
const agentHome = path.join(fixture, "agent-home");
const cachePath = path.join(agentHome, "driveos-hash-cache.json");
const results = [];
const client = new ConvexHttpClient(backendUrl, { logger: false });
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const email = `qa-watcher-${stamp}@driveos.test`;
const password = "DriveOS-local-QA-2026!";
const env = { ...process.env, DRIVEOS_AGENT_HOME: agentHome, DRIVEOS_CONVEX_URL: siteUrl };
const agentEntry = path.join(repository, "apps/agent/dist/index.js");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = name => { results.push({ name, status: "passed" }); process.stdout.write(`PASS ${name}\n`); };
const queryFiles = () => client.query(anyApi.files.list, { limit: 20 });
const checksum = filename => crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
const readCache = () => JSON.parse(fs.readFileSync(cachePath, "utf8"));
const cacheKey = filename => `${filename}-${fs.statSync(filename).size}`;
let watcher;
let watchOutput = "";

function write(relative, byte, ageMs) {
  const filename = path.join(media, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, Buffer.alloc(2 * 1024 * 1024 + 17, byte));
  const stable = new Date(Date.now() - ageMs);
  fs.utimesSync(filename, stable, stable);
  return filename;
}

async function agent(args, label) {
  const child = spawn(process.execPath, [agentEntry, ...args], { cwd: repository, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  const timeout = setTimeout(() => child.kill(), 30_000);
  let status;
  try {
    status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  } finally {
    clearTimeout(timeout);
    fs.writeFileSync(path.join(fixture, `${label}.log`), output);
  }
  assert.equal(status, 0, `${label} must succeed; inspect ${path.join(fixture, `${label}.log`)}`);
  return output;
}

async function waitFor(read, ready, label, durationMs = 30_000) {
  const started = Date.now();
  let nextProgress = started + 15_000;
  while (Date.now() - started < durationMs) {
    if (watcher && (watcher.exitCode !== null || watcher.signalCode !== null)) throw new Error(`Watcher exited while waiting for ${label}. See watcher.log.`);
    const value = await read();
    if (ready(value)) return value;
    if (Date.now() >= nextProgress) {
      process.stdout.write(`Waiting for ${label} (${Math.round((Date.now() - started) / 1000)}s)…\n`);
      nextProgress += 15_000;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  const session = await client.action(anyApi.auth.signIn, { provider: "password", params: {
    flow: "signUp", email, password, name: "Watcher QA", orgName: "DriveOS Watcher Regression",
  } });
  assert.ok(session.tokens?.token, "A disposable account must receive a session.");
  client.setAuth(session.tokens.token);
  const machine = await client.mutation(anyApi.agentAuth.issueMachineToken, { machineName: `Watcher-QA-${stamp}` });
  const original = write("06_RENDERS_CACHE/preview.dat", 65, 120_000);
  const recreated = write("06_RENDERS_CACHE/recreated.dat", 65, 120_000);
  const legacy = write("06_RENDERS_CACHE/legacy-subtree/legacy.dat", 83, 120_000);
  const oldHash = checksum(original);
  await agent(["init", "--machine", machine.machineName, "--owner", email, "--convex", siteUrl,
    "--auth-token", machine.token, "--roots", media, "--central-quarantine", "--quarantine", path.join(fixture, "quarantine")], "init");
  await agent(["scan", "--path", media, "--full-hash"], "initial-full-scan");
  assert.equal((await queryFiles()).find(file => file.path === original)?.fullHash, oldHash);
  record("initial full scan stores the original file checksum");
  const initialFiles = await queryFiles();
  const originalId = initialFiles.find(file => file.path === original)._id;
  const driveId = initialFiles.find(file => file.path === original).driveId;
  const legacyCache = readCache();
  delete legacyCache[cacheKey(legacy)].catalogReceipt;
  delete legacyCache[cacheKey(legacy)].catalogParent;
  fs.writeFileSync(cachePath, JSON.stringify(legacyCache));
  const analysis = await client.mutation(anyApi.scans.requestAnalysis, {});
  assert.equal(analysis.scheduled, true);
  await waitFor(() => client.query(anyApi.duplicates.list, {}), clusters => clusters.length > 0, "initial duplicate analysis");
  const oldRecommendations = await waitFor(() => client.query(anyApi.recommendations.list, {}), rows => rows.length > 0, "initial recommendations");

  watcher = spawn(process.execPath, [agentEntry, "watch", "--path", watched, "--interval-minutes", "1", "--debounce-seconds", "1"], {
    cwd: repository, env, stdio: ["ignore", "pipe", "pipe"],
  });
  watcher.on("error", error => { watchOutput += `\nWatcher process error: ${error.message}\n`; });
  const saveWatchOutput = data => {
    watchOutput += data;
    fs.appendFileSync(path.join(fixture, "watcher.log"), data);
  };
  watcher.stdout.on("data", saveWatchOutput);
  watcher.stderr.on("data", saveWatchOutput);
  await waitFor(async () => watchOutput, output => output.includes("[Watcher Started]"), "watcher startup");
  // Allow chokidar's initial discovery to finish before changing the fixture.
  await delay(2_000);

  // This sibling lies outside the watched directory. Only the other scanner
  // knows about it, so a stale whole-cache write from watch would lose its stamp.
  const sibling = write("04_ASSETS/MUSIC/unrelated.wav", 77, 120_000);
  await agent(["scan", "--path", media, "--full-hash"], "separate-full-scan");
  const siblingBefore = readCache()[cacheKey(sibling)];
  assert.ok(siblingBefore?.uploadedFp && siblingBefore.fullHash === checksum(sibling));
  const legacyAfterScan = readCache();
  delete legacyAfterScan[cacheKey(legacy)].catalogReceipt;
  delete legacyAfterScan[cacheKey(legacy)].catalogParent;
  fs.writeFileSync(cachePath, JSON.stringify(legacyAfterScan));
  record("a separate scanner adds an unrelated file after the watcher loads its cache");

  const oldModifiedAt = fs.statSync(original).mtimeMs;
  write("06_RENDERS_CACHE/preview.dat", 90, 30_000);
  assert.notEqual(fs.statSync(original).mtimeMs, oldModifiedAt);
  assert.notEqual(checksum(original), oldHash);
  process.stdout.write("Waiting for the watcher's normal one-minute batch flush…\n");
  const afterWatch = await waitFor(queryFiles, files => {
    const changed = files.find(file => file.path === original);
    return changed?.modifiedAtFile === fs.statSync(original).mtimeMs && changed.fullHash === undefined;
  }, "watcher upload and obsolete checksum invalidation", 85_000);
  assert.equal(afterWatch.length, 4);
  record("watcher uploads changed metadata and invalidates the obsolete full checksum");

  await waitFor(async () => readCache(), cache => {
    const changed = cache[cacheKey(original)];
    return changed?.modifiedAt === fs.statSync(original).mtimeMs && changed.fullHash === undefined && !!changed.uploadedFp;
  }, "watcher cache persistence");
  const cacheAfterWatch = readCache();
  assert.equal(cacheAfterWatch[cacheKey(sibling)].uploadedFp, siblingBefore.uploadedFp);
  assert.equal(cacheAfterWatch[cacheKey(sibling)].fullHash, siblingBefore.fullHash);
  record("watcher cache persistence preserves another scanner's unrelated hash and upload stamp");

  const quick = await agent(["scan", "--path", media], "ordinary-quick-scan");
  assert.match(quick, /0 uploaded, 4 unchanged/);
  assert.equal((await queryFiles()).find(file => file.path === original)?.fullHash, undefined);
  assert.equal(readCache()[cacheKey(original)].fullHash, undefined);
  record("an ordinary quick scan skips unchanged files without reviving the obsolete checksum");

  // Queue real unlinks while paused, including a pre-upgrade cache entry which
  // has no server receipt. Nothing is inferred from a missing volume/root.
  const originalStat = fs.statSync(original);
  const recreatedStat = fs.statSync(recreated);
  await agent(["pause"], "pause-deletions");
  fs.unlinkSync(original);
  fs.unlinkSync(legacy);
  fs.rmdirSync(path.dirname(legacy));
  fs.unlinkSync(recreated);
  fs.writeFileSync(recreated, Buffer.alloc(2 * 1024 * 1024 + 17, 65));
  fs.utimesSync(recreated, recreatedStat.atime, recreatedStat.mtime);
  await delay(65_000);
  const pausedFiles = await queryFiles();
  assert.ok(pausedFiles.some(file => file.path === original));
  assert.ok(pausedFiles.some(file => file.path === legacy));
  record("paused watcher holds deletion events through a normal batch interval");
  await agent(["resume"], "resume-deletions");
  await waitFor(queryFiles, files => !files.some(file => [original, legacy].includes(file.path)), "batched unlink and legacy receipt reconciliation", 85_000);
  assert.ok((await queryFiles()).some(file => file.path === recreated));
  const firstLive = await client.query(anyApi.files.list, { driveId, limit: 1 });
  assert.equal(firstLive.length, 1);
  assert.ok(![original, legacy].includes(firstLive[0].path));
  for (const args of [{ classification: "CACHE", limit: 1 }, { riskLevel: "green", limit: 1 }]) {
    const rows = await client.query(anyApi.files.list, args);
    assert.equal(rows.length, 1);
    assert.ok(![original, legacy].includes(rows[0].path));
  }
  record("batched deletions and legacy subtree cache entries disappear before catalog query limits");
  assert.deepEqual(await client.query(anyApi.duplicates.list, {}), []);
  assert.deepEqual(await client.query(anyApi.recommendations.list, {}), []);
  for (const rec of oldRecommendations) assert.equal(await client.query(anyApi.recommendations.get, { recommendationId: rec._id }), null);
  record("deletion invalidates cached duplicate and cleanup results without automatic analysis");
  record("unlink and identical recreation before flush preserves the live file");

  fs.writeFileSync(original, Buffer.alloc(2 * 1024 * 1024 + 17, 90));
  fs.utimesSync(original, originalStat.atime, originalStat.mtime);
  await waitFor(queryFiles, files => files.some(file => file.path === original), "identical metadata resurrection after tombstone", 85_000);
  assert.equal((await queryFiles()).find(file => file.path === original)._id, originalId);
  record("an identical metadata recreation resurrects the existing catalog row");

  const parked = path.join(fixture, "disconnected-watch-root");
  fs.renameSync(watched, parked);
  await delay(75_000);
  const disconnectedFiles = await queryFiles();
  assert.ok(disconnectedFiles.some(file => file.path === original));
  assert.ok(disconnectedFiles.some(file => file.path === recreated));
  fs.renameSync(parked, watched);
  await delay(2_000);
  record("an unavailable watched root does not delete its last known catalog");

  // Advance the server observation without replacing the watcher's receipt,
  // as a restore does before its add event has been uploaded. The first CAS
  // must conflict, then a fresh receipt and physical absence check can settle
  // the actual later unlink. Use only normal authenticated loopback routes.
  await agent(["pause"], "pause-stale-receipt");
  const conflictOutputStart = watchOutput.length;
  const beforeConflict = (await queryFiles()).find(file => file.path === recreated);
  const staleVersion = readCache()[cacheKey(recreated)].catalogReceipt.catalogVersion;
  const agentApi = async (operation, body) => {
    const response = await fetch(`${siteUrl}/api/${operation}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${machine.token}` },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `${operation} must succeed against the disposable backend`);
    const result = await response.json();
    assert.equal(result.success, true);
    return result;
  };
  const observationSession = await agentApi("startScan", { machineId: machine.machineId, driveId, rootPath: watched, agentVersion: "watcher-regression" });
  const metadataKeys = ["path", "name", "extension", "sizeBytes", "createdAtFile", "modifiedAtFile", "quickHash", "fullHash", "classification", "riskLevel", "isGenerated", "isRaw", "isFinal", "isProjectFile", "projectId"];
  const metadata = Object.fromEntries(metadataKeys.filter(key => beforeConflict[key] !== undefined).map(key => [key, beforeConflict[key]]));
  const forced = await agentApi("uploadBatch", { machineId: machine.machineId, driveId, scanSessionId: observationSession.sessionId,
    catalogReceiptProtocol: 1, files: [{ ...metadata, forceObservation: true }] });
  assert.ok(forced.receipts[0].catalogVersion > staleVersion);
  await agentApi("completeScan", { sessionId: observationSession.sessionId, status: "completed", errorsCount: 0 });
  fs.unlinkSync(recreated);
  await agent(["resume"], "resume-stale-receipt");
  await waitFor(queryFiles, files => !files.some(file => file.path === recreated), "watcher deletion after drive recovery and receipt refresh", 150_000);
  assert.match(watchOutput.slice(conflictOutputStart), /\[Watcher Conflict\] Refreshing catalog receipt after newer observation/);
  record("a stale server observation receipt is refreshed without dropping the later deletion");
  assert.ok((await queryFiles()).some(file => file.path === original));
  assert.ok((await queryFiles()).some(file => file.path === sibling));
  assert.equal(readCache()[cacheKey(sibling)].uploadedFp, siblingBefore.uploadedFp);
  record("watching recovers after the same root returns and preserves unrelated scan cache entries");

  const refreshed = await client.mutation(anyApi.scans.requestAnalysis, {});
  assert.equal(refreshed.scheduled, true);
  await waitFor(() => client.query(anyApi.recommendations.list, {}), rows => rows.some(rec => rec.type === "delete_cache"), "fresh analysis after catalog reconciliation");
  const finalRecommendations = await client.query(anyApi.recommendations.list, {});
  assert.ok(finalRecommendations.every(rec => !rec.affectedFileIds.some(id => initialFiles.filter(file => [legacy, recreated].includes(file.path)).some(file => file._id === id))));
  record("explicit analysis publishes fresh recommendations after reconciliation");
} catch (error) {
  process.exitCode = 1;
  results.push({ name: "watcher regression", status: "failed", error: String(error?.stack || error) });
  process.stderr.write(`FAIL ${error?.stack || error}\n`);
} finally {
  if (watcher && watcher.exitCode === null && watcher.signalCode === null) {
    const stopped = new Promise(resolve => watcher.once("exit", resolve));
    // Terminate only the child this test created. All assertions precede this;
    // Windows may bypass the agent's signal handler, so flushing is not assumed.
    watcher.kill();
    await stopped;
  }
  fs.writeFileSync(path.join(fixture, "summary.json"), JSON.stringify({ fixture, email, results }, null, 2));
  process.stdout.write(`Watcher evidence: ${fixture}\n`);
}
