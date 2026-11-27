// Functional regression checks against an already running disposable local backend.
// Run after building the agent: node scripts/test-local-flows.mjs
// Never accepts a hosted deployment URL. Leaves its synthetic data for UI testing.
// Explicit agent scans and confirmed restores queue their own analysis, so the
// run waits through the real five-minute analysis cooldown several times.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = process.env.DRIVEOS_TEST_URL || "http://127.0.0.1:3210";
const siteUrl = process.env.DRIVEOS_TEST_SITE_URL || "http://127.0.0.1:3211";
for (const value of [backendUrl, siteUrl]) {
  const url = new URL(value);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Functional tests require a loopback backend.");
}
const fixture = fs.mkdtempSync(path.join(process.env.DRIVEOS_TEST_DIRECTORY || os.tmpdir(), "driveos-fixed-e2e-"));
const media = path.join(fixture, "media");
const agentHome = path.join(fixture, "agent-home");
const quarantineRoot = path.join(fixture, "quarantine");
const results = [];
const email = process.env.DRIVEOS_TEST_EMAIL || `qa-fixes-${Date.now()}@driveos.test`;
const password = process.env.DRIVEOS_TEST_PASSWORD || "DriveOS-local-QA-2026!";
const client = new ConvexHttpClient(backendUrl, { logger: false });
const record = (name, details = {}) => { results.push({ name, status: "passed", ...details }); process.stdout.write(`PASS ${name}\n`); };
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const query = (module, name, args = {}) => client.query(anyApi[module][name], args);
const mutation = (module, name, args = {}) => client.mutation(anyApi[module][name], args);
const agentEnv = { ...process.env, DRIVEOS_AGENT_HOME: agentHome, DRIVEOS_CONVEX_URL: siteUrl };
function agent(args, label = args[0], options = {}) {
  const result = spawnSync(process.execPath, [path.join(repository, "apps/agent/dist/index.js"), ...args], {
    cwd: options.cwd || repository, env: agentEnv, encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(fixture, `${label}.log`), `${result.stdout || ""}\n${result.stderr || ""}`);
  assert.equal(result.status, 0, `${label} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
}
async function poll(read, ready, label) {
  const until = Date.now() + 30000;
  let value;
  do {
    value = await read();
    if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < until);
  throw new Error(`Timed out waiting for ${label}`);
}
// The scans above already queued analysis behind the tenant cooldown; a manual
// request is refused while that run waits. Either way the real scheduled
// analyzer must publish a current catalog.
async function analysisComplete() {
  const until = Date.now() + 330000;
  let status;
  do {
    status = await query("scans", "analysisStatus");
    if (status.status === "completed" && status.catalogCurrent) return status;
    assert.notEqual(status.status, "failed", status.error || "Analysis failed");
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < until);
  throw new Error(`Analysis did not complete: ${JSON.stringify(status)}`);
}
// Old completed status can describe a run that predates the change under test.
// Require a worker that started and completed after the receipt.
async function analysisCompletedAfter(receipt, label) {
  const until = Date.now() + 330000;
  let status;
  do {
    status = await query("scans", "analysisStatus");
    if (status.status === "completed" && status.catalogCurrent &&
        (status.lastRunAt ?? 0) > (receipt.lastRunAt ?? 0) && (status.completedAt ?? 0) > (receipt.completedAt ?? 0)) return status;
    assert.notEqual(status.status, "failed", status.error || `${label} analysis failed`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  } while (Date.now() < until);
  throw new Error(`${label} analysis did not complete: ${JSON.stringify(status)}`);
}
// Force a new explicit analysis, waiting out only the recognized cooldown and
// active-owner refusals. Returns the status receipt taken before acceptance.
async function requestNewAnalysis() {
  const refusals = ["Analysis is already queued or running.", "Analysis was run recently. Try again in five minutes."];
  const until = Date.now() + 330000;
  do {
    const receipt = await query("scans", "analysisStatus");
    const request = await mutation("scans", "requestAnalysis");
    if (request.scheduled) return receipt;
    assert.ok(refusals.includes(request.message), `Unexpected analysis refusal: ${request.message}`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  } while (Date.now() < until);
  throw new Error("A new analysis request was not accepted within the cooldown window.");
}
function write(relative, fill) {
  const filename = path.join(media, relative);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, Buffer.alloc(2 * 1024 * 1024 + 17, fill));
  const stable = new Date(Date.now() - 120000);
  fs.utimesSync(filename, stable, stable);
  return filename;
}
try {
  const auth = await client.action(anyApi.auth.signIn, { provider: "password", params: {
    flow: process.env.DRIVEOS_TEST_EMAIL ? "signIn" : "signUp", email, password, name: "Storage Regression QA", orgName: "DriveOS Fixed E2E",
  } });
  assert.ok(auth.tokens?.token, "Local signup must return a session.");
  client.setAuth(auth.tokens.token);
  fs.writeFileSync(path.join(fixture, "browser-login.json"), JSON.stringify({ email, password, backendUrl, siteUrl }, null, 2));
  const context = await query("tenants", "currentContext");
  for (const [module, endpoint] of [["drives", "list"], ["projects", "list"], ["cleanup", "listQuarantine"]]) {
    assert.deepEqual(await query(module, endpoint), []);
  }
  record("fresh workspace has no fabricated catalog");
  const machine = await mutation("agentAuth", "issueMachineToken", { machineName: `DriveOS-E2E-${Date.now()}` });
  const sourceA = write("06_RENDERS_CACHE/A/preview.dat", 65);
  const sourceB = write("06_RENDERS_CACHE/B/preview.dat", 66);
  const raw = write("02_RAW/A_CAM/take.mov", 71);
  const final = write("08_DELIVERY/master.mov", 72);
  const musicA = write("04_ASSETS/MUSIC/music-A.wav", 77);
  const musicB = write("04_ASSETS/MUSIC/music-B.wav", 77);
  write("04_ASSETS/MUSIC/music-C.wav", 77);
  const beforeHashes = new Map([sourceA, sourceB, raw, final].map(file => [file, hash(file)]));
  agent(["init", "--machine", machine.machineName, "--owner", email, "--convex", siteUrl,
    "--auth-token", machine.token, "--roots", media, "--central-quarantine", "--quarantine", quarantineRoot]);
  agent(["scan", "--path", media, "--full-hash"], "initial-scan");
  const files = await query("files", "list", { limit: 200 });
  assert.equal(files.length, 7);
  assert.equal(files.find(f => f.path === raw).classification, "RAW");
  assert.equal(files.find(f => f.path === final).classification, "EXPORT_FINAL");
  record("Windows RAW and delivery paths retain protected classification");
  const repeat = agent(["scan", "--path", media], "repeat-scan");
  assert.match(repeat, /0 uploaded, 7 unchanged/);
  record("unchanged scans do not upload the catalog again");
  write("04_ASSETS/MUSIC/music-B.wav", 91);
  agent(["scan", "--path", media], "changed-content-quick-scan");
  const changedMusic = (await query("files", "list", { limit: 200 })).find(f => f.path === musicB);
  assert.equal(changedMusic.fullHash, undefined, "A quick scan must invalidate an obsolete full-file hash.");
  assert.equal(hash(musicA) === hash(musicB), false);
  record("changed content invalidates old duplicate hashes during an ordinary quick scan");
  const scanCount = (await query("scans", "list")).length;
  agent(["pause"]);
  agent(["scan-now"], "paused-scan");
  assert.equal((await query("scans", "list")).length, scanCount);
  agent(["resume"]);
  record("pause blocks scheduled/manual sync cycles");
  await mutation("settings", "update", { retentionDays: 21 });
  assert.equal((await query("settings", "get")).retentionDays, 21);
  record("retention settings roundtrip through the database");
  await assert.rejects(mutation("cleanup", "queueQuarantine", { fileIds: [] }));
  await assert.rejects(mutation("cleanup", "queueQuarantine", { fileIds: [files.find(f => f.path === raw)._id] }));
  record("empty and protected-file cleanup requests are rejected");
  const analysis = await mutation("scans", "requestAnalysis");
  // The scan-triggered analysis may still be running or may already have
  // finished inside the five-minute manual cooldown; analysisComplete() below
  // proves the catalog analysis is completed and current either way.
  assert.ok(analysis.scheduled || [
    "Analysis is already queued or running.",
    "Analysis was run recently. Try again in five minutes."
  ].includes(analysis.message), analysis.message);
  await analysisComplete();
  const recommendations = await poll(() => query("recommendations", "list"), recs => recs.some(r => r.type === "delete_cache"), "cleanup analysis");
  if (process.env.DRIVEOS_TEST_PREPARE_BROWSER === "1") {
    fs.writeFileSync(path.join(fixture, "summary.json"), JSON.stringify({ fixture, email, context, results, browserFixtureOnly: true }, null, 2));
    process.stdout.write(`Prepared fresh browser fixture: ${fixture}\n`);
    process.exit(0);
  }
  const safe = recommendations.filter(r => r.type === "delete_cache");
  const queued = await mutation("cleanup", "queueRecommendations", { recommendationIds: safe.map(r => r._id) });
  assert.equal(queued.queued, 2);
  assert.equal(queued.bytes, fs.statSync(sourceA).size + fs.statSync(sourceB).size);
  const reserved = (await query("files", "list", { limit: 200 })).filter(f => [sourceA, sourceB].includes(f.path));
  assert.ok(reserved.every(f => f.pendingCleanupJobId), "Queued files must be reserved atomically.");
  await assert.rejects(mutation("cleanup", "queueQuarantine", { fileIds: [reserved[0]._id] }));
  record("queued files cannot be scheduled for cleanup twice");
  agent(["run-jobs"], "bulk-quarantine");
  let quarantine = await query("cleanup", "listQuarantine");
  assert.equal(quarantine.length, 2);
  assert.notEqual(quarantine[0].quarantinePath, quarantine[1].quarantinePath);
  for (const item of quarantine) {
    assert.equal(fs.existsSync(item.originalPath), false);
    assert.equal(hash(item.quarantinePath), beforeHashes.get(item.originalPath));
    assert.ok(item.rollbackUntil - item.movedAt > 20.9 * 86400000);
  }
  assert.equal(hash(raw), beforeHashes.get(raw));
  assert.equal(hash(final), beforeHashes.get(final));
  record("bulk cleanup moves real same-named files independently and preserves protected media");
  const restored = quarantine.find(i => i.originalPath === sourceA);
  await mutation("cleanup", "requestRestore", { quarantineId: restored._id });
  assert.equal((await query("cleanup", "listQuarantine")).find(i => i._id === restored._id).status, "pending_restore");
  assert.equal(fs.existsSync(sourceA), false);
  const beforeCacheRestore = await query("scans", "analysisStatus");
  agent(["run-jobs"], "restore");
  assert.equal(hash(sourceA), beforeHashes.get(sourceA));
  assert.equal(fs.existsSync(restored.quarantinePath), false);
  assert.equal((await query("cleanup", "listQuarantine")).length, 1);
  record("dashboard restore request completes physically before leaving quarantine");
  const purged = quarantine.find(i => i.originalPath === sourceB);
  assert.ok(path.resolve(purged.quarantinePath).startsWith(path.resolve(quarantineRoot) + path.sep));
  await mutation("cleanup", "purgeItem", { quarantineId: purged._id, requestedBy: email });
  agent(["run-jobs"], "purge-disposable");
  assert.equal(fs.existsSync(purged.quarantinePath), false);
  assert.equal((await query("cleanup", "listQuarantine")).length, 0);
  assert.equal(hash(sourceA), beforeHashes.get(sourceA));
  record("purged/restored items leave active quarantine and unrelated files remain intact");
  const cacheRestoreAnalysis = await analysisCompletedAfter(beforeCacheRestore, "cache restore");
  record("a confirmed restore queues and publishes analysis without another request", {
    lastRunAt: cacheRestoreAnalysis.lastRunAt, completedAt: cacheRestoreAnalysis.completedAt });
  const duplicate = (await query("duplicates", "list")).find(cluster => cluster.type === "exact");
  assert.ok(duplicate, "Two unchanged music files must form an exact duplicate cluster.");
  const nonKeep = duplicate.fileIds.find(id => id !== duplicate.recommendedKeepFileId);
  await mutation("cleanup", "queueQuarantine", { fileIds: [nonKeep], clusterId: duplicate._id });
  assert.ok((await query("recommendations", "list")).filter(rec => rec.status === "open").every(rec => !rec.affectedFileIds.includes(nonKeep)),
    "Direct duplicate cleanup must prune the same file from other open recommendations.");
  await assert.rejects(mutation("cleanup", "queueQuarantine", { fileIds: [duplicate.recommendedKeepFileId] }));
  agent(["run-jobs"], "duplicate-selection");
  const duplicateItem = (await query("cleanup", "listQuarantine"))[0];
  const keepFile = (await query("files", "list", { limit: 200 })).find(f => f._id === duplicate.recommendedKeepFileId);
  assert.equal(fs.existsSync(keepFile.path), true);
  assert.equal(hash(keepFile.path), hash(duplicateItem.quarantinePath));
  record("duplicate cleanup retains a live keep copy and pending files cannot authorize deleting it");
  // QA timing: a new analysis between quarantine and restore prunes the group
  // because only one live copy remains.
  const beforePrune = await requestNewAnalysis();
  const pruneAnalysis = await analysisCompletedAfter(beforePrune, "pre-restore");
  assert.equal(await query("duplicates", "getCluster", { clusterId: duplicate._id }), null, "Analysis must delete the singleton group.");
  const sameHash = cluster => cluster.type === "exact" && cluster.hashKey === duplicate.hashKey;
  assert.deepEqual((await query("duplicates", "list")).filter(sameHash), []);
  record("analysis between quarantine and restore prunes the single-copy duplicate group", {
    lastRunAt: pruneAnalysis.lastRunAt, completedAt: pruneAnalysis.completedAt });
  await mutation("cleanup", "requestRestore", { quarantineId: duplicateItem._id });
  const beforeDuplicateRestore = await query("scans", "analysisStatus");
  agent(["run-jobs"], "duplicate-restore");
  const nonKeepFile = (await query("files", "list", { limit: 200 })).find(f => f._id === nonKeep);
  assert.equal(nonKeepFile.deletedAt, undefined);
  assert.equal(hash(nonKeepFile.path), hash(keepFile.path), "The restored copy keeps its original contents.");
  assert.equal(fs.existsSync(duplicateItem.quarantinePath), false);
  // No scan, analysis request or manual reopen after the restore: the restore
  // alone queues the analysis that recreates the pruned group.
  const restoreAnalysis = await analysisCompletedAfter(beforeDuplicateRestore, "restore-triggered");
  const restoredGroups = (await query("duplicates", "list")).filter(sameHash);
  assert.equal(restoredGroups.length, 1, "A restored duplicate must reappear exactly once without a manual reset.");
  const [restoredDuplicate] = restoredGroups;
  assert.equal(restoredDuplicate.status, "open");
  assert.deepEqual([...restoredDuplicate.fileIds].sort(), [...duplicate.fileIds].sort());
  assert.deepEqual(restoredDuplicate.locations.map(location => location.fileId).sort(), [...duplicate.fileIds].sort());
  assert.deepEqual(restoredDuplicate.locations.map(location => location.path).sort(), duplicate.locations.map(location => location.path).sort());
  assert.equal(restoredDuplicate.fileCount, duplicate.fileCount);
  assert.equal(restoredDuplicate.totalBytes, duplicate.totalBytes);
  assert.equal(restoredDuplicate.wastedBytes, duplicate.wastedBytes);
  record("restored duplicate rejoins Duplicate Center with every copy and its original totals", {
    originalClusterId: duplicate._id, restoredClusterId: restoredDuplicate._id, recreated: restoredDuplicate._id !== duplicate._id,
    fileCount: restoredDuplicate.fileCount, totalBytes: restoredDuplicate.totalBytes, wastedBytes: restoredDuplicate.wastedBytes,
    analysisLastRunAt: restoreAnalysis.lastRunAt, analysisCompletedAt: restoreAnalysis.completedAt });
  const drive = (await query("drives", "list"))[0];
  const scansBefore = (await query("scans", "list")).length;
  const requestedScan = await mutation("drives", "requestScan", { driveId: drive._id });
  assert.ok(requestedScan.queued > 0);
  agent(["run-jobs"], "dashboard-scan");
  assert.ok((await query("scans", "list")).length > scansBefore);
  record("dashboard scan request creates a real agent scan");
  const projectRoot = path.join(media, "QA_Wizard_Project");
  const projectId = await mutation("projects", "create", { name: "Fixed Wizard Project", client: "QA Studio",
    ownerId: email, status: "active", tier: "hot", rootPath: projectRoot, driveId: drive._id, template: "YouTube Show",
    rules: { rawKeep: true, finalKeep: true, licenseKeep: true, cacheDelete: true, proxyDelete: false } });
  assert.equal(fs.existsSync(projectRoot), false);
  assert.equal((await query("projects", "setupStatus", { projectId })).status, "approved");
  agent(["run-jobs"], "wizard-folders");
  assert.equal((await query("projects", "setupStatus", { projectId })).status, "completed");
  assert.ok(fs.existsSync(path.join(projectRoot, "09_ARCHIVE_MANIFEST", "project_manifest.json")));
  assert.equal((await query("projects", "get", { projectId })).cleanupRules.proxyDelete, false);
  record("wizard targets its drive, persists rules, and creates folders without manual approval");
  fs.writeFileSync(path.join(projectRoot, "00_ADMIN", "project-notes.txt"), "Manifest QA inventory");
  agent(["manifest", "--projectId", projectId, "--root", path.basename(projectRoot)], "relative-cli-manifest", { cwd: media });
  const relativeManifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "09_ARCHIVE_MANIFEST", "archive_manifest.json"), "utf8"));
  assert.equal(relativeManifest.files.length, 1);
  assert.equal(relativeManifest.files[0].fullHash, hash(path.join(projectRoot, "00_ADMIN", "project-notes.txt")));
  record("CLI manifest resolves a relative project root and includes small files with full checksums");
  await mutation("archive", "requestManifest", { projectId, verify: false });
  agent(["run-jobs"], "archive-generate");
  const archivePath = path.join(projectRoot, "09_ARCHIVE_MANIFEST", "archive_manifest.json");
  assert.ok(fs.existsSync(archivePath));
  const inventory = JSON.parse(fs.readFileSync(archivePath, "utf8"));
  assert.equal(inventory.files.length, 1);
  assert.equal(inventory.files[0].fullHash, hash(path.join(projectRoot, "00_ADMIN", "project-notes.txt")));
  await mutation("archive", "requestManifest", { projectId, verify: true });
  agent(["run-jobs"], "archive-verify");
  assert.ok((await query("archive", "listManifests")).some(m => m.projectId === projectId && m.status === "verified"));
  record("archive generation and verification execute against actual file checksums");
  const note = path.join(projectRoot, "00_ADMIN", "project-notes.txt");
  fs.appendFileSync(note, " edited after verification");
  const failedVerification = await mutation("archive", "requestManifest", { projectId, verify: true });
  agent(["run-jobs"], "archive-detect-change");
  assert.equal((await query("cleanup", "listJobs")).find(job => job._id === failedVerification.jobId).status, "failed");
  await assert.rejects(mutation("projects", "updateStatus", { projectId, status: "archived" }));
  await mutation("archive", "requestManifest", { projectId, verify: false });
  agent(["run-jobs"], "archive-regenerate");
  await mutation("archive", "requestManifest", { projectId, verify: true });
  agent(["run-jobs"], "archive-reverify");
  record("changed archive contents fail verification and prevent an archived status");
  fs.writeFileSync(path.join(fixture, "summary.json"), JSON.stringify({ fixture, email, context, results, projectId, driveId: drive._id }, null, 2));
  process.stdout.write(`Evidence and browser login: ${fixture}\n`);
} catch (error) {
  fs.writeFileSync(path.join(fixture, "summary.json"), JSON.stringify({ fixture, email, results, failure: error.message }, null, 2));
  process.stderr.write(`FAIL ${error.stack}\nEvidence: ${fixture}\n`);
  process.exitCode = 1;
}
