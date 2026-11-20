import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// Exercise actual public readers and asynchronous analysis handlers against a
// small isolated catalog. No deployment, media files, or full-catalog fixture.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const modules = new Map();
const internal = {
  scans: Object.fromEntries(["captureAnalysisGeneration", "claimManualAnalysisRun", "runManualAnalysis", "finishManualAnalysis", "claimAnalysisRun", "recordAnalysisComplete", "restoreAnalysisAfterFailure", "runPostScanAnalysis"]
    .map(name => [name, name])),
  duplicates: { runDuplicateDetection: "runDuplicateDetection" },
  recommendations: { generateRecommendations: "generateRecommendations" },
};
function load(filename, cache = modules) {
  filename = path.resolve(filename);
  if (cache.has(filename)) return cache.get(filename);
  const exports = {};
  cache.set(filename, exports);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const require = name => {
    if (name === "./_generated/server") return Object.fromEntries(["query", "mutation", "internalQuery", "internalMutation", "internalAction"].map(name => [name, definition => definition]));
    if (name === "./_generated/api") return { internal };
    if (name === "./access") return {
      requireMember: async ctx => ({ tenantId: ctx.tenantId }),
      requireRole: async ctx => ({ tenantId: ctx.tenantId }),
      inTenant: (doc, tenantId) => doc?.tenantId === tenantId ? doc : null,
    };
    if (name === "./jobUtils") return { protectedFile: () => false };
    if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), `${name}.ts`), cache);
    return nodeRequire(name);
  };
  new Function("require", "exports", code)(require, exports);
  return exports;
}
function loadScans(enabled) {
  const previousAuto = process.env.DRIVEOS_AUTO_ANALYSIS;
  process.env.DRIVEOS_AUTO_ANALYSIS = String(enabled);
  try { return load(path.join(repository, "convex/scans.ts"), new Map()); }
  finally {
    if (previousAuto === undefined) delete process.env.DRIVEOS_AUTO_ANALYSIS;
    else process.env.DRIVEOS_AUTO_ANALYSIS = previousAuto;
  }
}
const scans = loadScans(true), scansOff = loadScans(false);
const duplicates = load(path.join(repository, "convex/duplicates.ts"));
const recommendations = load(path.join(repository, "convex/recommendations.ts"));
const { catalogAnalysisIsCurrent } = load(path.join(repository, "convex/catalogAnalysis.ts"));

