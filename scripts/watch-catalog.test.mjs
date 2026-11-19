import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url);
const modules = new Map();
const reference = parts => new Proxy(() => {}, { get: (_target, name) => name === Symbol.toPrimitive ? () => parts.join(".") : reference([...parts, name]) });
function load(filename) {
  filename = path.resolve(filename);
  if (modules.has(filename)) return modules.get(filename);
  const exports = {}; modules.set(filename, exports);
  const code = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const require = name => {
    if (name.endsWith("/_generated/server")) return Object.fromEntries(["query", "mutation", "internalQuery", "internalMutation", "httpAction"].map(key => [key, value => value]));
    if (name.endsWith("/_generated/api")) return { internal: reference([]) };
    if (name === "convex/server") return { httpRouter: () => ({ routes: [], route(route) { this.routes.push(route); } }) };
    if (name === "./auth") return { auth: { addHttpRoutes() {} } };
    if (name === "./agentAuth") return { hashToken: async token => `synthetic-hash:${token}` };
    if (name === "./settings") return { workspaceSettings: async () => ({ retentionDays: 14, cleanupRules: { cacheDelete: true, proxyDelete: true } }) };
    if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), `${name}.ts`));
    return nodeRequire(name);
  };
  new Function("require", "exports", code)(require, exports);
  return exports;
}
const files = load(path.join(repository, "convex/files.ts"));
const cleanup = load(path.join(repository, "convex/cleanup.ts"));
const http = load(path.join(repository, "convex/http.ts")).default;
const { catalogPathWithin } = load(path.join(repository, "convex/catalogObservations.ts"));

