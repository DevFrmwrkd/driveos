// Requires DRIVEOS_TEST_ANALYSIS_FIXTURE: disposable local Convex app containing
// QA-only qaAnalysisRace helpers. No helper is installed in repository sources.
// Enable DRIVEOS_AUTO_ANALYSIS only on that disposable backend before running.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const backendUrl = process.env.DRIVEOS_TEST_URL || "http://127.0.0.1:3210";
const siteUrl = process.env.DRIVEOS_TEST_SITE_URL || "http://127.0.0.1:3211";
for (const url of [backendUrl, siteUrl]) assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname), "Loopback endpoints are required.");
assert.ok(process.env.DRIVEOS_TEST_ANALYSIS_FIXTURE, "Explicit disposable local analysis fixture is required.");
const config = JSON.parse(fs.readFileSync(path.join(process.env.DRIVEOS_TEST_ANALYSIS_FIXTURE, ".convex/local/default/config.json"), "utf8"));
const admin = new ConvexHttpClient(backendUrl, { logger: false }); admin.setAdminAuth(config.adminKey);
const client = new ConvexHttpClient(backendUrl, { logger: false });
const fixture = fs.mkdtempSync(path.join(process.env.DRIVEOS_TEST_DIRECTORY || os.tmpdir(), "driveos-analysis-race-"));
const results = [];
const record = name => { results.push({ name, status: "passed" }); process.stdout.write(`PASS ${name}\n`); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let token;
async function api(operation, body) {
  const response = await fetch(`${siteUrl}/api/${operation}`, { method: "POST", headers: {
    "Content-Type": "application/json", Authorization: `Bearer ${token}`,
  }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, `${operation} must succeed`);
  const result = await response.json(); assert.equal(result.success, true); return result;
}
try {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const login = await client.action(anyApi.auth.signIn, { provider: "password", params: {
    flow: "signUp", email: `qa-analysis-race-${stamp}@driveos.test`, password: "DriveOS-local-QA-2026!", name: "Analysis race QA", orgName: "DriveOS Analysis Race QA",
  } });
  assert.ok(login.tokens?.token); client.setAuth(login.tokens.token);
  const machine = await client.mutation(anyApi.agentAuth.issueMachineToken, { machineName: `AnalysisRace-${stamp}` }); token = machine.token;
  const media = path.join(fixture, "06_RENDERS_CACHE"); fs.mkdirSync(media);
  const content = Buffer.alloc(1024 * 1024 + 17, 65);
  const fullHash = crypto.createHash("sha256").update(content).digest("hex");
  const files = ["first.dat", "second.dat"].map(name => {
    const file = path.join(media, name); fs.writeFileSync(file, content);
    return { path: file, name, extension: "dat", sizeBytes: content.length, createdAtFile: Date.now() - 86400000,
      modifiedAtFile: Date.now() - 86400000, quickHash: "local-analysis-race-quick", fullHash,
      classification: "CACHE", riskLevel: "green", isGenerated: true, isRaw: false, isFinal: false, isProjectFile: false };
  });
  const drive = await api("registerDrive", { label: "Analysis race QA", volumeId: `${process.platform}:${media}`, machineId: machine.machineId,
    ownerId: "local-analysis-qa", capacityBytes: 1e9, usedBytes: content.length * 2, freeBytes: 1e9 - content.length * 2, mountPath: media, tier: "hot" });
  const tenantId = (await client.query(anyApi.drives.get, { driveId: drive.driveId })).tenantId;
  const scan = await api("startScan", { machineId: machine.machineId, driveId: drive.driveId, rootPath: media, agentVersion: "analysis-race-qa" });
  const upload = await api("uploadBatch", { machineId: machine.machineId, driveId: drive.driveId, scanSessionId: scan.sessionId, catalogReceiptProtocol: 1, files });
  await api("completeScan", { sessionId: scan.sessionId, status: "completed", errorsCount: 0 });
  const paused = await admin.mutation(anyApi.qaAnalysisRace.seedPausedRun, { tenantId });
  const claim = await admin.mutation(anyApi.scans.claimAnalysisRun, { tenantId, analysisRunId: paused.analysisRunId });
  assert.equal(claim.shouldRun, true, "Automatic analysis must be enabled on the disposable backend");
  record("real automatic-analysis claim holds one active generation");
  const during = await api("startScan", { machineId: machine.machineId, driveId: drive.driveId, rootPath: media, agentVersion: "analysis-race-qa" });
  fs.unlinkSync(files[0].path);
  const removed = await api("reportMissingFiles", { machineId: machine.machineId, driveId: drive.driveId, scanSessionId: during.sessionId, files: [upload.receipts[0]] });
  assert.equal(removed.receipts[0].status, "deleted");
  await api("completeScan", { sessionId: during.sessionId, status: "completed", errorsCount: 0 });
  const blocked = await client.mutation(anyApi.scans.requestAnalysis, {}); assert.equal(blocked.scheduled, false);
  await admin.mutation(anyApi.scans.recordAnalysisComplete, { tenantId, analysisRunId: paused.analysisRunId, catalogGeneration: claim.catalogGeneration });
  const pending = await admin.query(anyApi.qaAnalysisRace.state, { tenantId });
  assert.ok(pending.state.dirtyCount > 0); assert.equal(pending.state.scheduled, true);
  assert.ok(pending.state.analysisRunId > paused.analysisRunId); assert.equal(pending.scheduled.state.kind, "pending");
  assert.ok(pending.scheduled.scheduledTime >= pending.state.lastRunAt + 86400000 - 1000);
  assert.notEqual(pending.state.analyzedGeneration, pending.state.catalogGeneration);
  record("a scan completing during analysis automatically schedules the dirty follow-up without another scan");
  record("the follow-up respects the daily interval and stale completion does not publish a changed generation");
  // Only the guarded local fixture advances the clock; production code and its
  // actual scheduled action still perform claiming, analysis and publication.
  await admin.mutation(anyApi.qaAnalysisRace.expeditePendingRun, { tenantId, analysisRunId: pending.state.analysisRunId });
  const started = Date.now(); let finished;
  while (Date.now() - started < 30_000) {
    finished = await admin.query(anyApi.qaAnalysisRace.state, { tenantId });
    if (!finished.state.scheduled && finished.state.analyzedGeneration === finished.state.catalogGeneration) break;
    await delay(250);
  }
  assert.equal(finished.state.scheduled, false); assert.equal(finished.state.dirtyCount, 0);
  assert.equal(finished.state.analyzedGeneration, finished.state.catalogGeneration);
  const recs = await client.query(anyApi.recommendations.list, {});
  assert.ok(recs.some(rec => rec.type === "delete_cache"));
  assert.ok(recs.every(rec => !rec.affectedFileIds.includes(upload.receipts[0].fileId)));
  record("the real scheduled follow-up publishes fresh cleanup results and excludes the deleted file");
} catch (error) {
  process.exitCode = 1; results.push({ name: "analysis race regression", status: "failed", error: String(error?.stack || error) });
  process.stderr.write(`FAIL ${error?.stack || error}\n`);
} finally {
  fs.writeFileSync(path.join(fixture, "summary.json"), JSON.stringify({ fixture, results }, null, 2));
  process.stdout.write(`Analysis race evidence: ${fixture}\n`);
}