function fixture(generation = 1, analyzedGeneration = 0, handlers = scans) {
  const tenantId = "tenant-a";
  const state = { _id: "analysisState:1", tenantId, catalogGeneration: generation, analyzedGeneration, dirtyCount: 1, scheduled: true, lastRunAt: 0 };
  const live = { _id: "files:1", tenantId, name: "live.mov", path: "/review/live.mov", sizeBytes: 10, source: "local" };
  const deleted = { ...live, _id: "files:2", path: "/review/removed.mov", deletedAt: 123 };
  const cluster = { _id: "duplicateClusters:1", tenantId, status: "open", fileIds: [live._id, deleted._id], recommendedKeepFileId: live._id, wastedBytes: 10 };
  const rec = { _id: "recommendations:1", tenantId, status: "open", affectedFileIds: [deleted._id], affectedBytes: 10 };
  const session = { _id: "scanSessions:1", tenantId, machineId: "machines:1", rootPath: "/review", status: "running", filesScanned: 0, bytesScanned: 0 };
  const tables = { analysisState: [state], files: [live, deleted], duplicateClusters: [cluster], recommendations: [rec], auditLogs: [], scanSessions: [session] };
  const documents = new Map(Object.values(tables).flat().map(row => [row._id, row]));
  const reads = [], scheduled = [];
  const jobs = new Map();
  const db = {
    normalizeId: (table, id) => id.startsWith(`${table}:`) ? id : null,
    get: async id => structuredClone(documents.get(id) ?? null),
    patch: async (id, patch) => Object.assign(documents.get(id), structuredClone(patch)),
    insert: async (table, row) => { const id = `${table}:${tables[table].length + 1}`; const doc = { ...structuredClone(row), _id: id }; tables[table].push(doc); documents.set(id, doc); return id; },
    system: { get: async id => structuredClone(jobs.get(id) ?? null) },
    query(table) {
      reads.push(table);
      const filters = [];
      const chain = {
        withIndex(_name, configure) {
          const index = { eq: (field, value) => { filters.push(row => row[field] === value); return index; } };
          configure(index); return chain;
        },
        order: () => chain,
        take: async count => structuredClone((tables[table] ?? []).filter(row => filters.every(filter => filter(row))).slice(0, count)),
        first: async () => (await chain.take(1))[0] ?? null,
        collect: async () => chain.take(Infinity),
      };
      return chain;
    },
  };
  const ctx = { tenantId, db, scheduler: {
    runAfter: async (delay, reference, args) => {
      const id = `_scheduled_functions:${scheduled.length + 1}`;
      scheduled.push([delay, reference, structuredClone(args), id]);
      jobs.set(id, { _id: id, name: `scans:${reference}`, args: [structuredClone(args)], scheduledTime: Date.now() + delay, state: { kind: "pending" } });
      return id;
    },
    cancel: async id => { jobs.get(id).state = { kind: "canceled" }; },
  } };
  ctx.runQuery = async (reference, args) => handlers[reference].handler(ctx, args);
  ctx.runMutation = async (reference, args) => handlers[reference].handler(ctx, args);
  ctx.runAction = async () => {};
  return { ctx, state, cluster, rec, live, deleted, session, reads, scheduled, jobs,
    setHandlers: next => { handlers = next; },
    async runScheduled(index) {
      const [, reference, args, id] = scheduled[index], job = jobs.get(id);
      job.state = { kind: "inProgress" };
      try { await handlers[reference].handler(ctx, args); if (job.state.kind !== "canceled") job.state = { kind: "success" }; }
      catch (error) { job.state = { kind: "failed" }; throw error; }
    },
  };
}

test("legacy analysis remains readable until a catalog generation invalidates it", () => {
  assert.equal(catalogAnalysisIsCurrent(null), true);
  assert.equal(catalogAnalysisIsCurrent({}), true);
  assert.equal(catalogAnalysisIsCurrent({ catalogGeneration: 1 }), false);
  assert.equal(catalogAnalysisIsCurrent({ catalogGeneration: 2, analyzedGeneration: 2 }), true);
});

test("deleted catalog generations hide cached duplicate and recommendation aggregates without file fan-out", async () => {
  const f = fixture();
  assert.deepEqual(await duplicates.list.handler(f.ctx, {}), []);
  assert.equal(await duplicates.getCluster.handler(f.ctx, { clusterId: f.cluster._id }), null);
  assert.deepEqual(await recommendations.list.handler(f.ctx, {}), []);
  assert.equal(await recommendations.get.handler(f.ctx, { recommendationId: f.rec._id }), null);
  assert.deepEqual(f.reads, ["analysisState", "analysisState", "analysisState", "analysisState"]);
});

test("fresh cached analysis is readable and cluster details exclude tombstoned files", async () => {
  const f = fixture(1, 1);
  assert.equal((await duplicates.list.handler(f.ctx, {})).length, 1);
  const detail = await duplicates.getCluster.handler(f.ctx, { clusterId: f.cluster._id });
  assert.deepEqual(detail.files.map(file => file._id), [f.live._id]);
  assert.equal((await recommendations.list.handler(f.ctx, {})).length, 1);
  assert.equal((await recommendations.get.handler(f.ctx, { recommendationId: f.rec._id }))._id, f.rec._id);
});