function fixture() {
  let sequence = 0;
  const tables = new Map(), documents = new Map(), writes = [], indexes = [], calls = [];
  const add = (table, data) => {
    const row = { ...structuredClone(data), _id: `${table}:${++sequence}`, _creationTime: sequence };
    if (!tables.has(table)) tables.set(table, []);
    tables.get(table).push(row); documents.set(row._id, row); return row;
  };
  const value = (expression, row) => typeof expression === "function" ? expression(row) : expression;
  const filters = {
    field: field => row => field.split(".").reduce((item, key) => item?.[key], row),
    eq: (a, b) => row => value(a, row) === value(b, row),
    neq: (a, b) => row => value(a, row) !== value(b, row),
    and: (...terms) => row => terms.every(term => value(term, row)),
  };
  const db = {
    normalizeId: (table, id) => typeof id === "string" && id.startsWith(`${table}:`) ? id : null,
    get: async id => structuredClone(documents.get(id) ?? null),
    insert: async (table, data) => { const row = add(table, data); writes.push(["insert", table]); return row._id; },
    patch: async (id, patch) => {
      const row = documents.get(id); assert.ok(row);
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete row[key]; else row[key] = structuredClone(value);
      writes.push(["patch", id]);
    },
    query(table) {
      const predicates = []; let descending = false;
      const selected = () => {
        const rows = [...(tables.get(table) ?? [])].filter(row => predicates.every(predicate => predicate(row)))
          .sort((a, b) => (a.createdAt ?? a._creationTime) - (b.createdAt ?? b._creationTime));
        return descending ? rows.reverse() : rows;
      };
      const chain = {
        withIndex(name, configure) {
          indexes.push(name); const q = {};
          for (const op of ["eq", "gt", "lte"]) q[op] = (field, expected) => { predicates.push(row => op === "eq" ? row[field] === expected : op === "gt" ? row[field] > expected : row[field] <= expected); return q; };
          configure(q); return chain;
        },
        filter(configure) { predicates.push(configure(filters)); return chain; },
        order(direction) { descending = direction === "desc"; return chain; },
        async take(count) { return structuredClone(selected().slice(0, count)); },
        async first() { return (await chain.take(1))[0] ?? null; },
        async collect() { return chain.take(Infinity); },
        async paginate({ cursor, numItems }) {
          const rows = selected(), start = Number(cursor ?? 0), end = start + numItems;
          return { page: structuredClone(rows.slice(start, end)), isDone: end >= rows.length, continueCursor: String(end) };
        },
      }; return chain;
    },
  };
  const tenantId = "tenants:synthetic";
  const machineId = add("machines", { tenantId })._id;
  const driveId = add("drives", { tenantId, machineId, mountPath: "/catalog" })._id;
  const scanSessionId = add("scanSessions", { tenantId, machineId, driveId, rootPath: "/catalog/watched", status: "running" })._id;
  const member = add("teamMembers", { tenantId, name: "Synthetic QA", email: "qa@driveos.test", role: "admin" });
  const user = add("users", { tenantId, teamMemberId: member._id, email: member.email });
  const scope = { tenantId, machineId, driveId, scanSessionId };
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: `${user._id}|session` }) } };
  const meta = (extra = {}) => ({ path: "/catalog/watched/Cache/preview.dat", name: "preview.dat", extension: "dat", sizeBytes: 2 * 1024 * 1024,
    createdAtFile: 1, modifiedAtFile: 20, quickHash: "synthetic-quick", fullHash: "a".repeat(64), classification: "CACHE", riskLevel: "green",
    isGenerated: true, isRaw: false, isFinal: false, isProjectFile: false, ...extra });
  const rows = table => tables.get(table) ?? [];
  const upload = (data = [meta()], extra = {}) => files.uploadBatch.handler(ctx, { ...scope, files: data, catalogReceiptProtocol: 1, ...extra });
  const lookup = data => files.getCatalogReceipts.handler(ctx, { ...scope, files: data });
  const remove = (data, extra = {}) => files.reportMissingFiles.handler(ctx, { ...scope, files: data, ...extra });
  const fingerprint = data => ({ path: data.path, sizeBytes: data.sizeBytes, modifiedAtFile: data.modifiedAtFile,
    ...(data.quickHash !== undefined ? { quickHash: data.quickHash } : {}), ...(data.fullHash !== undefined ? { fullHash: data.fullHash } : {}) });
  const job = (fileId, extra = {}) => add("cleanupJobs", { tenantId, machineId, action: "quarantine", status: "approved",
    affectedFileIds: [fileId], affectedBytes: 2 * 1024 * 1024, createdAt: 1, updatedAt: 1, requestedBy: member.email, ...extra });
  ctx.runQuery = async (ref, args) => {
    const name = String(ref); calls.push({ name, args });
    if (name === "agentAuth.verifyMachineToken") return args.tokenHash === "synthetic-hash:synthetic-token" ? { tenantId, machineId } : null;
    if (name === "files.getCatalogReceipts") return files.getCatalogReceipts.handler(ctx, args);
    throw new Error(`Unexpected test query ${name}`);
  };
  ctx.runMutation = async (ref, args) => {
    const name = String(ref); calls.push({ name, args });
    if (name.startsWith("rateLimits.")) return { ok: true };
    if (name === "files.uploadBatch") return files.uploadBatch.handler(ctx, args);
    if (name === "files.reportMissingFiles") return files.reportMissingFiles.handler(ctx, args);
    if (name === "scans.start") return scanSessionId;
    if (name === "drives.register") return { driveId, isNew: false, hasCatalog: true };
    throw new Error(`Unexpected test mutation ${name}`);
  };
  async function request(route, body, authenticated = true) {
    const target = http.routes.find(item => item.path === `/api/${route}`);
    assert.ok(target);
    return target.handler(ctx, new Request(`https://synthetic.invalid/api/${route}`, { method: "POST",
      headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: "Bearer synthetic-token" } : {}) }, body: JSON.stringify(body) }));
  }
  return { ctx, db, scope, add, rows, writes, indexes, calls, meta, upload, lookup, remove, fingerprint, job, request };
}

