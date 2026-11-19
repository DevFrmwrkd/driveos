// Real interrupted-agent regressions against an already running local backend.
// Build the agent first. Every source and deletion target is freshly generated.
// Optional DRIVEOS_TEST_EXPIRE_FIXTURE points to a disposable local Convex app
// with the fixture-only qaRecovery:expireLease helper; otherwise leases expire
// naturally. This file never creates a production/test helper in repo sources.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = process.env.DRIVEOS_TEST_URL || "http://127.0.0.1:3210";
const siteUrl = process.env.DRIVEOS_TEST_SITE_URL || "http://127.0.0.1:3211";
for (const value of [backendUrl, siteUrl]) {
  const url = new URL(value);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Recovery tests require loopback URLs.");
}
const fixture = fs.mkdtempSync(path.join(process.env.DRIVEOS_TEST_DIRECTORY || os.tmpdir(), "driveos-recovery-e2e-"));
const media = path.join(fixture, "media");
const agentHome = path.join(fixture, "agent-home");
const quarantineRoot = path.join(fixture, "quarantine");
const email = `qa-recovery-${Date.now()}@driveos.test`;
const password = "DriveOS-local-QA-2026!";
const client = new ConvexHttpClient(backendUrl, { logger: false });
const results = [];
const record = (name) => { results.push({ name, status: "passed" }); process.stdout.write(`PASS ${name}\n`); };
const query = (module, name, args = {}) => client.query(anyApi[module][name], args);
const mutation = (module, name, args = {}) => client.mutation(anyApi[module][name], args);
const digest = filename => crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let machine;
let currentChild;
let interrupted;
let armed;
let proxyUrl;

// Keep the configured URL identical across attempts: it is part of the journal
// identity. Drop exactly one terminal request, after the physical operation.
const proxy = http.createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const payload = body.length ? JSON.parse(body.toString("utf8")) : {};
    if (armed && request.url === "/api/updateJobStatus" && ["completed", "failed"].includes(payload.status) && (!armed.jobId || payload.jobId === armed.jobId)) {
      interrupted = payload;
      armed = undefined;
      currentChild?.kill("SIGKILL");
      response.destroy();
      return;
    }
    const upstream = await fetch(new URL(request.url, siteUrl), {
      method: request.method,
      headers: { "Content-Type": "application/json", Authorization: request.headers.authorization || "" },
      body: request.method === "GET" ? undefined : body,
    });
    response.writeHead(upstream.status, { "Content-Type": "application/json" });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    if (!response.destroyed) { response.writeHead(502); response.end(JSON.stringify({ error: error.message })); }
  }
});

async function command(args, label, env) {
  const child = spawn(process.execPath, args, { cwd: repository, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  currentChild = child;
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr += data; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    fs.writeFileSync(path.join(fixture, `${label}.log`), `${stdout}\n${stderr}`);
    return { ...status, stdout, stderr };
  } finally { clearTimeout(timer); if (currentChild === child) currentChild = undefined; }
}
async function agent(args, label = args[0], crash = false) {
  const result = await command([path.join(repository, "apps/agent/dist/index.js"), ...args], label,
    { ...process.env, DRIVEOS_AGENT_HOME: agentHome, DRIVEOS_CONVEX_URL: proxyUrl });
  if (!crash) assert.equal(result.code, 0, `${label}: ${result.stderr}`);
  else assert.ok(interrupted, `${label} must stop at a real terminal API request`);
  return result;
}
async function postAgent(endpoint, args, token = machine.token) {
  const response = await fetch(new URL(`/api/${endpoint}`, siteUrl), {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(args),
  });
  return { status: response.status, body: await response.json() };
}
async function fixtureFunction(name, args) {
  const localApp = process.env.DRIVEOS_TEST_EXPIRE_FIXTURE;
  assert.ok(localApp, "Fixture functions require an explicitly configured disposable app");
  const config = fs.readFileSync(path.join(localApp, ".env.local"), "utf8");
  assert.match(config, /^CONVEX_DEPLOYMENT=anonymous:/m, "Fixture helpers are restricted to an anonymous local app.");
  assert.ok(config.split(/\r?\n/).some(line => line === `CONVEX_URL=${backendUrl}`), "Fixture must point at this loopback backend.");
  return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(repository, "node_modules/convex/bin/main.js"), "run", name, JSON.stringify(args)], {
        cwd: path.resolve(localApp), env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
      child.once("error", reject); child.once("close", code => resolve({ code, output }));
    });
}
async function expireLease(jobId) {
  if (process.env.DRIVEOS_TEST_EXPIRE_FIXTURE) {
    const result = await fixtureFunction("qaRecovery:expireLease", { jobId });
    fs.writeFileSync(path.join(fixture, `expire-${jobId}.log`), `exit=${result.code}\n${result.output}`);
    // Some Windows Node/Convex CLI combinations abort during shutdown after a
    // successful function call. Verify the actual mutation, never its log alone.
    const expiredJob = (await postAgent("getJob", { jobId })).body.job;
    assert.ok(expiredJob?.leaseExpiresAt <= Date.now(), `Fixture lease did not expire: ${result.output}`);
  } else {
    let job;
    do {
      job = (await postAgent("getJob", { jobId })).body.job;
      assert.ok(job?.leaseExpiresAt, "Interrupted job must have an expiring lease");
      const remaining = job.leaseExpiresAt - Date.now();
      if (remaining <= 0) break;
      process.stdout.write(`Waiting for local job lease (${Math.ceil(remaining / 1000)}s remaining)\n`);
      await wait(Math.min(remaining + 100, 30_000));
    } while (true);
  }
}
function journalFor(key) {
  const directory = path.join(agentHome, "jobs");
  return fs.readdirSync(directory).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")))
    .find(journal => journal.operations?.[key]);
}
async function interruptJob(jobId, args, label) {
  interrupted = undefined;
  armed = { jobId };
  await agent(args, label, true);
  assert.equal(interrupted.jobId, jobId);
  const job = (await postAgent("getJob", { jobId })).body.job;
  assert.equal(job.status, "running");
  assert.equal("claimToken" in job, false);
  return interrupted;
}

