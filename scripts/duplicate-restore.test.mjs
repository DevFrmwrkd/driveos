import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// Quarantine -> analysis -> restore -> scheduled analysis through the actual
// Convex handlers, scheduler bookkeeping and an isolated in-memory database. No
// deployment or physical files are touched.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const modules = new Map();
const register = definition => definition;
// Function references resolve to "module:name" so the action context below can
// dispatch runQuery/runMutation/runAction and scheduled jobs to loaded handlers.
const internal = new Proxy({}, { get: (_, module) => new Proxy({}, { get: (_, name) => `${String(module)}:${String(name)}` }) });
function load(filename) {
  filename = path.resolve(filename);
  if (modules.has(filename)) return modules.get(filename);
  const exports = {};
  modules.set(filename, exports);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const require = name => {
    if (name.endsWith("/_generated/server")) return Object.fromEntries(["mutation", "query", "internalMutation", "internalQuery", "internalAction"].map(kind => [kind, register]));
    if (name.endsWith("/_generated/api")) return { internal };
    if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), `${name}.ts`));
    return nodeRequire(name);
  };
  new Function("require", "exports", code)(require, exports);
  return exports;
}
// Restore refresh must not depend on the opt-in automatic analyzer.
const previousAuto = process.env.DRIVEOS_AUTO_ANALYSIS;
process.env.DRIVEOS_AUTO_ANALYSIS = "false";
const handlers = {
  scans: load(path.join(repository, "convex/scans.ts")),
  cleanup: load(path.join(repository, "convex/cleanup.ts")),
  duplicates: load(path.join(repository, "convex/duplicates.ts")),
  files: load(path.join(repository, "convex/files.ts")),
  recommendations: load(path.join(repository, "convex/recommendations.ts")),
  settings: load(path.join(repository, "convex/settings.ts")),
};
if (previousAuto === undefined) delete process.env.DRIVEOS_AUTO_ANALYSIS;
else process.env.DRIVEOS_AUTO_ANALYSIS = previousAuto;
const { cleanup, duplicates, scans } = handlers;
const hash = "b".repeat(64);
const token = "duplicate-restore-claim-token-12345";
const MINUTE = 60_000;

