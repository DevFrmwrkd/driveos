import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// Actual Convex handlers with an isolated in-memory database. No deployment or
// physical user files are touched by these authorization tests.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const modules = new Map();
function load(filename) {
  filename = path.resolve(filename);
  if (modules.has(filename)) return modules.get(filename);
  const exports = {};
  modules.set(filename, exports);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const require = name => {
    if (name.endsWith("/_generated/server")) return Object.fromEntries(["mutation", "query", "internalMutation", "internalQuery"].map(name => [name, definition => definition]));
    if (name === "./settings") return { workspaceSettings: async () => ({ retentionDays: 14, cleanupRules: { cacheDelete: true, proxyDelete: true } }) };
    if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), `${name}.ts`));
    return nodeRequire(name);
  };
  new Function("require", "exports", code)(require, exports);
  return exports;
}
const cleanup = load(path.join(repository, "convex/cleanup.ts"));
const hash = "a".repeat(64);
const token = "keep-copy-test-claim-token-12345";

function fixture() {
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
          configure(index); return chain;
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
      };
      return chain;
    },
  };
  const tenantId = "tenants:qa";
  const machineId = add("machines", { tenantId, name: "Synthetic QA machine" })._id;
  const member = add("teamMembers", { tenantId, email: "qa@driveos.test", name: "QA", role: "admin" });
  const user = add("users", { tenantId, email: member.email, teamMemberId: member._id });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: `${user._id}|session` }) } };
  const scope = { tenantId, machineId };
  const rows = table => tables.get(table) ?? [];
  const file = (name, extra = {}) => add("files", { ...scope, path: `/synthetic/review/${name}.mp4`, name: `${name}.mp4`,
    source: "local", sizeBytes: 10, fullHash: hash, riskLevel: "yellow", ...extra });
  const a = file("candidate"), b = file("keep"), c = file("alternate");
  add("duplicateClusters", { tenantId, hashKey: hash, type: "exact", status: "open", fileIds: [a._id, b._id, c._id],
    recommendedKeepFileId: b._id, fileCount: 3, totalBytes: 30, wastedBytes: 20 });
  const queue = (ids = [a._id], extra = {}) => cleanup.queueQuarantine.handler(ctx, { fileIds: ids, ...extra });
  const poll = (keepCopyProtocol = 1) => cleanup.pollPendingJobs.handler(ctx, { ...scope, leaseProtocol: 1, keepCopyProtocol });
  const get = (jobId, keepCopyProtocol = 1) => cleanup.getJob.handler(ctx, { ...scope, jobId, keepCopyProtocol });
  const update = (jobId, status = "running", extra = {}) => cleanup.updateJobStatus.handler(ctx, { ...scope, jobId, status, claimToken: token, keepCopyProtocol: 1, ...extra });
  const legacyJob = (extra = {}) => add("cleanupJobs", { ...scope, action: "quarantine", status: "approved", requestedBy: member.email,
    affectedFileIds: [a._id], affectedBytes: a.sizeBytes, leaseRequired: true, createdAt: 1, updatedAt: 1, ...extra });
  const item = (extra = {}) => add("quarantineItems", { ...scope, cleanupJobId: "cleanupJobs:old", fileId: a._id,
    originalPath: a.path, quarantinePath: "/synthetic/quarantine/item.mp4", sizeBytes: a.sizeBytes,
    movedAt: 1, rollbackUntil: 2, status: "quarantined", ...extra });
  return { ctx, db, scope, rows, add, file, a, b, c, queue, poll, get, update, legacyJob, item };
}

test("queue requires a local keep on the candidate's machine and a distinct path", async () => {
  for (const invalid of ["remote", "cloud", "same-path"]) {
    const f = fixture();
    f.c.deletedAt = 1;
    if (invalid === "remote") f.b.machineId = f.add("machines", { tenantId: f.scope.tenantId })._id;
    if (invalid === "cloud") f.b.source = "cloud";
    if (invalid === "same-path") { f.a.path = "C:\\media\\clip.mp4"; f.b.path = "c:/MEDIA/sub/../clip.mp4"; }
    await assert.rejects(f.queue(), /No separate verified keep copy/);
    assert.equal(f.rows("cleanupJobs").length, 0);
  }
});

test("queued proof is persisted and its keep is reserved against another cleanup", async () => {
  const f = fixture();
  await f.queue();
  const job = f.rows("cleanupJobs")[0];
  assert.deepEqual(job.result.keepCopyProofs, [{ fileId: f.a._id, keepFileId: f.b._id, keepPath: f.b.path,
    keepMachineId: f.scope.machineId, fullHash: hash, sizeBytes: 10 }]);
  await assert.rejects(f.queue([f.b._id]), /keep copy for a pending cleanup/);
});

test("all endpoint gates reject missing capability while the upgraded agent can claim", async () => {
  const f = fixture();
  await f.queue();
  const job = f.rows("cleanupJobs")[0];
  assert.deepEqual(await cleanup.pollPendingJobs.handler(f.ctx, { ...f.scope, leaseProtocol: 1 }), []);
  assert.equal(await cleanup.getJob.handler(f.ctx, { ...f.scope, jobId: job._id }), null);
  const blocked = await f.update(job._id, "running", { keepCopyProtocol: undefined });
  assert.equal(blocked.claimed, false);
  assert.equal(blocked.reason, "keep_copy_agent_upgrade_required");
  assert.equal((await f.poll())[0]._id, job._id);
  assert.equal((await f.get(job._id)).result.keepCopyProtocol, 1);
  assert.equal((await f.update(job._id)).claimed, true);
});