test("acknowledged upload, legacy lookup and idempotent tombstone use exact stored observations", async () => {
  const f = fixture(), initial = await f.upload();
  const receipt = initial.receipts[0];
  assert.equal(receipt.catalogVersion, 1);
  assert.equal(f.rows("files")[0].source, "local");
  assert.deepEqual((await f.lookup([f.fingerprint(receipt)])).receipts, [receipt]);
  assert.equal((await f.remove([receipt])).receipts[0].status, "deleted");
  const file = f.rows("files")[0], state = f.rows("analysisState")[0];
  assert.ok(file.deletedAt); assert.equal(file.observationRevision, 2);
  assert.equal(state.catalogGeneration, 2); assert.equal(state.dirtyCount, 2);
  const count = f.writes.length;
  assert.equal((await f.remove([receipt])).receipts[0].status, "already_deleted");
  assert.equal(f.writes.length, count);
});

test("normal unchanged uploads write nothing, while identical recreation fences stale unlink receipts", async () => {
  const f = fixture(), old = (await f.upload()).receipts[0], before = f.writes.length;
  assert.deepEqual((await f.upload()).receipts, [old]);
  assert.equal(f.writes.length, before);
  const next = (await f.upload([f.meta({ forceObservation: true })])).receipts[0];
  assert.equal(next.catalogVersion, old.catalogVersion + 1);
  assert.equal(f.rows("analysisState")[0].catalogGeneration, 1);
  assert.equal((await f.remove([old])).receipts[0].status, "conflict");
  assert.equal(f.rows("files")[0].deletedAt, undefined);
  assert.equal((await f.remove([next])).receipts[0].status, "deleted");
  const readded = (await f.upload()).receipts[0];
  assert.equal(f.rows("files")[0].deletedAt, undefined);
  assert.equal((await f.remove([next])).receipts[0].status, "conflict");
  assert.ok(readded.catalogVersion > next.catalogVersion);
});

test("changed uploads and retained server full hashes are reflected in the acknowledgement", async () => {
  const f = fixture(), old = (await f.upload()).receipts[0];
  const quick = (await f.upload([f.meta({ fullHash: undefined })])).receipts[0];
  assert.equal(quick.fullHash, old.fullHash);
  const changed = (await f.upload([f.meta({ modifiedAtFile: 21, quickHash: "changed", fullHash: undefined })])).receipts[0];
  assert.equal(changed.fullHash, undefined);
  assert.equal((await f.remove([old])).receipts[0].status, "conflict");
  assert.equal((await f.lookup([f.fingerprint(old)])).receipts.length, 0);
  assert.equal((await f.remove([changed])).receipts[0].status, "deleted");
});

test("legacy revision-zero lookup is read-only and refuses a stale fingerprint", async () => {
  const f = fixture();
  f.add("files", { ...f.scope, ...f.meta(), source: "local", lastSeenAt: 10 });
  const good = await f.lookup([f.fingerprint(f.meta())]);
  assert.equal(good.receipts[0].catalogVersion, 0); assert.equal(f.writes.length, 0);
  assert.equal((await f.lookup([f.fingerprint(f.meta({ modifiedAtFile: 19 }))])).rejected[0].status, "conflict");
  assert.equal((await f.remove(good.receipts)).receipts[0].status, "deleted");
});

test("legacy quick-only lookup returns the retained full hash, but deletion CAS still requires it", async () => {
  const f = fixture(), initial = (await f.upload()).receipts[0], before = f.writes.length;
  const quickOnly = f.fingerprint(f.meta({ fullHash: undefined }));
  const result = await f.lookup([quickOnly]);
  assert.deepEqual(result.receipts, [initial]);
  assert.equal(result.receipts[0].fullHash, "a".repeat(64));
  for (const expected of [
    { ...quickOnly, quickHash: "different" },
    { ...quickOnly, fullHash: "b".repeat(64) },
    { ...quickOnly, quickHash: undefined },
    { ...quickOnly, quickHash: "" },
  ]) assert.equal((await f.lookup([expected])).rejected[0].status, "conflict");
  assert.equal(f.writes.length, before);
  assert.equal((await f.remove([{ ...initial, fullHash: undefined }])).receipts[0].status, "conflict");
  assert.equal((await f.remove(result.receipts)).receipts[0].status, "deleted");
});