test("manual analysis publishes only the generation captured before its asynchronous work", async () => {
  for (const changeDuringAnalysis of [false, true]) {
    const f = fixture();
    f.ctx.runAction = async reference => {
      if (reference === "runDuplicateDetection" && changeDuringAnalysis) {
        f.state.catalogGeneration++;
        f.state.dirtyCount++;
      }
    };
    await scans.runManualAnalysis.handler(f.ctx, { tenantId: f.ctx.tenantId });
    assert.equal(f.state.scheduled, changeDuringAnalysis);
    assert.equal(f.state.analyzedGeneration, changeDuringAnalysis ? 0 : 1);
    assert.equal(f.state.dirtyCount, changeDuringAnalysis ? 2 : 0);
    assert.equal(catalogAnalysisIsCurrent(f.state), !changeDuringAnalysis);
  }
});

test("failed or legacy analysis completion cannot clear a deletion invalidation", async () => {
  const f = fixture(2, 0);
  f.ctx.runAction = async () => { throw new Error("analysis fixture failure"); };
  await assert.rejects(scans.runManualAnalysis.handler(f.ctx, { tenantId: f.ctx.tenantId }), /fixture failure/);
  assert.equal(f.state.dirtyCount, 1);
  assert.equal(catalogAnalysisIsCurrent(f.state), false);
  await scans.finishManualAnalysis.handler(f.ctx, { tenantId: f.ctx.tenantId, success: true });
  await scans.recordAnalysisComplete.handler(f.ctx, { tenantId: f.ctx.tenantId });
  assert.equal(f.state.analyzedGeneration, 0);
  assert.equal(f.state.dirtyCount, 1);
});

test("automatic analysis captures its claimed generation and blocks overlapping manual requests", async () => {
  for (const changeDuringAnalysis of [false, true]) {
    const f = fixture(3, 0);
    f.ctx.runAction = async reference => {
      assert.equal(f.state.scheduled, true);
      const manual = await scans.requestAnalysis.handler(f.ctx, {});
      assert.equal(manual.scheduled, false);
      assert.match(manual.message, /already queued or running/);
      if (reference === "runDuplicateDetection" && changeDuringAnalysis) {
        f.state.catalogGeneration++;
        f.state.dirtyCount++;
      }
    };
    await scans.runPostScanAnalysis.handler(f.ctx, { tenantId: f.ctx.tenantId });
    assert.equal(f.state.scheduled, changeDuringAnalysis);
    assert.equal(f.state.analyzedGeneration, changeDuringAnalysis ? 0 : 3);
    assert.equal(f.state.dirtyCount, changeDuringAnalysis ? 1 : 0);
    assert.equal(catalogAnalysisIsCurrent(f.state), !changeDuringAnalysis);
  }
});

test("automatic failure restores claimed dirty work and schedules one bounded retry", async () => {
  const f = fixture();
  f.ctx.runAction = async () => { f.state.dirtyCount++; throw new Error("auto fixture failure"); };
  await assert.rejects(scans.runPostScanAnalysis.handler(f.ctx, { tenantId: f.ctx.tenantId }), /fixture failure/);
  assert.equal(f.state.dirtyCount, 2);
  assert.equal(f.state.scheduled, true);
  assert.equal(f.scheduled.length, 1);
  assert.equal(catalogAnalysisIsCurrent(f.state), false);
});

const MINUTE = 60_000, DAY = 24 * 60 * MINUTE;
function clock(t) {
  let now = 2_000_000_000_000;
  t.mock.method(Date, "now", () => now);
  return { get now() { return now; }, set(value) { now = value; } };
}
async function completeScan(f, handlers = scans) {
  await handlers.complete.handler(f.ctx, { sessionId: f.session._id, status: "completed", errorsCount: 0, tenantId: f.ctx.tenantId });
}