test("unstarted legacy duplicates fail closed and are marked for review", async () => {
  const f = fixture();
  const job = f.legacyJob();
  assert.equal(await f.get(job._id, 0), null);
  assert.equal(await f.get(job._id), null);
  assert.deepEqual(await f.poll(), []);
  assert.equal(job.pollBlockedReason, "missing_keep_copy_proof_requires_review");
  assert.equal((await f.update(job._id)).claimed, false);
  assert.equal(job.status, "approved");
});

test("generated legacy jobs continue to execute without the new capability", async () => {
  const f = fixture();
  f.a.path = "/synthetic/Cache/generated.tmp";
  const job = f.legacyJob();
  assert.equal((await f.poll(0))[0]._id, job._id);
  assert.ok(await f.get(job._id, 0));
  assert.equal((await f.update(job._id, "running", { keepCopyProtocol: undefined })).claimed, true);
});

test("proof survives quarantine receipts and automatic purge; purge also reserves the keep", async () => {
  const f = fixture();
  await f.queue([f.a._id], { purgeAfter: true });
  const job = f.rows("cleanupJobs")[0];
  const proof = structuredClone(job.result.keepCopyProofs[0]);
  await f.update(job._id);
  const receipt = { fileId: f.a._id, originalPath: f.a.path, quarantinePath: "/synthetic/quarantine/a.mp4", sizeBytes: 10 };
  await f.update(job._id, "completed", { quarantineFiles: [receipt], result: { keepCopyProtocol: 0, keepCopyProofs: [] } });
  assert.deepEqual(job.result.keepCopyProofs, [proof]);
  const item = f.rows("quarantineItems")[0];
  assert.equal(item.requiresKeepCopy, true);
  assert.deepEqual(item.keepCopyProof, proof);
  const purge = f.rows("cleanupJobs").find(job => job.action === "purge");
  assert.deepEqual(purge.result.purgeItems[0], { quarantineItemId: item._id, ...receipt, requiresKeepCopy: true, fullHash: hash, keepCopyProof: proof });
  assert.equal(await f.get(purge._id, 0), null);
  assert.equal((await f.update(purge._id, "running", { keepCopyProtocol: undefined })).claimed, false);
  assert.equal((await f.get(purge._id)).result.purgeItems[0].requiresKeepCopy, true);
  await assert.rejects(f.queue([f.b._id]), /keep copy for a pending cleanup/);
  await f.update(purge._id);
  await f.update(purge._id, "completed", { result: { purgedItemIds: [item._id] } });
  assert.equal((await f.get(purge._id)).status, "completed");
  assert.equal(item.status, "permanently_deleted");
});

test("legacy non-generated quarantine cannot be freshly purged without proof", async () => {
  const f = fixture();
  const item = f.item();
  await assert.rejects(cleanup.purgeItem.handler(f.ctx, { quarantineId: item._id, requestedBy: "ignored" }), /no verified keep-copy proof/);
  assert.equal(item.status, "quarantined");
  assert.equal(f.rows("cleanupJobs").length, 0);
});

test("already queued legacy purge derives safety from the persisted quarantine item", async () => {
  for (const generated of [false, true]) {
    const f = fixture();
    const item = f.item({ status: "pending_purge", ...(generated ? { originalPath: "/synthetic/Cache/a.tmp" } : {}) });
    const job = f.legacyJob({ action: "purge", result: { purgeItems: [{ quarantineItemId: item._id, quarantinePath: item.quarantinePath }] } });
    if (generated) {
      const exposed = await f.get(job._id, 0);
      assert.equal(exposed.result.purgeItems[0].requiresKeepCopy, false);
      assert.equal(exposed.result.purgeItems[0].fileId, f.a._id);
      assert.equal((await f.update(job._id, "running", { keepCopyProtocol: undefined })).claimed, true);
      assert.equal(job.result.purgeItems[0].originalPath, item.originalPath);
      await f.update(job._id, "failed", { keepCopyProtocol: undefined, result: { purgedItemIds: [] } });
      assert.equal((await f.get(job._id, 0)).status, "failed");
    } else {
      assert.equal(await f.get(job._id, 0), null);
      assert.equal(await f.get(job._id), null);
      assert.deepEqual(await f.poll(), []);
      assert.equal(job.pollBlockedReason, "missing_keep_copy_proof_requires_review");
      assert.equal((await f.update(job._id)).claimed, false);
    }
  }
});

test("upgraded recovery can reclaim a running legacy receipt without authorizing an automatic purge", async () => {
  const f = fixture();
  const job = f.legacyJob({ status: "running", purgeAfter: true, claimToken: "old-physical-attempt-token-12345", leaseExpiresAt: Date.now() - 1 });
  assert.equal(await f.get(job._id, 0), null);
  assert.equal((await f.poll())[0]._id, job._id);
  assert.equal((await f.update(job._id, "running", { keepCopyProtocol: undefined })).claimed, false);
  assert.equal((await f.update(job._id)).claimed, true);
  assert.equal((await f.update(job._id)).claimed, true); // same-owner heartbeat
  const receipt = { fileId: f.a._id, originalPath: f.a.path, quarantinePath: "/synthetic/quarantine/old.mp4", sizeBytes: 10 };
  assert.equal((await f.update(job._id, "completed", { keepCopyProtocol: undefined, quarantineFiles: [receipt] })).claimed, true);
  assert.equal(f.rows("quarantineItems")[0].requiresKeepCopy, true);
  assert.equal(f.rows("quarantineItems")[0].status, "quarantined");
  assert.equal(f.rows("cleanupJobs").filter(job => job.action === "purge").length, 0);
  assert.equal(job.result.purgeBlockedReason, "missing_keep_copy_proof_requires_review");
});