test("active quarantine and restore ownership, including legacy missing markers, defer unlink", async () => {
  for (const action of ["quarantine", "restore"]) {
    const f = fixture(), receipt = (await f.upload()).receipts[0];
    const job = f.job(receipt.fileId, { action, status: "running" });
    if (action === "restore") await f.db.patch(receipt.fileId, { pendingCleanupJobId: job._id });
    const before = f.writes.length;
    assert.equal((await f.lookup([f.fingerprint(receipt)])).rejected[0].status, "deferred");
    assert.equal((await f.remove([receipt])).receipts[0].status, "deferred");
    assert.equal(f.writes.length, before);
    assert.equal(f.rows("files")[0].deletedAt, undefined);
    assert.equal(f.rows("files")[0].pendingCleanupJobId, action === "restore" ? job._id : undefined);
  }
});

test("watch unlink cannot erase quarantine receipts and restoration invalidates the old deletion receipt", async () => {
  const f = fixture(), receipt = (await f.upload()).receipts[0];
  const claimToken = "catalog-quarantine-token-123456";
  const job = f.job(receipt.fileId, { status: "running", claimToken, leaseRequired: true, leaseExpiresAt: Date.now() + 120000 });
  await f.db.patch(receipt.fileId, { pendingCleanupJobId: job._id });
  assert.equal((await f.remove([receipt])).receipts[0].status, "deferred");
  const scoped = { tenantId: f.scope.tenantId, machineId: f.scope.machineId, keepCopyProtocol: 1, claimToken };
  await cleanup.updateJobStatus.handler(f.ctx, { ...scoped, jobId: job._id, status: "completed", quarantineFiles: [{
    fileId: receipt.fileId, originalPath: receipt.path, quarantinePath: "/synthetic/quarantine/preview.dat", sizeBytes: receipt.sizeBytes,
  }] });
  const item = f.rows("quarantineItems")[0];
  assert.ok(item); assert.equal(item.status, "quarantined");
  assert.equal((await f.remove([receipt])).receipts[0].status, "already_deleted");
  const restore = await cleanup.requestRestoreAgent.handler(f.ctx, { tenantId: f.scope.tenantId, machineId: f.scope.machineId, quarantineId: item._id });
  await cleanup.updateJobStatus.handler(f.ctx, { ...scoped, jobId: restore.jobId, status: "running" });
  await cleanup.updateJobStatus.handler(f.ctx, { ...scoped, jobId: restore.jobId, status: "completed", result: { restoredQuarantineIds: [item._id] } });
  assert.equal(item.status, "restored");
  assert.equal(f.rows("files")[0].deletedAt, undefined);
  assert.equal((await f.remove([receipt])).receipts[0].status, "conflict");
});

test("scoped receipts reject other machines, tenants, drives, retired sessions and sibling-prefix paths", async () => {
  const f = fixture(), receipt = (await f.upload()).receipts[0];
  const otherMachine = f.add("machines", { tenantId: f.scope.tenantId });
  const otherDrive = f.add("drives", { tenantId: f.scope.tenantId, machineId: otherMachine._id, mountPath: "/catalog" });
  for (const extra of [{ machineId: otherMachine._id }, { tenantId: "tenants:foreign" }, { driveId: otherDrive._id }])
    await assert.rejects(f.remove([receipt], extra), /Unknown/);
  const foreign = f.add("files", { ...f.scope, ...f.meta(), source: "local", tenantId: "tenants:foreign" });
  assert.equal((await f.remove([{ ...receipt, fileId: foreign._id }])).receipts[0].status, "not_found");
  assert.equal((await f.remove([{ ...receipt, path: "/catalog/watched-sibling/preview.dat" }])).receipts[0].status, "conflict");
  assert.equal((await f.remove([{ ...receipt, path: "/catalog/watched/../other/preview.dat" }])).receipts[0].status, "conflict");
  await f.db.patch(f.scope.scanSessionId, { status: "completed" });
  await assert.rejects(f.remove([receipt]), /Unknown active machine scan/);
  assert.equal(f.rows("files")[0].deletedAt, undefined);
});