test("a scan completing during analysis gets one follow-up that publishes without another scan", async t => {
  const time = clock(t), f = fixture(3, 0);
  f.state.scheduled = false;
  await completeScan(f);
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.scheduled[0][0], 5 * MINUTE);
  time.set(time.now + f.scheduled[0][0]);
  const firstStartedAt = time.now;
  f.ctx.runAction = async reference => {
    if (reference !== "runDuplicateDetection") return;
    f.state.catalogGeneration++;
    f.state.dirtyCount++;
    await completeScan(f);
    await completeScan(f);
    assert.equal(f.scheduled.length, 1);
  };
  await f.runScheduled(0);
  assert.equal(f.state.scheduled, true);
  assert.equal(f.state.analysisClaimed, false);
  assert.equal(f.state.dirtyCount, 1);
  assert.equal(catalogAnalysisIsCurrent(f.state), false);
  assert.equal(f.scheduled.length, 2);
  const followUp = f.jobs.get(f.state.analysisFunctionId);
  assert.equal(followUp.scheduledTime, firstStartedAt + DAY);
  assert.equal([...f.jobs.values()].filter(job => job.state.kind === "pending").length, 1);
  time.set(followUp.scheduledTime);
  f.ctx.runAction = async () => {};
  await f.runScheduled(1);
  assert.equal(f.state.analyzedGeneration, 4);
  assert.equal(f.state.dirtyCount, 0);
  assert.equal(f.state.scheduled, false);
  assert.equal(f.scheduled.length, 2);
  assert.equal(catalogAnalysisIsCurrent(f.state), true);
  assert.equal((await recommendations.list.handler(f.ctx, {})).length, 1);
});

test("an early automatic worker preserves the daily floor with one replacement timer", async t => {
  const time = clock(t), f = fixture();
  f.state.scheduled = false;
  f.state.lastRunAt = time.now;
  await completeScan(f);
  let actions = 0;
  f.ctx.runAction = async () => { actions++; };
  await f.runScheduled(0); // Simulate an older timer firing before the floor.
  assert.equal(actions, 0);
  assert.equal(f.scheduled.length, 2);
  assert.equal(f.jobs.get(f.state.analysisFunctionId).scheduledTime, time.now + DAY);
  assert.equal([...f.jobs.values()].filter(job => job.state.kind === "pending").length, 1);
  time.set(time.now + DAY);
  await f.runScheduled(1);
  assert.equal(actions, 2);
  assert.equal(f.state.scheduled, false);
});

test("manual failures retain dirty work and only opt-in workspaces queue automatic retry", async t => {
  const time = clock(t);
  for (const [handlers, automatic] of [[scans, true], [scansOff, false]]) {
    const f = fixture(2, 0, handlers);
    f.state.scheduled = false;
    await handlers.requestAnalysis.handler(f.ctx, {});
    f.ctx.runAction = async () => { throw new Error("manual retry fixture"); };
    await assert.rejects(f.runScheduled(0), /manual retry fixture/);
    assert.equal(f.state.dirtyCount, 1);
    assert.equal(f.state.scheduled, automatic);
    assert.equal(f.state.analysisClaimed, false);
    assert.equal(f.scheduled.length, automatic ? 2 : 1);
    if (automatic) assert.equal(f.jobs.get(f.state.analysisFunctionId).scheduledTime, time.now + DAY);
    else {
      time.set(time.now + 5 * MINUTE);
      assert.equal((await handlers.requestAnalysis.handler(f.ctx, {})).scheduled, true);
    }
  }
});