// One database and scheduler shared by every workspace created from it.
function store(t) {
  let now = 2_000_000_000_000;
  t.mock.method(Date, "now", () => now);
  const clock = { get now() { return now; }, set(value) { now = value; }, advance(ms) { now += ms; } };
  let sequence = 0;
  const tables = new Map();
  const documents = new Map();
  const jobs = new Map();
  const add = (table, values) => {
    const document = { ...values, _id: `${table}:${++sequence}`, _creationTime: sequence };
    if (!tables.has(table)) tables.set(table, []);
    tables.get(table).push(document);
    documents.set(document._id, document);
    return document;
  };
  const value = (expression, row) => typeof expression === "function" ? expression(row) : expression;
  const filters = {
    field: name => row => name.split(".").reduce((entry, key) => entry?.[key], row),
    eq: (a, b) => row => value(a, row) === value(b, row),
    neq: (a, b) => row => value(a, row) !== value(b, row),
    and: (...terms) => row => terms.every(term => value(term, row)),
  };
  const db = {
    normalizeId: (table, id) => typeof id === "string" && id.startsWith(`${table}:`) ? id : null,
    get: async id => structuredClone(documents.get(id) ?? null),
    insert: async (table, values) => add(table, values)._id,
    patch: async (id, patch) => {
      const doc = documents.get(id);
      assert.ok(doc, `Unknown fixture document ${id}`);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete doc[key]; else doc[key] = structuredClone(value);
      }
    },
    delete: async id => {
      const doc = documents.get(id);
      if (!doc) return;
      documents.delete(id);
      const table = id.split(":")[0];
      tables.set(table, tables.get(table).filter(row => row !== doc));
    },
    system: { get: async id => structuredClone(jobs.get(id) ?? null) },
    query(table) {
      const predicates = [];
      let descending = false;
      const chain = {
        withIndex(_name, configure) {
          const index = {};
          for (const op of ["eq", "gt", "lte"]) index[op] = (field, expected) => {
            predicates.push(row => op === "eq" ? row[field] === expected : op === "gt" ? row[field] > expected : row[field] <= expected);
            return index;
          };
          if (configure) configure(index);
          return chain;
        },
        filter(configure) { predicates.push(configure(filters)); return chain; },
        order(direction) { descending = direction === "desc"; return chain; },
        async take(count) {
          const rows = [...(tables.get(table) ?? [])].filter(row => predicates.every(predicate => predicate(row)))
            .sort((a, b) => (a.createdAt ?? a._creationTime) - (b.createdAt ?? b._creationTime));
          return structuredClone((descending ? rows.reverse() : rows).slice(0, count));
        },
        async first() { return (await chain.take(1))[0] ?? null; },
        async collect() { return chain.take(Infinity); },
        async paginate() { return { page: await chain.take(Infinity), isDone: true, continueCursor: "" }; },
      };
      return chain;
    },
  };
  const scheduler = {
    runAfter: async (delay, reference, args) => {
      const id = `_scheduled_functions:${++sequence}`;
      jobs.set(id, { _id: id, name: reference, args: [structuredClone(args)], delay,
        scheduledTime: now + delay, state: { kind: "pending" } });
      return id;
    },
    cancel: async id => { jobs.get(id).state = { kind: "canceled" }; },
  };
  // Scheduled and internal functions run without a signed-in caller.
  const system = { db, scheduler, auth: { getUserIdentity: async () => null } };
  const dispatch = (reference, args) => {
    const [module, name] = reference.split(":");
    assert.ok(handlers[module]?.[name], `Unknown function ${reference}`);
    return handlers[module][name].handler(system, args);
  };
  Object.assign(system, { runQuery: dispatch, runMutation: dispatch, runAction: dispatch });
  const rows = table => tables.get(table) ?? [];
  const pending = () => [...jobs.values()].filter(job => job.state.kind === "pending");
  // Execute due work in deadline order, advancing the clock to each deadline.
  async function runScheduled(limit = 8) {
    const ran = [];
    for (let i = 0; i < limit; i++) {
      const job = pending().sort((a, b) => a.scheduledTime - b.scheduledTime)[0];
      if (!job) return ran;
      if (job.scheduledTime > now) now = job.scheduledTime;
      job.state = { kind: "inProgress" };
      try {
        await dispatch(job.name, job.args[0]);
        if (job.state.kind !== "canceled") job.state = { kind: "success" };
        ran.push({ job });
      } catch (error) {
        job.state = { kind: "failed" };
        ran.push({ job, error });
      }
    }
    throw new Error("Scheduled work did not settle within the bounded queue.");
  }
  return { db, add, rows, jobs, pending, runScheduled, clock, system, documents };
}