test("receipt bounds reject before catalog writes, and too many active jobs fail closed", async () => {
  const f = fixture(), receipt = (await f.upload()).receipts[0], before = f.writes.length;
  await assert.rejects(f.remove(Array(101).fill(receipt)), /1 to 100/);
  await assert.rejects(f.lookup([]), /1 to 100/);
  assert.equal(f.writes.length, before);
  for (let i = 0; i < 201; i++) f.job(`files:unrelated-${i}`);
  assert.equal((await f.remove([receipt])).receipts[0].status, "deferred");
  assert.equal(f.rows("files")[0].deletedAt, undefined);
});

test("every public list branch and analysis page reads active indexes before its limit", async () => {
  const f = fixture();
  const project = f.add("projects", { tenantId: f.scope.tenantId });
  for (let i = 0; i < 60; i++) f.add("files", { ...f.scope, ...f.meta(), projectId: project._id, deletedAt: 5 });
  const live = f.add("files", { ...f.scope, ...f.meta(), projectId: project._id });
  for (const args of [{}, { driveId: f.scope.driveId }, { projectId: project._id }, { classification: "CACHE" }, { riskLevel: "green" }]) {
    assert.deepEqual((await files.list.handler(f.ctx, { ...args, limit: 1 })).map(row => row._id), [live._id]);
    assert.match(f.indexes.at(-1), /_active$/);
  }
  const page = await files.pageForAnalysis.handler(f.ctx, { tenantId: f.scope.tenantId, cursor: null, numItems: 1 });
  assert.deepEqual(page.files.map(row => row._id), [live._id]);
  assert.equal(f.indexes.at(-1), "by_tenant_active");
});

test("HTTP enforces token machine/tenant, rejects foreign drives and bounds/auth failures", async () => {
  const f = fixture(), receipt = (await f.upload()).receipts[0];
  const spoofed = { ...f.scope, tenantId: "tenants:spoof", machineId: "machines:spoof", files: [receipt] };
  const lookup = await f.request("getCatalogReceipts", { ...spoofed, files: [f.fingerprint(receipt)] });
  assert.equal(lookup.status, 200); assert.equal((await lookup.json()).receipts[0].fileId, receipt.fileId);
  const removed = await f.request("reportMissingFiles", spoofed);
  assert.equal(removed.status, 200); assert.equal((await removed.json()).receipts[0].status, "deleted");
  const otherMachine = f.add("machines", { tenantId: f.scope.tenantId });
  const foreignDrive = f.add("drives", { tenantId: f.scope.tenantId, machineId: otherMachine._id, mountPath: "/catalog" });
  assert.equal((await f.request("reportMissingFiles", { ...spoofed, driveId: foreignDrive._id })).status, 500);
  assert.equal((await f.request("reportMissingFiles", { ...f.scope, files: [receipt] }, false)).status, 401);
  assert.equal((await f.request("reportMissingFiles", { ...f.scope, files: Array(101).fill(receipt) })).status, 400);
  assert.equal((await f.request("getCatalogReceipts", { ...f.scope, files: [] })).status, 400);
  for (const call of f.calls.filter(call => call.name.startsWith("files."))) {
    assert.equal(call.args.machineId, f.scope.machineId); assert.equal(call.args.tenantId, f.scope.tenantId);
  }
});

test("path boundaries handle Windows, UNC, traversal and POSIX case safely", () => {
  assert.equal(catalogPathWithin("C:\\Media\\Watched\\clip.mp4", "c:/media/watched"), true);
  assert.equal(catalogPathWithin("C:/media/watched-other/clip.mp4", "C:/media/watched"), false);
  assert.equal(catalogPathWithin("C:/media/watched/../other/clip.mp4", "C:/media/watched"), false);
  assert.equal(catalogPathWithin("\\\\server\\share\\watched\\clip.mp4", "//SERVER/SHARE/watched"), true);
  assert.equal(catalogPathWithin("//server/other/watched/clip.mp4", "//server/share/watched"), false);
  assert.equal(catalogPathWithin("/catalog/Watched/clip.mp4", "/catalog/watched"), false);
  assert.equal(catalogPathWithin("relative/clip.mp4", "/catalog/watched"), false);
});
