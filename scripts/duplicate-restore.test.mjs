import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// Quarantine -> restore -> analysis through the actual Convex handlers and an
// isolated in-memory database. No deployment or physical files are touched.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const modules = new Map();
const register = definition => definition;
// Function references resolve to "module:name" so the action context below can
// dispatch runQuery/runMutation to the loaded handlers.
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
    if (name === "./settings") return { workspaceSettings: async () => ({ retentionDays: 14, cleanupRules: { cacheDelete: true, proxyDelete: true } }) };
    if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), `${name}.ts`));
    return nodeRequire(name);
  };
  new Function("require", "exports", code)(require, exports);
  return exports;
}
const handlers = {
  cleanup: load(path.join(repository, "convex/cleanup.ts")),
  duplicates: load(path.join(repository, "convex/duplicates.ts")),
  files: load(path.join(repository, "convex/files.ts")),
};
const { cleanup, duplicates } = handlers;
const hash = "b".repeat(64);
const token = "duplicate-restore-claim-token-12345";

function fixture({ copies = 2, cluster: clusterValues = {} } = {}) {
  let sequence = 0;
  const tables = new Map();
  const documents = new Map();
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
  const tenantId = "tenants:qa";
  const machineId = add("machines", { tenantId, name: "Synthetic QA machine" })._id;
  const member = add("teamMembers", { tenantId, email: "qa@driveos.test", name: "QA", role: "admin" });
  const user = add("users", { tenantId, email: member.email, teamMemberId: member._id });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: `${user._id}|session` }) } };
  const dispatch = (reference, args) => {
    const [module, name] = reference.split(":");
    return handlers[module][name].handler(ctx, args);
  };
  const actionCtx = { runQuery: dispatch, runMutation: dispatch };
  const scope = { tenantId, machineId };
  const rows = table => tables.get(table) ?? [];
  // The newest copy wins analysis' trust tie-breaker, so "keep" stays the keep.
  const file = (name, modifiedAtFile) => add("files", { ...scope, path: `/synthetic/review/${name}.mp4`, name: `${name}.mp4`,
    source: "local", sizeBytes: 10, fullHash: hash, riskLevel: "yellow", storageTier: "hot", isRaw: false, isFinal: false,
    modifiedAtFile });
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
  async function restore(item, status = "completed") {
    const { jobId } = await cleanup.requestRestore.handler(ctx, { quarantineId: item._id });
    assert.equal((await update(jobId, "running")).claimed, true);
    await update(jobId, status, { result: status === "completed" ? { restoredQuarantineIds: [item._id] } : { error: "Synthetic restore failure" } });
  }
  const analyze = () => duplicates.runDuplicateDetection.handler(actionCtx, { tenantId });
  const visible = () => duplicates.list.handler(ctx, {});
  const clustersForHash = () => rows("duplicateClusters").filter(entry => entry.hashKey === hash);
  const decide = status => duplicates.updateStatus.handler(ctx, { clusterId: cluster._id, status });
  return { rows, keep, candidate, others, members, cluster, quarantine, restore, analyze, visible, clustersForHash, decide };
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

test("a completed restore rejoins the cluster and makes it visible again", async () => {
  const f = fixture();
  const item = await f.quarantine();
  assert.equal(f.cluster.status, "resolved");
  assert.equal(f.cluster.resolution, "cleanup");
  assert.deepEqual(f.cluster.fileIds, [f.keep._id]);
  assert.equal(f.cluster.totalBytes, 10);
  assert.equal(f.cluster.wastedBytes, 0);
  assert.deepEqual(await f.visible(), []);

  await f.restore(item);
  assert.equal(item.status, "restored");
  assert.equal(f.candidate.deletedAt, undefined);
  assertShowsAllCopies(f.cluster, f.members);
  assert.equal(f.cluster.recommendedKeepFileId, f.keep._id);
  const [shown] = await f.visible();
  assert.equal(shown._id, f.cluster._id);
  assert.deepEqual(sorted(shown.locations.map(location => location.fileId)), sorted(f.members.map(entry => entry._id)));
});

test("re-running analysis after a restore keeps one visible cluster with correct totals", async () => {
  const f = fixture();
  await f.restore(await f.quarantine());
  await f.analyze();
  assert.equal(f.clustersForHash().length, 1);
  assertShowsAllCopies(f.cluster, f.members);
  assert.equal(f.cluster.recommendedKeepFileId, f.keep._id);
  const shown = await f.visible();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].locations.length, 2);
});

test("analysis reopens clusters a pre-fix restore left hidden", async () => {
  for (const resolution of [undefined, "cleanup"]) {
    // Both copies are live but the cluster still reflects the old quarantine.
    const f = fixture({ cluster: { status: "resolved", fileIds: [], fileCount: 1, totalBytes: 10, wastedBytes: 0,
      ...(resolution ? { resolution } : {}) } });
    f.cluster.fileIds = [f.keep._id];
    assert.deepEqual(await f.visible(), []);
    await f.analyze();
    assertShowsAllCopies(f.cluster, f.members);
    assert.equal((await f.visible()).length, 1);
  }
});

test("explicit ignore and intentional decisions survive quarantine, restore and analysis", async () => {
  for (const status of ["ignored", "resolved"]) {
    const f = fixture();
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
    await f.analyze();
    assert.equal(f.cluster.status, status);
    assert.equal(f.cluster.resolution, "user");
    assert.deepEqual(await f.visible(), []);
  }
});

test("a legacy intentional decision without a marker survives quarantine and restore", async () => {
  // Marked "Intentional" before `resolution` existed: two copies, no marker.
  const f = fixture({ cluster: { status: "resolved" } });
  assert.equal(f.cluster.resolution, undefined);
  const item = await f.quarantine(false);
  assert.equal(f.cluster.status, "resolved");
  assert.equal(f.cluster.resolution, "user", "Cleanup records the legacy decision before the copy count drops.");
  assert.equal(f.cluster.fileCount, 1);
  await f.restore(item);
  assert.equal(f.cluster.status, "resolved");
  assert.equal(f.cluster.fileCount, 2);
  await f.analyze();
  assert.equal(f.cluster.status, "resolved");
  assert.equal(f.cluster.resolution, "user");
  assert.deepEqual(await f.visible(), []);
});

test("reopening a cluster by hand clears the user decision marker", async () => {
  const f = fixture();
  await f.decide("resolved");
  await f.decide("open");
  assert.equal(f.cluster.status, "open");
  assert.equal(f.cluster.resolution, undefined);
});

test("a failed restore keeps the copy quarantined and its cluster hidden", async () => {
  const f = fixture();
  const item = await f.quarantine();
  await f.restore(item, "failed");
  assert.equal(item.status, "quarantined");
  assert.ok(f.candidate.deletedAt);
  assert.equal(f.cluster.status, "resolved");
  assert.equal(f.cluster.resolution, "cleanup");
  assert.deepEqual(f.cluster.fileIds, [f.keep._id]);
  assert.equal(f.cluster.totalBytes, 10);
  assert.deepEqual(await f.visible(), []);
});

test("restoring into a cluster that stayed open restores the full copy count", async () => {
  const f = fixture({ copies: 3 });
  const item = await f.quarantine();
  assert.equal(f.cluster.status, "open");
  assert.equal(f.cluster.fileCount, 2);
  assert.equal(f.cluster.wastedBytes, 10);
  await f.restore(item);
  assertShowsAllCopies(f.cluster, f.members);
  await f.analyze();
  assertShowsAllCopies(f.cluster, f.members);
  assert.equal((await f.visible())[0].locations.length, 3);
});