function workspace(s, { tenantId = "tenants:qa", copies = 2, cluster: clusterValues = {} } = {}) {
  const { add, rows } = s;
  const machineId = add("machines", { tenantId, name: "Synthetic QA machine" })._id;
  const member = add("teamMembers", { tenantId, email: `qa@${tenantId}.test`, name: "QA", role: "admin" });
  const user = add("users", { tenantId, email: member.email, teamMemberId: member._id });
  const ctx = { db: s.db, scheduler: s.system.scheduler, auth: { getUserIdentity: async () => ({ subject: `${user._id}|session` }) } };
  const scope = { tenantId, machineId };
  // The newest copy wins analysis' trust tie-breaker, so "keep" stays the keep.
  const file = (name, modifiedAtFile) => add("files", { ...scope, path: `/synthetic/review/${name}.mp4`, name: `${name}.mp4`,
    source: "local", sizeBytes: 10, fullHash: hash, riskLevel: "yellow", storageTier: "hot", isRaw: false, isFinal: false,
    classification: "OTHER", modifiedAtFile });
  const keep = file("keep", 9);
  const candidate = file("candidate", 1);
  const others = Array.from({ length: copies - 2 }, (_, index) => file(`alternate-${index}`, 2 + index));
  const members = [candidate, keep, ...others];
  const cluster = add("duplicateClusters", { tenantId, hashKey: hash, type: "exact", status: "open",
    fileIds: members.map(entry => entry._id), projectIds: [], recommendedKeepFileId: keep._id, fileCount: members.length,
    totalBytes: 10 * members.length, wastedBytes: 10 * (members.length - 1), riskLevel: "yellow",
    explanation: "Synthetic exact duplicate", createdAt: 1, updatedAt: 1, ...clusterValues });
  const update = (jobId, status, extra = {}) => cleanup.updateJobStatus.handler(ctx, { ...scope, jobId, status, claimToken: token, keepCopyProtocol: 1, ...extra });
  async function quarantine(viaCluster = true) {
    const { jobIds } = await cleanup.queueQuarantine.handler(ctx, { fileIds: [candidate._id], ...(viaCluster ? { clusterId: cluster._id } : {}) });
    assert.equal(jobIds.length, 1);
    assert.equal((await update(jobIds[0], "running")).claimed, true);
    await update(jobIds[0], "completed", { quarantineFiles: [{ fileId: candidate._id, originalPath: candidate.path,
      quarantinePath: "/synthetic/quarantine/candidate.mp4", sizeBytes: candidate.sizeBytes }] });
    const item = rows("quarantineItems").find(entry => entry.fileId === candidate._id);
    assert.equal(item.status, "quarantined");
    assert.ok(candidate.deletedAt, "A confirmed quarantine soft-deletes the moved copy.");
    return item;
  }
  async function requestRestore(item) {
    const { jobId } = await cleanup.requestRestore.handler(ctx, { quarantineId: item._id });
    assert.equal((await update(jobId, "running")).claimed, true);
    return jobId;
  }
  const confirm = (jobId, item, status = "completed", extra = {}) => update(jobId, status,
    { result: status === "completed" ? { restoredQuarantineIds: [item._id] } : { error: "Synthetic restore failure" }, ...extra });
  async function restore(item, status = "completed") {
    const jobId = await requestRestore(item);
    await confirm(jobId, item, status);
    return jobId;
  }
  const state = () => rows("analysisState").find(entry => entry.tenantId === tenantId);
  // The real explicit worker: request, then run what the request scheduled.
  async function analyzeNow() {
    const request = await scans.requestAnalysis.handler(ctx, {});
    assert.equal(request.scheduled, true, request.message);
    const ran = await s.runScheduled();
    assert.deepEqual(ran.map(entry => entry.error), ran.map(() => undefined));
    return ran;
  }
  const analyze = () => duplicates.runDuplicateDetection.handler(s.system, { tenantId });
  const visible = () => duplicates.list.handler(ctx, {});
  const status = () => scans.analysisStatus.handler(ctx, {});
  const clustersForHash = () => rows("duplicateClusters").filter(entry => entry.tenantId === tenantId && entry.hashKey === hash);
  const decide = status => duplicates.updateStatus.handler(ctx, { clusterId: cluster._id, status });
  return { ctx, scope, tenantId, machineId, keep, candidate, others, members, cluster, update, quarantine, requestRestore, confirm,
    restore, state, analyzeNow, analyze, visible, status, clustersForHash, decide };
}

function fixture(t, options) {
  const s = store(t);
  return { ...s, ...workspace(s, options) };
}

const sorted = ids => [...ids].sort();
function assertShowsAllCopies(cluster, members) {
  assert.equal(cluster.status, "open");
  assert.equal(cluster.resolution, undefined);
  assert.deepEqual(sorted(cluster.fileIds), sorted(members.map(entry => entry._id)));
  assert.equal(cluster.fileCount, members.length);
  assert.equal(cluster.totalBytes, 10 * members.length);
  assert.equal(cluster.wastedBytes, 10 * (members.length - 1));
}
// Duplicate Center shows exactly one exact group for the hash with every copy.
async function assertOneVisibleGroup(f, members = f.members) {
  const shown = (await f.visible()).filter(entry => entry.type === "exact" && entry.hashKey === hash);
  assert.equal(shown.length, 1, "Duplicate Center must show the restored group exactly once.");
  assertShowsAllCopies(shown[0], members);
  assert.deepEqual(sorted(shown[0].locations.map(location => location.fileId)), sorted(members.map(entry => entry._id)));
  assert.deepEqual(sorted(shown[0].locations.map(location => location.path)), sorted(members.map(entry => entry.path)));
  assert.equal(f.clustersForHash().length, 1);
  return shown[0];
}
const snapshot = f => structuredClone({ state: f.state() ?? null, jobs: [...f.jobs.values()],
  audits: f.rows("auditLogs").length, clusters: f.rows("duplicateClusters") });

