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
  scans: Object.fromEntries(["captureAnalysisGeneration", "finishManualAnalysis", "claimAnalysisRun", "recordAnalysisComplete", "restoreAnalysisAfterFailure", "runPostScanAnalysis"]
    .map(name => [name, name])),
  duplicates: { runDuplicateDetection: "runDuplicateDetection" },
  recommendations: { generateRecommendations: "generateRecommendations" },
};
function load(filename) {
  filename = path.resolve(filename);
  if (modules.has(filename)) return modules.get(filename);
  const exports = {};
  modules.set(filename, exports);
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
    if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), `${name}.ts`));
    return nodeRequire(name);
  };
  new Function("require", "exports", code)(require, exports);
  return exports;
}
const previousAuto = process.env.DRIVEOS_AUTO_ANALYSIS;
process.env.DRIVEOS_AUTO_ANALYSIS = "true";
const scans = load(path.join(repository, "convex/scans.ts"));
if (previousAuto === undefined) delete process.env.DRIVEOS_AUTO_ANALYSIS;
else process.env.DRIVEOS_AUTO_ANALYSIS = previousAuto;
const duplicates = load(path.join(repository, "convex/duplicates.ts"));
const recommendations = load(path.join(repository, "convex/recommendations.ts"));
const { catalogAnalysisIsCurrent } = load(path.join(repository, "convex/catalogAnalysis.ts"));

function fixture(generation = 1, analyzedGeneration = 0) {
  const tenantId = "tenant-a";
  const state = { _id: "analysisState:1", tenantId, catalogGeneration: generation, analyzedGeneration, dirtyCount: 1, scheduled: true, lastRunAt: 0 };
  const live = { _id: "files:1", tenantId, name: "live.mov", path: "/review/live.mov", sizeBytes: 10, source: "local" };
  const deleted = { ...live, _id: "files:2", path: "/review/removed.mov", deletedAt: 123 };
  const cluster = { _id: "duplicateClusters:1", tenantId, status: "open", fileIds: [live._id, deleted._id], recommendedKeepFileId: live._id, wastedBytes: 10 };
  const rec = { _id: "recommendations:1", tenantId, status: "open", affectedFileIds: [deleted._id], affectedBytes: 10 };
  const tables = { analysisState: [state], files: [live, deleted], duplicateClusters: [cluster], recommendations: [rec], auditLogs: [] };
  const documents = new Map(Object.values(tables).flat().map(row => [row._id, row]));
  const reads = [], scheduled = [];
  const db = {
    normalizeId: (table, id) => id.startsWith(`${table}:`) ? id : null,
    get: async id => structuredClone(documents.get(id) ?? null),
    patch: async (id, patch) => Object.assign(documents.get(id), structuredClone(patch)),
    insert: async (table, row) => { tables[table].push(row); return `${table}:${tables[table].length}`; },
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
  const ctx = { tenantId, db, scheduler: { runAfter: async (...args) => scheduled.push(args) } };
  ctx.runQuery = async (reference, args) => scans[reference].handler(ctx, args);
  ctx.runMutation = async (reference, args) => scans[reference].handler(ctx, args);
  ctx.runAction = async () => {};
  return { ctx, state, cluster, rec, live, deleted, reads, scheduled };
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
    assert.equal(f.state.scheduled, false);
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
    assert.equal(f.state.scheduled, false);
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