test("disabling automatic analysis cancels pending work and permits a fenced manual request", async t => {
  clock(t);
  const f = fixture();
  f.state.scheduled = false;
  await completeScan(f);
  const old = f.scheduled[0], oldFunction = f.state.analysisFunctionId;
  f.setHandlers(scansOff);
  assert.equal((await scansOff.requestAnalysis.handler(f.ctx, {})).scheduled, true);
  assert.equal(f.jobs.get(oldFunction).state.kind, "canceled");
  const current = f.state.analysisRunId;
  await scansOff.runPostScanAnalysis.handler(f.ctx, old[2]);
  await scansOff.runManualAnalysis.handler(f.ctx, { tenantId: f.ctx.tenantId });
  await scansOff.finishManualAnalysis.handler(f.ctx, { tenantId: f.ctx.tenantId, success: true, catalogGeneration: 1 });
  await scansOff.recordAnalysisComplete.handler(f.ctx, { tenantId: f.ctx.tenantId, catalogGeneration: 1, analysisRunId: old[2].analysisRunId });
  assert.equal(f.state.analysisRunId, current);
  assert.equal(f.state.scheduled, true);
  await f.runScheduled(1);
  assert.equal(f.state.scheduled, false);
  assert.equal(f.state.dirtyCount, 0);
});

test("an automatic worker disabled before claim releases its flag without discarding dirty work", async t => {
  clock(t);
  const f = fixture();
  f.state.scheduled = false;
  await completeScan(f);
  f.setHandlers(scansOff);
  await f.runScheduled(0);
  assert.equal(f.state.scheduled, false);
  assert.equal(f.state.analysisFunctionId, undefined);
  assert.equal(f.state.dirtyCount, 1);
  assert.equal(f.scheduled.length, 1);
  assert.equal((await scansOff.requestAnalysis.handler(f.ctx, {})).scheduled, true);
});

test("canceled pending manual work can be replaced and its stale completion cannot release the replacement", async t => {
  clock(t);
  const f = fixture();
  f.state.scheduled = false;
  await scans.requestAnalysis.handler(f.ctx, {});
  const old = f.scheduled[0];
  await f.ctx.scheduler.cancel(old[3]);
  assert.equal((await scans.requestAnalysis.handler(f.ctx, {})).scheduled, true);
  assert.notEqual(f.state.analysisRunId, old[2].analysisRunId);
  const current = structuredClone(f.state);
  await scans.finishManualAnalysis.handler(f.ctx, { ...old[2], success: true, catalogGeneration: 1 });
  await scans.restoreAnalysisAfterFailure.handler(f.ctx, { ...old[2], claimedDirtyCount: 100 });
  assert.deepEqual(f.state, current);
  assert.equal(await scans.captureAnalysisGeneration.handler(f.ctx, { tenantId: f.ctx.tenantId }), null);
});

test("a hard-failed claimed worker is recovered even after it consumed its dirty count", async t => {
  const time = clock(t), f = fixture(2, 1);
  f.state.scheduled = false;
  await completeScan(f);
  const job = f.jobs.get(f.state.analysisFunctionId);
  Object.assign(f.state, { analysisClaimed: true, dirtyCount: 0, lastRunAt: time.now });
  job.state = { kind: "failed" };
  await completeScan(f);
  assert.equal(f.state.dirtyCount, 1);
  assert.equal(f.state.scheduled, true);
  assert.equal(f.state.analysisClaimed, false);
  assert.equal(f.scheduled.length, 2);
  assert.equal(f.jobs.get(f.state.analysisFunctionId).scheduledTime, time.now + DAY);
});

test("canceling an active owner cannot overlap another run, and an orphan remains repairable", async t => {
  const time = clock(t), f = fixture();
  f.state.scheduled = false;
  await scans.requestAnalysis.handler(f.ctx, {});
  const old = f.scheduled[0];
  await scans.claimManualAnalysisRun.handler(f.ctx, old[2]);
  await f.ctx.scheduler.cancel(old[3]);
  assert.equal((await scans.requestAnalysis.handler(f.ctx, {})).scheduled, false);
  time.set(time.now + 61 * MINUTE);
  assert.equal((await scans.requestAnalysis.handler(f.ctx, {})).scheduled, true);
  const current = structuredClone(f.state);
  await scans.finishManualAnalysis.handler(f.ctx, { ...old[2], success: true, catalogGeneration: 1 });
  assert.deepEqual(f.state, current);
});