test("a restore after analysis pruned its group schedules the analysis that rebuilds it", async t => {
  const f = fixture(t);
  const item = await f.quarantine();
  assert.equal(f.cluster.status, "resolved");
  assert.equal(f.cluster.resolution, "cleanup");
  // Automatic analysis is disabled; an explicit analysis runs between
  // quarantine and restore and deletes the cleanup-resolved singleton cluster.
  await f.analyzeNow();
  assert.equal(f.clustersForHash().length, 0, "Analysis prunes a hash with a single live copy.");
  assert.deepEqual(await f.visible(), []);
  assert.equal((await f.status()).status, "completed");
  const analyzedAt = f.state().lastRunAt;

  const before = f.jobs.size;
  await f.restore(item);
  assert.equal(item.status, "restored");
  assert.equal(f.candidate.deletedAt, undefined);
  // The restore itself queues the refresh: no scan, analysis request or reopen.
  const queued = [...f.jobs.values()].slice(before);
  assert.equal(queued.length, 1, "A confirmed restore must queue one tenant analysis.");
  assert.equal(queued[0].name, "scans:runManualAnalysis");
  assert.equal(queued[0].args[0].tenantId, f.tenantId);
  assert.equal(queued[0].scheduledTime, analyzedAt + 5 * MINUTE, "Restore analysis waits for the explicit cooldown.");
  assert.equal(f.state().analysisMode, "restore");
  assert.equal((await f.status()).status, "queued");
  assert.deepEqual(await f.visible(), [], "Stale cached results stay hidden until the new generation is analyzed.");

  const ran = await f.runScheduled();
  assert.deepEqual(ran.map(entry => [entry.job._id, entry.error]), [[queued[0]._id, undefined]]);
  const status = await f.status();
  assert.equal(status.status, "completed");
  assert.equal(status.catalogCurrent, true);
  const group = await assertOneVisibleGroup(f);
  assert.equal(group.fileCount, 2);
  assert.equal(group.totalBytes, 20);
  assert.equal(group.wastedBytes, 10);
  assert.equal(group.recommendedKeepFileId, f.keep._id);
  assert.equal(f.state().restoreAnalysisResolvedVersion, f.state().restoreAnalysisRequestVersion);
  assert.equal(f.pending().length, 0);

  // A later analysis keeps exactly one group with the same membership.
  await f.analyze();
  await assertOneVisibleGroup(f);
});

test("a completed restore rejoins its cluster and the queued analysis publishes it", async t => {
  const f = fixture(t);
  const item = await f.quarantine();
  assert.deepEqual(f.cluster.fileIds, [f.keep._id]);
  assert.equal(f.cluster.totalBytes, 10);
  assert.equal(f.cluster.wastedBytes, 0);
  assert.deepEqual(await f.visible(), []);

  await f.restore(item);
  assert.equal(item.status, "restored");
  assert.equal(f.candidate.deletedAt, undefined);
  // The row is repaired immediately, but readers wait for a validated generation.
  assertShowsAllCopies(f.cluster, f.members);
  assert.equal(f.cluster.recommendedKeepFileId, f.keep._id);
  assert.deepEqual(await f.visible(), []);
  assert.equal(f.pending().length, 1);
  await f.runScheduled();
  const shown = await assertOneVisibleGroup(f);
  assert.equal(shown._id, f.cluster._id);
  assert.equal(shown.recommendedKeepFileId, f.keep._id);
});

test("re-running analysis after a restore keeps one visible cluster with correct totals", async t => {
  const f = fixture(t);
  await f.restore(await f.quarantine());
  await f.runScheduled();
  await f.analyze();
  assert.equal(f.clustersForHash().length, 1);
  assertShowsAllCopies(f.cluster, f.members);
  assert.equal(f.cluster.recommendedKeepFileId, f.keep._id);
  const shown = await f.visible();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].locations.length, 2);
});

test("restoring into a cluster that stayed open restores the full copy count", async t => {
  const f = fixture(t, { copies: 3 });
  const item = await f.quarantine();
  assert.equal(f.cluster.status, "open");
  assert.equal(f.cluster.fileCount, 2);
  assert.equal(f.cluster.wastedBytes, 10);
  await f.restore(item);
  assertShowsAllCopies(f.cluster, f.members);
  await f.runScheduled();
  assert.equal((await assertOneVisibleGroup(f))._id, f.cluster._id);
  await f.analyze();
  assertShowsAllCopies(f.cluster, f.members);
  assert.equal((await f.visible())[0].locations.length, 3);
});

