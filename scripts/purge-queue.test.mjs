import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// Execute the actual mutation/query handlers against an isolated in-memory DB.
// No deployment, credentials, physical files, or public test functions are used.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const modules = new Map();
const register = definition => definition;
function load(filename) {
  filename = path.resolve(filename);
  if (modules.has(filename)) return modules.get(filename);
  const exports = {};
  modules.set(filename, exports);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const require = name => {
    if (name.endsWith("/_generated/server")) return { mutation: register, query: register, internalMutation: register, internalQuery: register };
    if (name === "./settings") return { workspaceSettings: async () => ({ retentionDays: 14, cleanupRules: {} }) };
    if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), `${name}.ts`));
    return nodeRequire(name);
  };
  new Function("require", "exports", code)(require, exports);
  return exports;
}
const cleanup = load(path.join(repository, "convex/cleanup.ts"));
const { insertApprovedJob, MAX_JOB_FILES } = load(path.join(repository, "convex/jobUtils.ts"));

function fixture() {
  let sequence = 0;
  const tables = new Map();
  const documents = new Map();
  function add(table, values) {
    const document = { ...values, _id: `${table}:${++sequence}`, _creationTime: sequence };
    if (!tables.has(table)) tables.set(table, []);
    tables.get(table).push(document);
    documents.set(document._id, document);
    return document;
  }
  const value = (expression, row) => typeof expression === "function" ? expression(row) : expression;
  const filters = {
    field: name => row => name.split(".").reduce((entry, key) => entry?.[key], row),
    eq: (left, right) => row => value(left, row) === value(right, row),
    neq: (left, right) => row => value(left, row) !== value(right, row),
    and: (...terms) => row => terms.every(term => value(term, row)),
  };
  const db = {
    normalizeId: (table, id) => typeof id === "string" && id.startsWith(`${table}:`) ? id : null,
    get: async id => structuredClone(documents.get(id) ?? null),
    insert: async (table, data) => add(table, data)._id,
    patch: async (id, patch) => {
      const document = documents.get(id);
      assert.ok(document, `Unknown test row ${id}`);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete document[key]; else document[key] = structuredClone(value);
      }
    },
    query(table) {
      const predicates = [];
      let descending = false;
      const chain = {
        withIndex(_name, configure) {
          const index = {};
          for (const operator of ["eq", "gt", "lte"]) index[operator] = (field, expected) => {
            predicates.push(row => operator === "eq" ? row[field] === expected : operator === "gt" ? row[field] > expected : row[field] <= expected);
            return index;
          };
          configure(index);
          return chain;
        },
        filter(configure) { predicates.push(configure(filters)); return chain; },
        order(direction) { descending = direction === "desc"; return chain; },
        async take(count) {
          let rows = (tables.get(table) ?? []).filter(row => predicates.every(predicate => predicate(row)));
          rows = [...rows].sort((a, b) => (a.createdAt ?? a._creationTime) - (b.createdAt ?? b._creationTime));
          if (descending) rows.reverse();
          return structuredClone(rows.slice(0, count));
        },
        async first() { return (await chain.take(1))[0] ?? null; },
        async collect() { return chain.take(Infinity); },
      };
      return chain;
    },
  };
  const tenantId = "tenants:qa";
  const machineId = "machines:qa";
  const member = add("teamMembers", { email: "admin@driveos.test", name: "Admin", role: "admin", tenantId });
  const user = add("users", { email: member.email, teamMemberId: member._id, tenantId });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: `${user._id}|session` }) } };
  const rows = table => tables.get(table) ?? [];
  function items(count, status = "quarantined") {
    return Array.from({ length: count }, (_, number) => add("quarantineItems", {
      tenantId, machineId, fileId: `files:${sequence + number + 10_000}`, quarantinePath: `/synthetic/quarantine/${sequence}-${number}`,
      originalPath: `/synthetic/original/${number}`, sizeBytes: number + 1, rollbackUntil: Date.now() - 1000,
      cleanupJobId: "cleanupJobs:original-quarantine", movedAt: Date.now() - 2000, status,
    }));
  }
  function legacyPurge(entries, extra = {}) {
    return add("cleanupJobs", {
      tenantId, machineId, action: "purge", status: "approved", requestedBy: member.email, approvedBy: member.email,
      affectedFileIds: entries.map(item => item.fileId), affectedBytes: entries.reduce((sum, item) => sum + item.sizeBytes, 0),
      result: { purgeItems: entries.map(item => ({ quarantineItemId: item._id, quarantinePath: item.quarantinePath })) },
      createdAt: Date.now() - 1_000_000 + sequence, updatedAt: Date.now() - 1_000_000, ...extra,
    });
  }
  const poll = () => cleanup.pollPendingJobs.handler(ctx, { tenantId, machineId, leaseProtocol: 1 });
  return { ctx, add, rows, items, legacyPurge, poll, tenantId, machineId, member };
}

test("4,001 expired items become bounded executable purge jobs without losing targets", async () => {
  const f = fixture();
  const entries = f.items(MAX_JOB_FILES + 1);
  const queued = await cleanup.purgeExpired.handler(f.ctx, { requestedBy: f.member.email });
  assert.equal(queued.queued, entries.length);
  const jobs = f.rows("cleanupJobs");
  assert.deepEqual(jobs.map(job => job.affectedFileIds.length), [MAX_JOB_FILES, 1]);
  assert.equal(new Set(jobs.flatMap(job => job.result.purgeItems.map(item => item.quarantineItemId))).size, entries.length);
  assert.ok(entries.every(item => item.status === "pending_purge" && item.deletedAt === undefined));
  const first = await f.poll();
  assert.equal(first.length, 1);
  assert.equal(first[0].affectedFileIds.length, MAX_JOB_FILES);
  await f.ctx.db.patch(first[0]._id, { status: "completed" }); // simulate completion for the next poll only
  assert.equal((await f.poll())[0].affectedFileIds.length, 1);
});

