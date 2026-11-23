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
  duplicates: Object.fromEntries(["runDuplicateDetection", "upsertClusters", "pageClusterKeys", "deleteClusters"].map(name => [name, name])),
  recommendations: Object.fromEntries(["generateRecommendations", "listProjectsForAnalysis", "listOpenExactClusters", "replaceOpenRecommendations"].map(name => [name, name])),
  files: { pageForAnalysis: "pageForAnalysis" },
  settings: { forAnalysis: "forAnalysis" },
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
const files = load(path.join(repository, "convex/files.ts"));
const settings = load(path.join(repository, "convex/settings.ts"));
const projects = load(path.join(repository, "convex/projects.ts"));
const { catalogAnalysisIsCurrent } = load(path.join(repository, "convex/catalogAnalysis.ts"));

function fixture(generation = 1, analyzedGeneration = 0, handlers = scans) {
  const tenantId = "tenant-a";
  const state = { _id: "analysisState:1", tenantId, catalogGeneration: generation, analyzedGeneration, dirtyCount: 1, scheduled: true, lastRunAt: 0 };
  const live = { _id: "files:1", tenantId, name: "live.mov", path: "/review/live.mov", sizeBytes: 10, source: "local" };
  const deleted = { ...live, _id: "files:2", path: "/review/removed.mov", deletedAt: 123 };
  const cluster = { _id: "duplicateClusters:1", tenantId, status: "open", fileIds: [live._id, deleted._id], recommendedKeepFileId: live._id, wastedBytes: 10 };
  const rec = { _id: "recommendations:1", tenantId, status: "open", affectedFileIds: [deleted._id], affectedBytes: 10 };
  const session = { _id: "scanSessions:1", tenantId, machineId: "machines:1", rootPath: "/review", status: "running", filesScanned: 0, bytesScanned: 0 };
  const tables = { analysisState: [state], files: [live, deleted], duplicateClusters: [cluster], recommendations: [rec], auditLogs: [], scanSessions: [session], projects: [], workspaceSettings: [] };
  const documents = new Map(Object.values(tables).flat().map(row => [row._id, row]));
  const reads = [], scheduled = [];
  const jobs = new Map();
  const db = {
    normalizeId: (table, id) => id.startsWith(`${table}:`) ? id : null,
    get: async id => structuredClone(documents.get(id) ?? null),
    patch: async (id, patch) => Object.assign(documents.get(id), structuredClone(patch)),
    delete: async id => {
      const row = documents.get(id), table = id.split(":")[0];
      tables[table].splice(tables[table].indexOf(row), 1);
      documents.delete(id);
    },
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
        paginate: async ({ cursor, numItems }) => {
          const rows = await chain.take(Infinity), offset = Number(cursor || 0);
          return { page: rows.slice(offset, offset + numItems), isDone: offset + numItems >= rows.length, continueCursor: String(offset + numItems) };
        },
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
  return { ctx, state, cluster, rec, live, deleted, session, tables, documents, reads, scheduled, jobs,
    setHandlers: next => { handlers = next; },
    async runScheduled(index) {
      const [, reference, args, id] = scheduled[index], job = jobs.get(id);
      job.state = { kind: "inProgress" };
      try { await handlers[reference].handler(ctx, args); if (job.state.kind !== "canceled") job.state = { kind: "success" }; }
      catch (error) { job.state = { kind: "failed" }; throw error; }
    },
  };
}

function useActualAnalysisConsumers(f, handlers = scansOff) {
  const actions = [], catalogReads = [];
  Object.assign(f.live, { classification: "CACHE", modifiedAtFile: 123, storageTier: "hot", riskLevel: "green" });
  const dispatch = async (reference, args) => {
    const definition = handlers[reference] || duplicates[reference] || recommendations[reference] || files[reference] || settings[reference];
    assert.ok(definition, `Unknown analysis function ${reference}`);
    return definition.handler(f.ctx, args);
  };
  f.ctx.runQuery = async (reference, args) => {
    if (reference === "pageForAnalysis") catalogReads.push(Date.now());
    return dispatch(reference, args);
  };
  f.ctx.runMutation = dispatch;
  f.ctx.runAction = async (reference, args) => {
    actions.push([reference, args, Date.now()]);
    return dispatch(reference, args);
  };
  return { actions, catalogReads };
}

function addProject(f, patch = {}) {
  const project = { _id: "projects:1", tenantId: f.ctx.tenantId, ownerId: "qa", name: "QA Project",
    status: "active", tier: "warm", storageHealthScore: 50, cleanupRules: { ...settings.DEFAULT_CLEANUP_RULES }, ...patch };
  f.tables.projects.push(project);
  f.documents.set(project._id, project);
  return project;
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

function successfulSession(f, id = f.session._id) {
  const session = { ...f.session, _id: id, status: "completed", completedAt: Date.now(), analysisRequested: undefined };
  if (id === f.session._id) Object.assign(f.session, session);
  else f.tables.scanSessions.push(session);
  f.documents.set(id, id === f.session._id ? f.session : session);
  return id === f.session._id ? f.session : session;
}
function requestScanAnalysis(f, session = f.session, handlers = scansOff) {
  return handlers.requestScanAnalysis.handler(f.ctx, {
    tenantId: f.ctx.tenantId, machineId: "machines:1", sessionId: session._id,
  });
}

test("explicit completed scans analyze empty and unchanged catalogs with automatic analysis disabled", async t => {
  clock(t);
  for (const empty of [false, true]) {
    const f = fixture(0, 0, scansOff);
    f.state.scheduled = false;
    f.state.dirtyCount = 0;
    if (empty) f.tables.files.length = 0;
    successfulSession(f);
    assert.equal((await requestScanAnalysis(f)).scheduled, true);
    assert.equal((await scansOff.analysisStatus.handler(f.ctx, {})).status, "queued");
    const calls = [];
    f.ctx.runAction = async (reference, args) => {
      calls.push(reference);
      assert.equal((await scansOff.analysisStatus.handler(f.ctx, {})).status, "running");
      assert.equal(args.maxFiles, 250000);
    };
    await f.runScheduled(0);
    assert.deepEqual(calls, ["runDuplicateDetection", "generateRecommendations"]);
    const status = await scansOff.analysisStatus.handler(f.ctx, {});
    assert.equal(status.status, "completed");
    assert.equal(status.catalogCurrent, true);
    assert.equal(status.error, null);
    assert.equal(status.completedAt, Date.now());
    assert.equal(f.state.scheduled, false);
    assert.equal(f.state.scanAnalysisResolvedVersion, 1);
    assert.equal((await requestScanAnalysis(f)).status, "completed");
    // A delayed receipt retry must not arm another run after catalog changes.
    f.state.catalogGeneration++;
    assert.equal((await requestScanAnalysis(f)).status, "stale");
    assert.equal(f.scheduled.length, 1);
  }
});

test("repeated unchanged scans reuse recent actual analysis without catalog reads or fabricated worker timestamps", async t => {
  const time = clock(t), f = fixture(12, 12, scansOff);
  Object.assign(f.state, { scheduled: false, dirtyCount: 0 });
  const { actions, catalogReads } = useActualAnalysisConsumers(f);
  successfulSession(f);
  await requestScanAnalysis(f);
  time.set(time.now + 1000);
  await f.runScheduled(0);
  const first = await scansOff.analysisStatus.handler(f.ctx, {});
  assert.equal(actions.length, 2);
  assert.equal(catalogReads.length, 2);
  assert.equal(first.validatedAt, first.completedAt);

  time.set(time.now + 1000);
  const secondSession = successfulSession(f, "scanSessions:2");
  const runId = f.state.analysisRunId;
  assert.equal((await scansOff.requestAnalysis.handler(f.ctx, {})).scheduled, false);
  const reused = await requestScanAnalysis(f, secondSession);
  assert.equal(reused.scheduled, false);
  assert.equal(reused.status, "completed");
  assert.match(reused.message, /reused/);
  const second = await scansOff.analysisStatus.handler(f.ctx, {});
  assert.equal(second.lastRunAt, first.lastRunAt);
  assert.equal(second.completedAt, first.completedAt);
  assert.equal(second.validatedAt, secondSession.completedAt);
  assert.equal(f.state.analysisRunId, runId);
  assert.equal(f.state.scanAnalysisResolvedVersion, 2);
  assert.equal(secondSession.analysisRequested, true);
  assert.equal(f.scheduled.length, 1);
  assert.equal(actions.length, 2);
  assert.equal(catalogReads.length, 2);
  assert.equal((await recommendations.list.handler(f.ctx, {})).length, 1);

  // Reuse must not slide the freshness window indefinitely.
  time.set(first.completedAt + 5 * MINUTE);
  const thirdSession = successfulSession(f, "scanSessions:3");
  assert.equal((await requestScanAnalysis(f, thirdSession)).scheduled, true);
  assert.equal(f.scheduled.length, 2);
  assert.equal(f.scheduled[1][0], 1000);
  // Replayed receipts never arm work even if a later catalog edit invalidates it.
  f.state.catalogGeneration++;
  assert.equal((await requestScanAnalysis(f, secondSession)).status, "queued");
  assert.equal(f.scheduled.length, 2);
});

test("changed scans coalesce during the cooldown and automatically analyze the latest generation", async t => {
  const time = clock(t), f = fixture(1, 0, scansOff);
  f.state.scheduled = false;
  const { actions, catalogReads } = useActualAnalysisConsumers(f);
  successfulSession(f);
  await requestScanAnalysis(f);
  time.set(time.now + 1000);
  await f.runScheduled(0);
  const firstStartedAt = f.state.lastRunAt;

  time.set(time.now + 1000);
  f.state.catalogGeneration++;
  f.state.dirtyCount++;
  assert.equal((await requestScanAnalysis(f, successfulSession(f, "scanSessions:2"))).scheduled, true);
  const pending = f.jobs.get(f.state.analysisFunctionId);
  assert.equal(pending.scheduledTime, firstStartedAt + 5 * MINUTE);
  assert.equal((await scansOff.analysisStatus.handler(f.ctx, {})).status, "queued");
  assert.equal(catalogAnalysisIsCurrent(f.state), false);
  assert.deepEqual(await recommendations.list.handler(f.ctx, {}), []);
  assert.equal(actions.length, 2);

  f.state.catalogGeneration++;
  f.state.dirtyCount++;
  assert.equal((await requestScanAnalysis(f, successfulSession(f, "scanSessions:3"))).scheduled, false);
  assert.equal(f.scheduled.length, 2);
  assert.equal(f.jobs.get(f.state.analysisFunctionId).scheduledTime, pending.scheduledTime);
  time.set(pending.scheduledTime);
  await f.runScheduled(1);
  assert.equal(actions.length, 4);
  assert.equal(catalogReads.length, 4);
  assert.equal(f.state.analyzedGeneration, 3);
  assert.equal(f.state.scanAnalysisResolvedVersion, 3);
  assert.equal(f.state.scheduled, false);
  assert.equal((await scansOff.analysisStatus.handler(f.ctx, {})).status, "completed");
});

test("new scan retries after failed analysis wait for the tenant cooldown even when the catalog was unchanged", async t => {
  const time = clock(t);
  for (const analyzedGeneration of [0, 1]) {
    const f = fixture(1, analyzedGeneration, scansOff);
    f.state.scheduled = false;
    successfulSession(f);
    await requestScanAnalysis(f);
    time.set(time.now + 1000);
    f.ctx.runAction = async () => { throw new Error("fixture analysis failure"); };
    await assert.rejects(f.runScheduled(0), /fixture analysis failure/);
    const failedAt = f.state.lastRunAt;
    assert.equal(f.state.analysisStatus, "failed");
    assert.equal((await requestScanAnalysis(f)).status, "failed");
    assert.equal(f.scheduled.length, 1);

    time.set(time.now + 1000);
    const retry = successfulSession(f, "scanSessions:2");
    assert.equal((await requestScanAnalysis(f, retry)).scheduled, true);
    const pending = f.jobs.get(f.state.analysisFunctionId);
    assert.equal(pending.scheduledTime, failedAt + 5 * MINUTE);
    assert.equal((await requestScanAnalysis(f, retry)).scheduled, false);
    assert.equal(f.scheduled.length, 2);
    f.ctx.runAction = async () => {};
    time.set(pending.scheduledTime);
    await f.runScheduled(1);
    assert.equal(f.state.analysisStatus, "completed");
    assert.equal(f.state.scanAnalysisResolvedVersion, 2);
  }
});

test("project delivery invalidates recent results and an unchanged scan queues fresh proxy recommendations", async t => {
  const time = clock(t), f = fixture(1, 0, scansOff);
  f.state.scheduled = false;
  useActualAnalysisConsumers(f);
  const project = addProject(f);
  Object.assign(f.live, { classification: "PROXY", projectId: project._id, path: "/review/04_PROXIES/proxy.mov" });
  successfulSession(f);
  await requestScanAnalysis(f);
  time.set(time.now + 1000);
  await f.runScheduled(0);
  assert.equal((await recommendations.list.handler(f.ctx, {})).length, 0);
  const firstStartedAt = f.state.lastRunAt;

  await projects.updateStatus.handler(f.ctx, { projectId: project._id, status: "delivered" });
  assert.equal(f.state.catalogGeneration, 2);
  assert.equal(catalogAnalysisIsCurrent(f.state), false);
  assert.equal((await scansOff.analysisStatus.handler(f.ctx, {})).status, "stale");
  // An identical status write does not invalidate the same inputs twice.
  await projects.updateStatus.handler(f.ctx, { projectId: project._id, status: "delivered" });
  assert.equal(f.state.catalogGeneration, 2);

  time.set(time.now + 1000);
  assert.equal((await requestScanAnalysis(f, successfulSession(f, "scanSessions:2"))).scheduled, true);
  assert.equal(f.jobs.get(f.state.analysisFunctionId).scheduledTime, firstStartedAt + 5 * MINUTE);
  time.set(f.jobs.get(f.state.analysisFunctionId).scheduledTime);
  await f.runScheduled(1);
  assert.equal(f.state.analyzedGeneration, 2);
  assert.ok((await recommendations.list.handler(f.ctx, {})).some(rec => rec.type === "delete_proxies"));
});

test("cleanup rule changes invalidate cached suggestions while retention and identical rules preserve them", async t => {
  const time = clock(t), f = fixture(1, 0, scansOff);
  f.state.scheduled = false;
  useActualAnalysisConsumers(f);
  successfulSession(f);
  await requestScanAnalysis(f);
  time.set(time.now + 1000);
  await f.runScheduled(0);
  assert.ok((await recommendations.list.handler(f.ctx, {})).some(rec => rec.type === "delete_cache"));
  const firstStartedAt = f.state.lastRunAt;

  await settings.update.handler(f.ctx, { retentionDays: 21 });
  await settings.update.handler(f.ctx, { cleanupRules: { ...settings.DEFAULT_CLEANUP_RULES } });
  assert.equal(f.state.catalogGeneration, 1);
  assert.equal(catalogAnalysisIsCurrent(f.state), true);
  await settings.update.handler(f.ctx, { cleanupRules: { ...settings.DEFAULT_CLEANUP_RULES, cacheDelete: false } });
  assert.equal(f.state.catalogGeneration, 2);
  assert.equal(catalogAnalysisIsCurrent(f.state), false);
  assert.deepEqual(await recommendations.list.handler(f.ctx, {}), []);

  time.set(time.now + 1000);
  assert.equal((await requestScanAnalysis(f, successfulSession(f, "scanSessions:2"))).scheduled, true);
  assert.equal(f.jobs.get(f.state.analysisFunctionId).scheduledTime, firstStartedAt + 5 * MINUTE);
  time.set(f.jobs.get(f.state.analysisFunctionId).scheduledTime);
  await f.runScheduled(1);
  assert.equal(f.state.analyzedGeneration, 2);
  assert.deepEqual(await recommendations.list.handler(f.ctx, {}), []);
  await settings.update.handler(f.ctx, { cleanupRules: { ...settings.DEFAULT_CLEANUP_RULES, cacheDelete: false, proxyDelete: false } });
  assert.equal(f.state.catalogGeneration, 3);
});

test("project creation and health changes fence analysis without invalidating unrelated statistics", async () => {
  for (const missingState of [false, true]) {
    const f = fixture(8, 8, scansOff);
    Object.assign(f.state, { dirtyCount: 0, scheduled: false });
    if (missingState) {
      f.tables.analysisState.length = 0;
      f.documents.delete(f.state._id);
    }
    const projectId = await projects.create.handler(f.ctx, {
      name: "New project", client: "QA", ownerId: "qa", status: "delivered", tier: "hot",
    });
    const state = f.tables.analysisState[0];
    assert.equal(state.catalogGeneration, missingState ? 1 : 9);
    assert.equal(state.dirtyCount, 1);
    assert.equal(catalogAnalysisIsCurrent(state), false);
    assert.ok(f.documents.has(projectId));
    assert.equal(f.reads.includes("files"), false);
  }

  const f = fixture(8, 8, scansOff), project = addProject(f, { status: "delivered" });
  Object.assign(f.state, { dirtyCount: 0, scheduled: false });
  const stats = { projectId: project._id, totalBytes: 100, duplicateBytes: 20, safeCleanupBytes: 30, riskyBytes: 5, storageHealthScore: 50 };
  await projects.updateStats.handler(f.ctx, stats);
  assert.equal(f.state.catalogGeneration, 8);
  await projects.updateStats.handler(f.ctx, { ...stats, storageHealthScore: 80 });
  assert.equal(f.state.catalogGeneration, 9);
  assert.equal(f.state.dirtyCount, 1);
});

test("in-flight analysis cannot publish over project or cleanup rule changes and follows up after cooldown", async t => {
  const time = clock(t);
  for (const change of ["project", "rules"]) {
    const f = fixture(5, 4, scansOff);
    f.state.scheduled = false;
    const project = addProject(f);
    successfulSession(f);
    await requestScanAnalysis(f);
    time.set(time.now + 1000);
    f.ctx.runAction = async reference => {
      if (reference !== "generateRecommendations") return;
      if (change === "project") await projects.updateStatus.handler(f.ctx, { projectId: project._id, status: "delivered" });
      else await settings.update.handler(f.ctx, { cleanupRules: { ...settings.DEFAULT_CLEANUP_RULES, proxyDelete: false } });
    };
    await f.runScheduled(0);
    assert.equal(f.state.catalogGeneration, 6);
    assert.equal(f.state.analyzedGeneration, 4);
    assert.equal(catalogAnalysisIsCurrent(f.state), false);
    assert.deepEqual(await recommendations.list.handler(f.ctx, {}), []);
    assert.equal(f.state.scanAnalysisFollowUps, 0);
    assert.equal(f.scheduled.length, 2);
    assert.equal(f.jobs.get(f.state.analysisFunctionId).scheduledTime, f.state.lastRunAt + 5 * MINUTE);
    f.ctx.runAction = async () => {};
    time.set(f.jobs.get(f.state.analysisFunctionId).scheduledTime);
    await f.runScheduled(1);
    assert.equal(f.state.analyzedGeneration, 6);
    assert.equal(f.state.scheduled, false);
    assert.equal(f.scheduled.length, 2);
  }
});

test("scan analysis rejects unknown, foreign, other-machine and unfinished scan receipts", async () => {
  for (const patch of [{ _id: "scanSessions:missing" }, { tenantId: "tenant-other" }, { machineId: "machines:other" },
    { status: "failed" }, { status: "partial" }, { status: "running" }]) {
    const f = fixture(1, 0, scansOff);
    f.state.scheduled = false;
    successfulSession(f);
    const args = { sessionId: f.session._id, tenantId: f.ctx.tenantId, machineId: "machines:1" };
    if (patch._id) args.sessionId = patch._id;
    else Object.assign(f.session, patch);
    await assert.rejects(scansOff.requestScanAnalysis.handler(f.ctx, args), /Unknown scan|successfully completed/);
    assert.equal(f.session.analysisRequested, undefined);
    assert.equal(f.scheduled.length, 0);
  }
});

test("concurrent completed roots share one pending or current-generation running analyzer", async t => {
  clock(t);
  for (const active of [false, true]) {
    const f = fixture(2, 0, scansOff);
    f.state.scheduled = false;
    successfulSession(f);
    const other = successfulSession(f, "scanSessions:2");
    assert.equal((await requestScanAnalysis(f)).scheduled, true);
    if (!active) assert.equal((await requestScanAnalysis(f, other)).scheduled, false);
    else f.ctx.runAction = async reference => {
      if (reference === "runDuplicateDetection") assert.equal((await requestScanAnalysis(f, other)).status, "running");
    };
    await f.runScheduled(0);
    assert.equal(f.state.scanAnalysisRequestVersion, 2);
    assert.equal(f.state.scanAnalysisResolvedVersion, 2);
    assert.equal(f.state.scheduled, false);
    assert.equal(f.scheduled.length, 1);
  }
});

test("catalog changes during explicit analysis get one bounded follow-up without another scan", async t => {
  const time = clock(t);
  const f = fixture(3, 0, scansOff);
  f.state.scheduled = false;
  successfulSession(f);
  await requestScanAnalysis(f);
  f.ctx.runAction = async reference => {
    if (reference !== "runDuplicateDetection") return;
    f.state.catalogGeneration++;
    f.state.dirtyCount++;
    const other = successfulSession(f, "scanSessions:2");
    assert.equal((await requestScanAnalysis(f, other)).scheduled, false);
  };
  await f.runScheduled(0);
  assert.equal(f.scheduled.length, 2);
  assert.equal(f.scheduled[1][1], "runManualAnalysis");
  assert.equal(f.jobs.get(f.state.analysisFunctionId).scheduledTime, f.state.lastRunAt + 5 * MINUTE);
  assert.equal(f.state.scanAnalysisFollowUps, 0);
  assert.equal((await scansOff.analysisStatus.handler(f.ctx, {})).status, "queued");
  assert.equal(catalogAnalysisIsCurrent(f.state), false);
  f.ctx.runAction = async () => {};
  time.set(f.jobs.get(f.state.analysisFunctionId).scheduledTime);
  await f.runScheduled(1);
  assert.equal(f.state.analyzedGeneration, 4);
  assert.equal(f.state.scanAnalysisResolvedVersion, 2);
  assert.equal(f.state.scheduled, false);
  assert.equal(f.scheduled.length, 2);
});

test("continuous catalog churn stops explicit follow-ups with a visible stale result", async t => {
  clock(t);
  for (const handlers of [scansOff, scans]) {
    const f = fixture(1, 0, handlers);
    f.state.scheduled = false;
    successfulSession(f);
    await requestScanAnalysis(f, f.session, handlers);
    f.ctx.runAction = async reference => { if (reference === "runDuplicateDetection") { f.state.catalogGeneration++; f.state.dirtyCount++; } };
    await f.runScheduled(0);
    await f.runScheduled(1);
    assert.equal(f.scheduled.length, 2);
    assert.equal(f.state.scheduled, false);
    const status = await handlers.analysisStatus.handler(f.ctx, {});
    assert.equal(status.status, "stale");
    assert.equal(status.catalogCurrent, false);
    assert.match(status.error, /catalog changed/i);
    assert.equal((await requestScanAnalysis(f, f.session, handlers)).status, "stale");
    assert.equal(f.scheduled.length, 2);
  }
});

test("oversized explicit analysis fails visibly without unbounded automatic retries", async t => {
  clock(t);
  for (const handlers of [scansOff, scans]) {
    const f = fixture(1, 0, handlers);
    f.state.scheduled = false;
    successfulSession(f);
    await requestScanAnalysis(f, f.session, handlers);
    const query = f.ctx.runQuery;
    f.ctx.runQuery = async (reference, args) => reference === "pageForAnalysis"
      ? { files: new Array(250001).fill(f.live), isDone: true, continueCursor: "end" }
      : query(reference, args);
    f.ctx.runAction = async (_reference, args) => {
      assert.equal(args.maxFiles, 250000);
      return duplicates.runDuplicateDetection.handler(f.ctx, args);
    };
    await assert.rejects(f.runScheduled(0), /exceeds the explicit analysis limit/);
    const status = await handlers.analysisStatus.handler(f.ctx, {});
    assert.equal(status.status, "failed");
    assert.match(status.error, /250000/);
    assert.equal(f.state.scheduled, false);
    assert.equal(f.scheduled.length, 1);
    assert.equal(f.state.scanAnalysisResolvedVersion, 1);
    assert.equal(catalogAnalysisIsCurrent(f.state), false);
    assert.equal((await requestScanAnalysis(f, f.session, handlers)).status, "failed");
    assert.equal(f.scheduled.length, 1);
  }
});

test("explicit scan analysis replaces a pending daily timer and fences its stale completion", async t => {
  const time = clock(t), f = fixture(1, 0, scans);
  f.state.scheduled = false;
  f.state.lastRunAt = time.now;
  await completeScan(f);
  const old = f.scheduled[0];
  successfulSession(f);
  assert.equal((await requestScanAnalysis(f, f.session, scans)).scheduled, true);
  assert.equal(f.jobs.get(old[3]).state.kind, "canceled");
  assert.equal(f.scheduled[1][1], "runManualAnalysis");
  const state = structuredClone(f.state);
  await scans.recordAnalysisComplete.handler(f.ctx, { ...old[2], catalogGeneration: 1 });
  assert.deepEqual(f.state, state);
  const calls = [];
  f.ctx.runAction = async (reference, args) => { calls.push(reference); assert.equal(args.maxFiles, 250000); };
  await f.runScheduled(1);
  assert.equal(f.state.scheduled, false);
  assert.deepEqual(calls, ["runDuplicateDetection", "generateRecommendations"]);
  assert.equal(f.scheduled.length, 2);
});

test("analysis status exposes stopped and missing scheduler owners without mutating state", async t => {
  clock(t);
  for (const kind of ["failed", "canceled", "success", "missing"]) {
    const f = fixture(1, 0, scansOff);
    f.state.scheduled = false;
    successfulSession(f);
    await requestScanAnalysis(f);
    if (kind === "missing") f.jobs.delete(f.state.analysisFunctionId);
    else f.jobs.get(f.state.analysisFunctionId).state = { kind };
    const before = structuredClone(f.state);
    const status = await scansOff.analysisStatus.handler(f.ctx, {});
    assert.equal(status.status, "failed");
    assert.equal(status.catalogCurrent, false);
    assert.match(status.error, /worker stopped/);
    assert.deepEqual(f.state, before);
  }
});

test("a first empty scan creates its bounded analysis state without requiring existing catalog rows", async t => {
  clock(t);
  const f = fixture(0, 0, scansOff);
  f.tables.analysisState.length = 0;
  f.documents.delete(f.state._id);
  f.tables.files.length = 0;
  successfulSession(f);
  assert.equal((await requestScanAnalysis(f)).status, "queued");
  await f.runScheduled(0);
  const status = await scansOff.analysisStatus.handler(f.ctx, {});
  assert.equal(status.status, "completed");
  assert.equal(status.catalogCurrent, true);
  assert.equal(f.scheduled.length, 1);
});

test("releasing a disabled legacy automatic owner preserves a pending explicit scan intent", async t => {
  clock(t);
  const f = fixture(1, 0, scansOff);
  Object.assign(f.state, { scanAnalysisRequestVersion: 1, scanAnalysisFollowUps: 1 });
  assert.equal((await scansOff.claimAnalysisRun.handler(f.ctx, { tenantId: f.ctx.tenantId })).shouldRun, false);
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.scheduled[0][1], "runManualAnalysis");
  await f.runScheduled(0);
  assert.equal(f.state.scheduled, false);
  assert.equal(f.state.scanAnalysisResolvedVersion, 1);
});