test("a three-copy group pruned to one copy after two quarantines returns whole after both restores", async t => {
  const f = fixture(t, { copies: 3 });
  const first = await f.quarantine();
  // Quarantine a second copy through its own job, leaving the keep alone.
  const other = f.others[0];
  const { jobIds } = await cleanup.queueQuarantine.handler(f.ctx, { fileIds: [other._id] });
  assert.equal((await f.update(jobIds[0], "running")).claimed, true);
  await f.update(jobIds[0], "completed", { quarantineFiles: [{ fileId: other._id, originalPath: other.path,
    quarantinePath: "/synthetic/quarantine/alternate.mp4", sizeBytes: 10 }] });
  const second = f.rows("quarantineItems").find(entry => entry.fileId === other._id);
  await f.analyzeNow();
  assert.equal(f.clustersForHash().length, 0);
  // Two restores before the worker starts share one pending analyzer.
  const before = f.jobs.size;
  await f.restore(first);
  await f.restore(second);
  assert.equal(f.jobs.size - before, 1);
  assert.equal(f.pending().length, 1);
  assert.equal(f.state().restoreAnalysisRequestVersion, 2);
  assert.equal((await f.runScheduled()).length, 1);
  await assertOneVisibleGroup(f);
  assert.equal(f.state().restoreAnalysisResolvedVersion, 2);
});

test("repeated completion reports of a finished restore add no generation, request, audit or work", async t => {
  const f = fixture(t);
  const item = await f.quarantine();
  await f.analyzeNow();
  const jobId = await f.requestRestore(item);
  await f.confirm(jobId, item);
  const before = snapshot(f);
  for (const status of ["completed", "failed"]) {
    const repeated = await f.confirm(jobId, item, status);
    assert.equal(repeated.claimed, false);
    assert.equal(repeated.reason, "already_finished");
  }
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.state().restoreAnalysisRequestVersion, 1);
  await f.runScheduled();
  await assertOneVisibleGroup(f);
});

test("a failed restore after analysis pruned the group requests no refresh and keeps the copy quarantined", async t => {
  const f = fixture(t);
  const item = await f.quarantine();
  await f.analyzeNow();
  const before = structuredClone(f.state());
  const jobs = f.jobs.size;
  await f.restore(item, "failed");
  assert.equal(item.status, "quarantined");
  assert.ok(f.candidate.deletedAt);
  assert.deepEqual(f.state(), before);
  assert.equal(f.jobs.size, jobs);
  assert.equal(f.clustersForHash().length, 0);
  assert.deepEqual(await f.visible(), []);
});

test("a failed restore keeps the copy quarantined and its cluster hidden", async t => {
  const f = fixture(t);
  const item = await f.quarantine();
  await f.restore(item, "failed");
  assert.equal(item.status, "quarantined");
  assert.ok(f.candidate.deletedAt);
  assert.equal(f.cluster.status, "resolved");
  assert.equal(f.cluster.resolution, "cleanup");
  assert.deepEqual(f.cluster.fileIds, [f.keep._id]);
  assert.equal(f.cluster.totalBytes, 10);
  assert.equal(f.state(), undefined, "A failed restore changes no analysis inputs.");
  assert.equal(f.jobs.size, 0);
  assert.deepEqual(await f.visible(), []);
});

test("rejected restore reports cannot restore, invalidate or schedule analysis", async t => {
  const f = fixture(t);
  const item = await f.quarantine();
  await f.analyzeNow();
  const jobId = await f.requestRestore(item);
  const foreign = workspace(f, { tenantId: "tenants:foreign" });
  const otherMachine = f.add("machines", { tenantId: f.tenantId, name: "Other QA machine" })._id;
  const otherItem = f.add("quarantineItems", { tenantId: f.tenantId, machineId: f.machineId, fileId: f.keep._id, status: "quarantined",
    originalPath: f.keep.path, quarantinePath: "/synthetic/quarantine/keep.mp4", sizeBytes: 10, movedAt: 1, rollbackUntil: 2 });
  const before = snapshot(f);
  await assert.rejects(f.confirm(jobId, item, "completed", { machineId: otherMachine }), /Unknown machine job/);
  await assert.rejects(f.confirm(jobId, item, "completed", { tenantId: foreign.tenantId, machineId: foreign.machineId }), /Unknown machine job/);
  await assert.rejects(f.confirm("cleanupJobs:404", item), /Unknown machine job/);
  await assert.rejects(f.confirm(jobId, otherItem), /did not confirm the restore/);
  assert.equal((await f.confirm(jobId, item, "completed", { claimToken: "another-agent-claim-token-1234" })).reason, "lease_lost");
  // The persisted quarantine job cannot be replayed as this restore.
  const quarantineJob = f.rows("cleanupJobs").find(job => job.action === "quarantine");
  assert.equal((await f.confirm(String(quarantineJob._id), item)).reason, "already_finished");
  assert.deepEqual(snapshot(f), before);
  // An expired lease cannot complete the restore either.
  f.clock.advance(2 * MINUTE + 1);
  assert.equal((await f.confirm(jobId, item)).reason, "lease_lost");
  assert.deepEqual(snapshot(f), before);
  assert.equal(item.status, "pending_restore");
  assert.ok(f.candidate.deletedAt);
  assert.equal(foreign.state(), undefined);
  assert.deepEqual(await f.visible(), []);
});