test("oversized insertion is rejected before creating any job or audit row", async () => {
  const f = fixture();
  await assert.rejects(insertApprovedJob(f.ctx, {
    tenantId: f.tenantId, machineId: f.machineId, requestedBy: f.member.email, action: "purge",
    fileIds: Array.from({ length: MAX_JOB_FILES + 1 }, (_, index) => `files:${index}`),
  }), /at most 4,000/);
  assert.equal(f.rows("cleanupJobs").length, 0);
  assert.equal(f.rows("auditLogs").length, 0);
});

test("five oversized legacy parents cannot hide normal work and are repaired once each", async () => {
  const f = fixture();
  const parents = Array.from({ length: 5 }, () => f.legacyPurge(f.items(MAX_JOB_FILES + 1, "pending_purge")));
  const normal = f.add("cleanupJobs", { tenantId: f.tenantId, machineId: f.machineId, action: "scan", status: "approved",
    requestedBy: f.member.email, leaseRequired: true, affectedFileIds: [], affectedBytes: 0, createdAt: Date.now(), updatedAt: Date.now() });
  const first = await f.poll();
  assert.ok(first.some(job => job._id === normal._id));
  assert.ok(first.length <= 4 && first.reduce((sum, job) => sum + job.affectedFileIds.length, 0) <= MAX_JOB_FILES);
  assert.equal(parents.filter(job => job.status === "cancelled").length, 1);
  for (let attempt = 0; attempt < 5; attempt++) await f.poll();
  assert.ok(parents.every(job => job.status === "cancelled" && job.result.replacementJobIds.length === 2));
  const children = f.rows("cleanupJobs").filter(job => job.result?.splitFromJobId);
  assert.equal(children.length, 10);
  assert.equal(new Set(children.flatMap(job => job.result.purgeItems.map(item => item.quarantineItemId))).size, 5 * (MAX_JOB_FILES + 1));
  assert.ok(f.rows("quarantineItems").every(item => item.status === "pending_purge" && item.deletedAt === undefined));
  const claim = await cleanup.updateJobStatus.handler(f.ctx, {
    tenantId: f.tenantId, machineId: f.machineId, jobId: parents[0]._id, status: "running", claimToken: "late-worker-claim-token-12345",
  });
  assert.equal(claim.claimed, false);
  await f.poll();
  assert.equal(f.rows("cleanupJobs").filter(job => job.result?.splitFromJobId).length, 10);
});

test("already-started oversized jobs preserve their original journal identity and cannot starve polling", async () => {
  const f = fixture();
  const originalToken = "original-worker-claim-token-12345";
  const parents = Array.from({ length: 5 }, () => f.legacyPurge(f.items(MAX_JOB_FILES + 1, "pending_purge"), {
    status: "running", attempts: 1, claimToken: originalToken, leaseRequired: true, leaseExpiresAt: Date.now() - 1000,
  }));
  const normal = f.add("cleanupJobs", { tenantId: f.tenantId, machineId: f.machineId, action: "scan", status: "approved",
    requestedBy: f.member.email, leaseRequired: true, affectedFileIds: [], affectedBytes: 0, createdAt: Date.now(), updatedAt: Date.now() });
  assert.deepEqual((await f.poll()).map(job => job._id), [normal._id]);
  assert.ok(parents.every(job => job.status === "running" && job.pollBlocked && job.claimToken === originalToken));
  assert.equal(f.rows("cleanupJobs").filter(job => job.result?.splitFromJobId).length, 0);
  assert.equal((await cleanup.updateJobStatus.handler(f.ctx, { tenantId: f.tenantId, machineId: f.machineId,
    jobId: parents[0]._id, status: "running", claimToken: "replacement-worker-claim-token-12345" })).claimed, false);
  assert.equal((await cleanup.updateJobStatus.handler(f.ctx, { tenantId: f.tenantId, machineId: f.machineId,
    jobId: parents[0]._id, status: "running", claimToken: originalToken })).claimed, true);
});

test("repair refuses changed quarantine authorization and leaves all physical outcomes unconfirmed", async () => {
  const f = fixture();
  const entries = f.items(MAX_JOB_FILES + 1, "pending_purge");
  const parent = f.legacyPurge(entries);
  entries.at(-1).status = "restored";
  const normal = f.add("cleanupJobs", { tenantId: f.tenantId, machineId: f.machineId, action: "scan", status: "approved",
    requestedBy: f.member.email, leaseRequired: true, affectedFileIds: [], affectedBytes: 0, createdAt: Date.now(), updatedAt: Date.now() });
  assert.deepEqual((await f.poll()).map(job => job._id), [normal._id]);
  assert.equal(parent.status, "approved");
  assert.equal(parent.pollBlockedReason, "oversized_purge_requires_review");
  assert.equal(f.rows("cleanupJobs").filter(job => job.result?.splitFromJobId).length, 0);
  assert.ok(entries.every(item => item.deletedAt === undefined));
});