try {
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const auth = await client.action(anyApi.auth.signIn, { provider: "password", params: { flow: "signUp", email, password, name: "Recovery QA", orgName: "DriveOS Recovery QA" } });
  assert.ok(auth.tokens?.token);
  client.setAuth(auth.tokens.token);
  machine = await mutation("agentAuth", "issueMachineToken", { machineName: `Recovery-${Date.now()}` });
  const source = path.join(media, "06_RENDERS_CACHE", "preview.dat");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, Buffer.alloc(2 * 1024 * 1024 + 77, 73));
  const originalChecksum = digest(source);
  const stable = new Date(Date.now() - 120_000); fs.utimesSync(source, stable, stable);
  await agent(["init", "--machine", machine.machineName, "--owner", email, "--convex", proxyUrl, "--auth-token", machine.token,
    "--roots", media, "--central-quarantine", "--quarantine", quarantineRoot], "init");
  await agent(["scan", "--path", media, "--full-hash"], "scan");
  const file = (await query("files", "list", { limit: 200 })).find(item => item.path === source);
  assert.ok(file);
  record("fresh synthetic cache file scans into an isolated workspace");

  const queued = await mutation("cleanup", "queueQuarantine", { fileIds: [file._id] });
  queued.jobId = queued.jobIds[0];
  assert.deepEqual((await postAgent("pollPendingJobs", {})).body, [], "Legacy poll must not receive lease-required jobs");
  const receipt = await interruptJob(queued.jobId, ["run-jobs"], "quarantine-crash");
  assert.equal(fs.existsSync(source), false);
  const firstDestination = receipt.quarantineFiles[0].quarantinePath;
  assert.equal(digest(firstDestination), originalChecksum);
  assert.equal((await query("cleanup", "listQuarantine")).length, 0, "Dropped terminal request must not reach backend");
  const durable = journalFor(file._id).operations[file._id];
  assert.equal(durable.destination, firstDestination); assert.equal(durable.state, "done");
  record("hard stop after quarantine move retains a durable receipt before backend confirmation");

  await expireLease(queued.jobId);
  const staleResult = await postAgent("updateJobStatus", receipt);
  assert.equal(staleResult.body.claimed, false); assert.equal(staleResult.body.reason, "lease_lost");
  const takeoverToken = crypto.randomUUID();
  assert.equal((await postAgent("updateJobStatus", { jobId: queued.jobId, status: "running", claimToken: takeoverToken })).body.claimed, true);
  assert.equal((await postAgent("updateJobStatus", { jobId: queued.jobId, status: "running", claimToken: receipt.claimToken })).body.claimed, false);
  assert.equal((await postAgent("updateJobStatus", receipt)).body.claimed, false);
  record("real backend fences expired receipts and the previous worker after takeover");
  await expireLease(queued.jobId);
  await agent(["run-jobs"], "quarantine-recovery");
  let items = await query("cleanup", "listQuarantine");
  assert.equal(items.length, 1); assert.equal(items[0].quarantinePath, firstDestination);
  assert.equal(digest(firstDestination), originalChecksum);
  assert.equal((await postAgent("getJob", { jobId: queued.jobId })).body.job.attempts, 3);
  assert.equal((await query("cleanup", "listJobs")).find(job => job._id === queued.jobId).status, "completed");
  record("restarted agent reuses the exact saved destination and registers one quarantine item");

  fs.writeFileSync(source, "A different synthetic replacement must survive the restore attempt.");
  const replacementChecksum = digest(source);
  const conflict = (await postAgent("requestRestore", { quarantineId: items[0]._id })).body;
  assert.ok(conflict.jobId);
  const rejectedRestore = await command([path.join(repository, "apps/agent/dist/index.js"), "restore", "--quarantineId", items[0]._id], "restore-conflict",
    { ...process.env, DRIVEOS_AGENT_HOME: agentHome, DRIVEOS_CONVEX_URL: proxyUrl });
  assert.notEqual(rejectedRestore.code, 0, "Conflicting CLI restore must exit with an error");
  assert.match(rejectedRestore.stderr, /already exists/i);
  assert.equal(digest(source), replacementChecksum);
  assert.equal(digest(firstDestination), originalChecksum);
  const failedRestore = (await postAgent("getJob", { jobId: conflict.jobId })).body.job;
  assert.equal(failedRestore.status, "failed");
  assert.match(failedRestore.result.error, /already exists/i);
  assert.equal((await query("cleanup", "listQuarantine"))[0].status, "quarantined");
  assert.ok(path.resolve(source).startsWith(path.resolve(fixture) + path.sep), "Remove only this test's known replacement file.");
  assert.equal(digest(source), replacementChecksum);
  fs.unlinkSync(source);
  record("a conflicting restore preserves both copies, fails visibly, and remains retryable");

  const restore = (await postAgent("requestRestore", { quarantineId: items[0]._id })).body;
  assert.ok(restore.jobId);
  assert.equal((await postAgent("requestRestore", { quarantineId: items[0]._id })).body.jobId, restore.jobId);
  await interruptJob(restore.jobId, ["restore", "--quarantineId", items[0]._id], "restore-crash");
  assert.equal(digest(source), originalChecksum); assert.equal(fs.existsSync(firstDestination), false);
  assert.equal((await query("cleanup", "listQuarantine"))[0].status, "pending_restore");
  await expireLease(restore.jobId);
  await agent(["restore", "--quarantineId", items[0]._id], "restore-recovery");
  assert.equal(digest(source), originalChecksum); assert.equal((await query("cleanup", "listQuarantine")).length, 0);
  record("CLI restore joins its idempotent job and recovers after the physical move");

  const again = await mutation("cleanup", "queueQuarantine", { fileIds: [file._id] });
  again.jobId = again.jobIds[0];
  await agent(["run-jobs"], "quarantine-before-purge");
  items = await query("cleanup", "listQuarantine");
  assert.equal(items.length, 1); assert.notEqual(items[0].quarantinePath, firstDestination);
  const purgePath = path.resolve(items[0].quarantinePath);
  assert.ok(purgePath.startsWith(path.resolve(quarantineRoot) + path.sep), "Delete only the newly generated quarantine fixture.");
  const purge = await mutation("cleanup", "purgeItem", { quarantineId: items[0]._id, requestedBy: email });
  await interruptJob(purge.jobId, ["run-jobs"], "purge-crash");
  assert.equal(fs.existsSync(purgePath), false);
  assert.equal((await query("cleanup", "listQuarantine"))[0].status, "pending_purge");
  assert.equal(journalFor(items[0]._id).operations[items[0]._id].kind, "purge");
  await expireLease(purge.jobId);
  await agent(["run-jobs"], "purge-recovery");
  assert.equal(fs.existsSync(purgePath), false); assert.equal((await query("cleanup", "listQuarantine")).length, 0);
  assert.equal((await query("cleanup", "listJobs")).find(job => job._id === purge.jobId).status, "completed");
  assert.equal((await postAgent("getJob", { jobId: again.jobId })).body.job.status, "completed");
  record("interrupted permanent deletion reconciles its recorded intent without deleting again");
  if (process.env.DRIVEOS_TEST_EXPIRE_FIXTURE) {
    const seeded = await fixtureFunction("qaRecovery:seedPollingBacklog", { machineId: machine.machineId });
    fs.writeFileSync(path.join(fixture, "seed-polling.log"), `exit=${seeded.code}\n${seeded.output}`);
    const probe = (await query("cleanup", "listJobs")).find(job => job.result?.qaPollingProbe);
    assert.ok(probe, "Disposable polling backlog must exist");
    const pending = (await postAgent("pollPendingJobs", { leaseProtocol: 1 })).body;
    assert.equal(pending[0]._id, probe._id, "Recovery has priority over approved jobs and ignores >200 old/fresh running jobs");
    assert.equal(pending.length, 4, "One response hydrates at most four jobs");
    assert.ok(pending.reduce((sum, job) => sum + job.affectedFileIds.length, 0) <= 4000);
    assert.equal((await postAgent("pollPendingJobs", {})).body.length, 0, "Old clients cannot take over recovery jobs");
    record("expired leases remain pollable behind 410 legacy or active jobs and responses stay bounded");
  }
  fs.writeFileSync(path.join(fixture, "summary.json"), JSON.stringify({ fixture, email, results }, null, 2));
  process.stdout.write(`Recovery evidence: ${fixture}\n`);
} catch (error) {
  fs.writeFileSync(path.join(fixture, "summary.json"), JSON.stringify({ fixture, email, results, failure: error.message }, null, 2));
  process.stderr.write(`FAIL ${error.stack}\nEvidence: ${fixture}\n`);
  process.exitCode = 1;
} finally {
  currentChild?.kill("SIGKILL");
  proxy.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve));
}