test("restore refresh stays inside the restoring tenant even for identical hashes", async t => {
  const f = fixture(t);
  const other = workspace(f, { tenantId: "tenants:other" });
  const otherState = f.add("analysisState", { tenantId: other.tenantId, dirtyCount: 0, catalogGeneration: 4,
    analyzedGeneration: 4, scheduled: false, lastRunAt: 0 });
  const foreignBefore = structuredClone({ state: otherState, cluster: other.cluster, files: f.rows("files").filter(file => file.tenantId === other.tenantId) });
  const item = await f.quarantine();
  await f.analyzeNow();
  const before = f.jobs.size;
  await f.restore(item);
  const queued = [...f.jobs.values()].slice(before);
  assert.deepEqual(queued.map(job => job.args[0].tenantId), [f.tenantId]);
  await f.runScheduled();
  await assertOneVisibleGroup(f);
  assert.deepEqual(structuredClone({ state: f.documents.get(otherState._id), cluster: other.cluster,
    files: f.rows("files").filter(file => file.tenantId === other.tenantId) }), foreignBefore);
  // The other tenant still sees only its own unchanged group.
  const shown = await other.visible();
  assert.equal(shown.length, 1);
  assert.equal(shown[0]._id, other.cluster._id);
  assert.deepEqual(sorted(shown[0].fileIds), sorted(other.members.map(entry => entry._id)));
});

test("restoring a hashless or uncatalogued file never invents an exact duplicate group", async t => {
  // A hashless file changes analysis inputs, so restore still refreshes them.
  const hashless = fixture(t);
  const item = await hashless.quarantine();
  await hashless.analyzeNow();
  await hashless.db.patch(hashless.candidate._id, { fullHash: undefined, quickHash: "q".repeat(16) });
  await hashless.restore(item);
  assert.equal(hashless.pending().length, 1);
  await hashless.runScheduled();
  assert.equal((await hashless.status()).status, "completed");
  assert.equal(hashless.clustersForHash().length, 0);
  assert.deepEqual(await hashless.visible(), []);

  // A catalog row that disappeared retains the item/audit behavior only.
  t.mock.restoreAll();
  const missing = fixture(t);
  const lost = await missing.quarantine();
  await missing.analyzeNow();
  const jobId = await missing.requestRestore(lost);
  await missing.db.delete(missing.candidate._id);
  const before = structuredClone(missing.state());
  const jobs = missing.jobs.size;
  const audits = missing.rows("auditLogs").length;
  await missing.confirm(jobId, lost);
  assert.equal(lost.status, "restored");
  assert.deepEqual(missing.state(), before);
  assert.equal(missing.jobs.size, jobs);
  assert.ok(missing.rows("auditLogs").slice(audits).some(entry => entry.action === "quarantine_restore"));
  assert.deepEqual(await missing.visible(), []);
});

test("restoring the only remaining live copy publishes no open group", async t => {
  const f = fixture(t);
  const item = await f.quarantine();
  await f.analyzeNow();
  // The keep copy disappeared independently while the candidate was quarantined.
  await f.db.patch(f.keep._id, { deletedAt: f.clock.now });
  await f.restore(item);
  await f.runScheduled();
  const status = await f.status();
  assert.equal(status.status, "completed");
  assert.equal(status.catalogCurrent, true);
  assert.equal(f.clustersForHash().length, 0);
  assert.deepEqual(await f.visible(), []);
});

