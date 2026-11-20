import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeRequire = createRequire(import.meta.url), modules = new Map();
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
    if (name.startsWith(".")) return load(path.resolve(path.dirname(filename), `${name}.ts`));
    return nodeRequire(name);
  };
  new Function("require", "exports", code)(require, exports);
  return exports;
}
const drives = load(path.join(repository, "convex/drives.ts"));
const files = load(path.join(repository, "convex/files.ts"));
const http = load(path.join(repository, "convex/http.ts")).default;

function fixture() {
  let sequence = 0;
  const tables = new Map(), documents = new Map(), scheduled = [], reads = [];
  const add = (table, data) => {
    const row = { ...structuredClone(data), _id: `${table}:${++sequence}`, _creationTime: sequence };
    if (!tables.has(table)) tables.set(table, []);
    tables.get(table).push(row); documents.set(row._id, row); return row;
  };
  // Convex orders absent optional fields before strings in an index.
  const compare = (a, b) => a === b ? 0 : a === undefined ? -1 : b === undefined ? 1 : a < b ? -1 : 1;
  const db = {
    normalizeId: (table, id) => typeof id === "string" && id.startsWith(`${table}:`) ? id : null,
    get: async id => structuredClone(documents.get(id) ?? null),
    insert: async (table, data) => add(table, data)._id,
    patch: async (id, patch) => {
      const row = documents.get(id); assert.ok(row);
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete row[key]; else row[key] = structuredClone(value);
    },
    delete: async id => {
      documents.delete(id);
      for (const [table, rows] of tables) tables.set(table, rows.filter(row => row._id !== id));
    },
    query(table) {
      const predicates = [];
      const selected = () => (tables.get(table) ?? []).filter(row => predicates.every(predicate => predicate(row)));
      const chain = {
        withIndex(index, configure) {
          reads.push({ table, index }); const q = {};
          for (const op of ["eq", "lt", "gt"]) q[op] = (field, expected) => {
            predicates.push(row => op === "eq" ? row[field] === expected : op === "lt" ? compare(row[field], expected) < 0 : compare(row[field], expected) > 0);
            return q;
          };
          configure(q); return chain;
        },
        async take(count) { return structuredClone(selected().slice(0, count)); },
        async first() { return (await chain.take(1))[0] ?? null; },
        async collect() { return chain.take(Infinity); },
      }; return chain;
    },
  };
  const tenantId = "tenants:own", machineA = add("machines", { tenantId, name: "Issued A", location: "Studio" })._id;
  const machineB = add("machines", { tenantId, name: "Issued B" })._id;
  const member = add("teamMembers", { tenantId, email: "synthetic@driveos.test", role: "admin" });
  const user = add("users", { tenantId, teamMemberId: member._id, email: member.email });
  const ctx = { db, auth: { getUserIdentity: async () => ({ subject: `${user._id}|session` }) },
    scheduler: { runAfter: async (delay, ref, args) => { scheduled.push({ delay, ref: String(ref), args: structuredClone(args) }); return "scheduled:1"; } } };
  const meta = { path: "C:\\Studio\\preview.dat", name: "preview.dat", extension: "dat", sizeBytes: 2 * 1024 * 1024,
    createdAtFile: 1, modifiedAtFile: 20, quickHash: "synthetic-quick", fullHash: "a".repeat(64), classification: "CACHE", riskLevel: "green",
    isGenerated: true, isRaw: false, isFinal: false, isProjectFile: false };
  const registration = (machineId = machineA, extra = {}) => ({ tenantId, machineId, ownerId: "synthetic", label: "Studio", volumeId: "win32:C:\\Studio",
    mountPath: "C:\\Studio", capacityBytes: 1000, freeBytes: 900, usedBytes: 100, tier: "hot", ...extra });
  const legacy = (extra = {}) => add("drives", registration(machineA, extra));
  const catalog = (driveId, extra = {}) => add("files", { ...meta, tenantId, machineId: machineA, driveId, source: "local", ...extra });
  const register = (machineId, extra) => drives.register.handler(ctx, registration(machineId, extra));
  const upload = (machineId, driveId, modern = false) => {
    const session = modern ? add("scanSessions", { tenantId, machineId, driveId, rootPath: "C:\\Studio", status: "running" }) : null;
    return files.uploadBatch.handler(ctx, { tenantId, machineId, driveId, files: [meta],
      ...(modern ? { catalogReceiptProtocol: 1, scanSessionId: session._id } : {}) });
  };
  ctx.runQuery = async (ref, args) => {
    if (String(ref) === "agentAuth.verifyMachineToken") {
      const machineId = args.tokenHash === "synthetic-hash:A" ? machineA : args.tokenHash === "synthetic-hash:B" ? machineB : null;
      return machineId ? { tenantId, machineId } : null;
    }
    throw new Error(`Unexpected test query ${String(ref)}`);
  };
  ctx.runMutation = async (ref, args) => {
    const name = String(ref);
    if (name.startsWith("rateLimits.")) return { ok: true };
    if (name === "drives.register") return drives.register.handler(ctx, args);
    if (name === "drives.registerMachine") return drives.registerMachine.handler(ctx, args);
    if (name === "drives.removeByVolumeId") return drives.removeByVolumeId.handler(ctx, args);
    if (name === "files.uploadBatch") return files.uploadBatch.handler(ctx, args);
    throw new Error(`Unexpected test mutation ${name}`);
  };
  const request = async (route, body, token = "A") => {
    const target = http.routes.find(item => item.path === `/api/${route}`); assert.ok(target);
    return target.handler(ctx, new Request(`https://synthetic.invalid/api/${route}`, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  };
  return { ctx, db, tenantId, machineA, machineB, add, registration, legacy, catalog, register, upload, request, scheduled, reads,
    rows: table => tables.get(table) ?? [] };
}

test("identical paths on two machines retain separate drive IDs and accept old/new upload protocols", async () => {
  const f = fixture(), a = await f.register(f.machineA);
  await f.upload(f.machineA, a.driveId);
  const b = await f.register(f.machineB);
  const uploaded = await f.upload(f.machineB, b.driveId, true);
  assert.notEqual(a.driveId, b.driveId);
  assert.equal(uploaded.receipts[0].machineId, f.machineB);
  assert.equal(uploaded.receipts[0].driveId, b.driveId);
  assert.equal(f.rows("drives").find(row => row._id === a.driveId).machineId, f.machineA);
  assert.equal((await f.register(f.machineA)).driveId, a.driveId);
  assert.equal(f.rows("files").length, 2);
});

test("clean legacy catalogs preserve IDs and cache baselines, including provably owned unassigned drives", async () => {
  for (const machineId of ["assigned", undefined]) {
    const f = fixture(), old = f.legacy({ machineId: machineId ? f.machineA : undefined });
    const file = f.catalog(old._id), before = structuredClone(file);
    const result = await f.register(f.machineA);
    assert.deepEqual(result, { driveId: old._id, isNew: false, hasCatalog: true });
    assert.equal(old.identityVersion, 1); assert.equal(old.machineId, f.machineA);
    assert.deepEqual(f.rows("files")[0], before);
    assert.ok(f.reads.some(read => read.index === "by_drive_catalog_owner"));
    assert.ok(!f.reads.some(read => read.index === "by_drive_path"));
  }
});

test("empty legacy catalog preserves its drive ID but requests replay instead of trusting stale cache", async () => {
  const f = fixture(), old = f.legacy();
  assert.deepEqual(await f.register(f.machineA), { driveId: old._id, isNew: true, hasCatalog: false });
  await f.upload(f.machineA, old._id);
  assert.equal((await f.register(f.machineA)).isNew, false);
});

test("foreign and unassigned ownership beyond the first catalog row prevents legacy adoption", async () => {
  for (const ownership of [{ tenantId: "tenants:foreign" }, { machineId: "machines:foreign" }, { machineId: undefined }, { tenantId: undefined }]) {
    const f = fixture(), old = f.legacy();
    for (let i = 0; i < 210; i++) f.catalog(old._id, { path: `C:\\Studio\\own-${i}.dat` });
    f.catalog(old._id, { ...ownership, path: "C:\\Studio\\last.dat" });
    const before = structuredClone(old), allFiles = structuredClone(f.rows("files"));
    const result = await f.register(f.machineA);
    assert.notEqual(result.driveId, old._id); assert.equal(result.isNew, true);
    assert.deepEqual(old, before); assert.deepEqual(f.rows("files"), allFiles);
  }
});

test("a different machine never adopts a legacy drive, even when empty", async () => {
  const f = fixture(), old = f.legacy(), before = structuredClone(old);
  assert.notEqual((await f.register(f.machineB)).driveId, old._id);
  assert.deepEqual(old, before);
});

test("agent removal and its bounded purge affect only the calling machine's same-path drive", async () => {
  const f = fixture(), a = await f.register(f.machineA), b = await f.register(f.machineB);
  await f.upload(f.machineA, a.driveId); await f.upload(f.machineB, b.driveId, true);
  const response = await f.request("removeDrive", { ...f.registration(f.machineB), tenantId: "tenants:spoof" });
  assert.equal(response.status, 200); assert.equal((await response.json()).removed, true);
  assert.deepEqual(f.rows("drives").map(row => row._id), [b.driveId]);
  assert.equal(f.scheduled[0].args.machineId, f.machineA);
  await drives.purgeDriveFiles.handler(f.ctx, f.scheduled[0].args);
  assert.deepEqual(f.rows("files").map(row => row.driveId), [b.driveId]);
  assert.equal((await drives.removeByVolumeId.handler(f.ctx, f.registration(f.machineA))).removed, false);
});

test("ambiguous legacy removal refuses deletion, including an empty unassigned drive", async () => {
  for (const empty of [false, true]) {
    const f = fixture(), old = f.legacy({ machineId: empty ? undefined : f.machineA });
    if (!empty) { f.catalog(old._id); f.catalog(old._id, { machineId: f.machineB, path: "C:\\Studio\\other.dat" }); }
    const before = structuredClone(f.rows("files"));
    const result = await drives.removeByVolumeId.handler(f.ctx, f.registration(f.machineA));
    assert.deepEqual(result, { removed: false, reason: "legacy_catalog_ownership_conflict" });
    assert.equal(f.rows("drives")[0]._id, old._id); assert.deepEqual(f.rows("files"), before); assert.equal(f.scheduled.length, 0);
  }
});

test("canonical ownership corruption fails closed instead of producing another identity", async () => {
  const f = fixture(), registered = await f.register(f.machineA);
  f.catalog(registered.driveId, { machineId: f.machineB });
  await assert.rejects(f.register(f.machineA), /Drive catalog ownership conflict/);
  assert.equal(f.rows("drives").length, 1);
  assert.equal((await drives.removeByVolumeId.handler(f.ctx, f.registration(f.machineA))).removed, false);
});

test("HTTP registration binds machine identity to the token despite forged labels, IDs and tenants", async () => {
  const f = fixture();
  const machine = await f.request("registerMachine", { name: "Issued B", machineId: f.machineB, tenantId: "tenants:spoof", ownerId: "synthetic", agentVersion: "1.2.1", platform: "win32" });
  assert.equal(machine.status, 200); assert.equal((await machine.json()).machineId, f.machineA);
  assert.equal(f.rows("machines").length, 2); assert.equal(f.rows("machines")[0].name, "Issued A");
  const response = await f.request("registerDrive", f.registration(f.machineB, { tenantId: "tenants:spoof" }));
  assert.equal(response.status, 200);
  assert.equal(f.rows("drives")[0].machineId, f.machineA); assert.equal(f.rows("drives")[0].tenantId, f.tenantId);
  const unauthenticated = await f.request("registerDrive", f.registration(f.machineA), "unknown");
  assert.equal(unauthenticated.status, 401);
});

test("internal agent mutations reject absent, unknown and cross-tenant machine identities", async () => {
  const f = fixture(), foreign = f.add("machines", { tenantId: "tenants:foreign" });
  for (const machineId of [undefined, "machines:missing", foreign._id]) {
    await assert.rejects(f.register(machineId, { machineId }), /Unknown authenticated machine/);
    await assert.rejects(drives.removeByVolumeId.handler(f.ctx, f.registration(machineId, { machineId })), /Unknown authenticated machine/);
  }
  assert.equal(f.rows("drives").length, 0);
});

test("dashboard exact-ID removal purges all tenant-owned legacy rows while preserving foreign tenant rows", async () => {
  const f = fixture(), old = f.legacy();
  f.catalog(old._id); f.catalog(old._id, { machineId: f.machineB });
  f.catalog(old._id, { tenantId: "tenants:foreign", machineId: "machines:foreign" });
  assert.deepEqual(await drives.remove.handler(f.ctx, { driveId: old._id }), { removed: true });
  assert.equal(f.scheduled[0].args.machineId, undefined);
  await drives.purgeDriveFiles.handler(f.ctx, f.scheduled[0].args);
  assert.deepEqual(f.rows("files").map(row => row.tenantId), ["tenants:foreign"]);
});

test("new scoped purges reschedule with identical ownership and old scheduled purges remain executable", async () => {
  const f = fixture(), old = f.legacy();
  for (let i = 0; i < 501; i++) f.catalog(old._id);
  f.catalog(old._id, { machineId: f.machineB });
  const args = { driveId: old._id, tenantId: f.tenantId, machineId: f.machineA, deleted: 0 };
  await drives.purgeDriveFiles.handler(f.ctx, args);
  assert.equal(f.rows("files").length, 2); assert.deepEqual(f.scheduled[0].args, { ...args, deleted: 500 });
  await drives.purgeDriveFiles.handler(f.ctx, f.scheduled[0].args);
  assert.equal(f.rows("files")[0].machineId, f.machineB);
  await drives.purgeDriveFiles.handler(f.ctx, { driveId: old._id, deleted: 0 });
  assert.equal(f.rows("files").length, 0);
});