test("analysis reopens clusters a pre-fix restore left hidden", async t => {
  for (const resolution of [undefined, "cleanup"]) {
    // Both copies are live but the cluster still reflects the old quarantine.
    t.mock.restoreAll();
    const f = fixture(t, { cluster: { status: "resolved", fileIds: [], fileCount: 1, totalBytes: 10, wastedBytes: 0,
      ...(resolution ? { resolution } : {}) } });
    f.cluster.fileIds = [f.keep._id];
    assert.deepEqual(await f.visible(), []);
    await f.analyze();
    assertShowsAllCopies(f.cluster, f.members);
    assert.equal((await f.visible()).length, 1);
  }
});

test("explicit ignore and intentional decisions survive quarantine, restore and analysis", async t => {
  for (const status of ["ignored", "resolved"]) {
    t.mock.restoreAll();
    const f = fixture(t);
    await f.decide(status);
    assert.equal(f.cluster.resolution, "user");
    const item = await f.quarantine(false);
    assert.equal(f.cluster.status, status, "Cleanup must not overwrite a user decision.");
    assert.equal(f.cluster.resolution, "user");
    assert.equal(f.cluster.fileCount, 1);
    await f.restore(item);
    // Membership is factual and refreshed; visibility follows the user's choice.
    assert.deepEqual(sorted(f.cluster.fileIds), sorted(f.members.map(entry => entry._id)));
    assert.equal(f.cluster.totalBytes, 20);
    assert.equal(f.cluster.status, status);
    await f.runScheduled();
    await f.analyze();
    assert.equal(f.cluster.status, status);
    assert.equal(f.cluster.resolution, "user");
    assert.deepEqual(await f.visible(), []);
  }
});

test("user decisions survive analysis that runs between quarantine and restore", async t => {
  const cases = [
    { name: "ignored", decide: "ignored", status: "ignored" },
    { name: "intentional", decide: "resolved", status: "resolved" },
    // Marked "Intentional" before `resolution` existed; cleanup records it.
    { name: "legacy intentional", cluster: { status: "resolved" }, status: "resolved" },
    // Ignored and quarantined before markers existed: analysis records it.
    { name: "legacy ignored", cluster: { status: "ignored" }, status: "ignored", unmark: true },
  ];
  for (const entry of cases) {
    t.mock.restoreAll();
    const f = fixture(t, { cluster: entry.cluster ?? {} });
    if (entry.decide) await f.decide(entry.decide);
    const item = await f.quarantine(false);
    if (entry.unmark) await f.db.patch(f.cluster._id, { resolution: undefined });
    await f.analyzeNow();
    const [kept] = f.clustersForHash();
    assert.ok(kept, `${entry.name}: analysis must not delete a user decision`);
    assert.equal(kept._id, f.cluster._id);
    assert.equal(kept.status, entry.status, entry.name);
    assert.equal(kept.resolution, "user", entry.name);
    await f.restore(item);
    await f.runScheduled();
    const [restored] = f.clustersForHash();
    assert.equal(f.clustersForHash().length, 1, entry.name);
    assert.equal(restored.status, entry.status, entry.name);
    assert.equal(restored.resolution, "user", entry.name);
    assert.deepEqual(sorted(restored.fileIds), sorted(f.members.map(member => member._id)), entry.name);
    assert.equal(restored.fileCount, 2);
    assert.equal(restored.totalBytes, 20);
    assert.equal(restored.wastedBytes, 10);
    assert.equal((await f.status()).status, "completed");
    assert.deepEqual(await f.visible(), [], `${entry.name}: the decision keeps the group out of Duplicate Center`);
  }
});

test("a legacy intentional decision without a marker survives quarantine and restore", async t => {
  // Marked "Intentional" before `resolution` existed: two copies, no marker.
  const f = fixture(t, { cluster: { status: "resolved" } });
  assert.equal(f.cluster.resolution, undefined);
  const item = await f.quarantine(false);
  assert.equal(f.cluster.status, "resolved");
  assert.equal(f.cluster.resolution, "user", "Cleanup records the legacy decision before the copy count drops.");
  assert.equal(f.cluster.fileCount, 1);
  await f.restore(item);
  assert.equal(f.cluster.status, "resolved");
  assert.equal(f.cluster.fileCount, 2);
  await f.runScheduled();
  await f.analyze();
  assert.equal(f.cluster.status, "resolved");
  assert.equal(f.cluster.resolution, "user");
  assert.deepEqual(await f.visible(), []);
});

test("reopening a cluster by hand clears the user decision marker", async t => {
  const f = fixture(t);
  await f.decide("resolved");
  await f.decide("open");
  assert.equal(f.cluster.status, "open");
  assert.equal(f.cluster.resolution, undefined);
});
