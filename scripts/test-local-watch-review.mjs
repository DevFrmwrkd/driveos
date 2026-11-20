// PR 59 regressions against an auth-configured disposable loopback backend.
// Uses two real CLI agent homes and a real watcher; never accepts hosted URLs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backendUrl = process.env.DRIVEOS_TEST_URL || "http://127.0.0.1:3210";
const siteUrl = process.env.DRIVEOS_TEST_SITE_URL || "http://127.0.0.1:3211";
for (const url of [backendUrl, siteUrl]) assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname), "Loopback endpoints are required.");
const fixture = fs.mkdtempSync(path.join(process.env.DRIVEOS_TEST_DIRECTORY || os.tmpdir(), "driveos-watch-review-"));
const media = path.join(fixture, "media");
const sub = path.join(media, "06_RENDERS_CACHE");
const home = path.join(fixture, "first-agent");
const secondHome = path.join(fixture, "second-agent");
const entry = path.join(repository, "apps/agent/dist/index.js");
const client = new ConvexHttpClient(backendUrl, { logger: false });
const results = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = name => { results.push({ name, status: "passed" }); process.stdout.write(`PASS ${name}\n`); };
const environment = agentHome => ({ ...process.env, DRIVEOS_AGENT_HOME: agentHome, DRIVEOS_CONVEX_URL: siteUrl });
const readCache = () => JSON.parse(fs.readFileSync(path.join(home, "driveos-hash-cache.json"), "utf8"));
const queryFiles = driveId => client.query(anyApi.files.list, { driveId, limit: 50 });
let watcher, output = "";

function write(file, byte) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 17, byte));
  const old = new Date(Date.now() - 120_000); fs.utimesSync(file, old, old);
  return `${file}-${fs.statSync(file).size}`;
}
async function agent(args, label, agentHome = home) {
  const child = spawn(process.execPath, [entry, ...args], { cwd: repository, env: environment(agentHome), stdio: ["ignore", "pipe", "pipe"] });
  let text = ""; child.stdout.on("data", data => text += data); child.stderr.on("data", data => text += data);
  const timer = setTimeout(() => child.kill(), 30_000);
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }).finally(() => clearTimeout(timer));
  fs.writeFileSync(path.join(fixture, `${label}.log`), text);
  assert.equal(code, 0, `${label} must succeed; inspect its fixture log`);
}
async function waitFor(read, ready, label, timeout = 90_000) {
  const start = Date.now(); let next = 15_000;
  while (Date.now() - start < timeout) {
    if (watcher && (watcher.exitCode !== null || watcher.signalCode !== null)) throw new Error(`Watcher exited during ${label}`);
    const value = await read(); if (ready(value)) return value;
    if (Date.now() - start >= next) { process.stdout.write(`Waiting for ${label} (${Math.round((Date.now() - start) / 1000)}s)…\n`); next += 15_000; }
    await delay(250);
  }
  throw new Error(`Timeout: ${label}`);
}
async function api(token, operation, body) {
  const response = await fetch(`${siteUrl}/api/${operation}`, { method: "POST", headers: {
    "Content-Type": "application/json", Authorization: `Bearer ${token}`,
  }, body: JSON.stringify(body) });
  assert.equal(response.status, 200, `${operation} must succeed`);
  const result = await response.json(); assert.equal(result.success, true); return result;
}

try {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const email = `qa-watch-review-${stamp}@driveos.test`;
  const login = await client.action(anyApi.auth.signIn, { provider: "password", params: {
    flow: "signUp", email, password: "DriveOS-local-QA-2026!", name: "Watcher review QA", orgName: "DriveOS Watcher Review QA",
  } });
  assert.ok(login.tokens?.token); client.setAuth(login.tokens.token);
  const first = await client.mutation(anyApi.agentAuth.issueMachineToken, { machineName: `WatchReview-A-${stamp}` });
  const second = await client.mutation(anyApi.agentAuth.issueMachineToken, { machineName: `WatchReview-B-${stamp}` });
  const parentOnly = path.join(sub, "parent-catalog.dat");
  const parentKey = write(parentOnly, 65);
  write(path.join(media, "unrelated.wav"), 66);
  for (const [machine, agentHome, label] of [[first, home, "first"], [second, secondHome, "second"]]) {
    await agent(["init", "--machine", machine.machineName, "--owner", email, "--convex", siteUrl, "--auth-token", machine.token,
      "--roots", media, "--central-quarantine", "--quarantine", path.join(fixture, `${label}-quarantine`)], `${label}-init`, agentHome);
  }
  await agent(["scan", "--path", media, "--full-hash"], "parent-scan");
  const initial = await client.query(anyApi.files.list, { limit: 20 });
  const parentRow = initial.find(file => file.path === parentOnly);
  assert.ok(parentRow); const driveId = parentRow.driveId;
  await agent(["scan", "--path", media, "--full-hash"], "second-machine-scan", secondHome);
  const all = await client.query(anyApi.files.list, { limit: 20 });
  const secondRow = all.find(file => file.path === parentOnly && file.machineId === second.machineId);
  assert.ok(secondRow); assert.notEqual(secondRow.driveId, driveId);
  assert.equal((await client.query(anyApi.drives.get, { driveId })).machineId, first.machineId);
  assert.equal((await queryFiles(driveId)).length, 2);
  record("two agent homes scanning the same path retain separate machine-owned drives and files");

  await agent(["scan", "--path", sub, "--full-hash"], "overlapping-subfolder-scan");
  const foreignReceipt = readCache()[parentKey].catalogReceipt;
  assert.ok(foreignReceipt); assert.notEqual(foreignReceipt.fileId, parentRow._id);
  const subRows = await client.query(anyApi.files.list, { limit: 50 });
  const subRow = subRows.find(file => file._id === foreignReceipt.fileId);
  assert.ok(subRow); assert.notEqual(subRow.driveId, driveId);
  watcher = spawn(process.execPath, [entry, "watch", "--path", media, "--interval-minutes", "1", "--debounce-seconds", "1"], {
    cwd: repository, env: environment(home), stdio: ["ignore", "pipe", "pipe"],
  });
  const append = data => { output += data; fs.appendFileSync(path.join(fixture, "watcher.log"), data); };
  watcher.stdout.on("data", append); watcher.stderr.on("data", append);
  await waitFor(async () => output, text => text.includes("[Watcher Started]"), "watcher startup", 15_000);
  await delay(2000);
  await agent(["pause"], "pause");
  fs.unlinkSync(parentOnly);

  // The watcher has no acknowledged snapshot for this new file. A separate
  // scanner persists its receipt while the watcher is paused, then its entire
  // containing directory is removed before the watcher has uploaded anything.
  const external = path.join(sub, "manual-subtree", "external.dat");
  const externalKey = write(external, 67);
  await delay(3500);
  await agent(["scan", "--path", media, "--full-hash"], "external-manual-scan");
  assert.ok((await queryFiles(driveId)).some(file => file.path === external));
  const olderReceipt = readCache()[externalKey].catalogReceipt;
  assert.ok(olderReceipt);
  // Older scanners spread unknown cache fields: preserve receipt v1 while a
  // successful changed-file scan writes fingerprint v2. Reproduce that exact
  // disk-cache state after a real backend upload, without forging any receipt.
  write(external, 68);
  await delay(3500);
  await agent(["scan", "--path", media, "--full-hash"], "changed-external-manual-scan");
  const mixedCache = readCache();
  assert.ok(mixedCache[externalKey].catalogReceipt.catalogVersion > olderReceipt.catalogVersion);
  mixedCache[externalKey].catalogReceipt = olderReceipt;
  fs.writeFileSync(path.join(home, "driveos-hash-cache.json"), JSON.stringify(mixedCache));
  fs.unlinkSync(external); fs.rmdirSync(path.dirname(external));
  await delay(1500);
  assert.ok((await queryFiles(driveId)).some(file => file._id === parentRow._id));
  await agent(["resume"], "resume");
  await waitFor(() => queryFiles(driveId), rows => !rows.some(file => [parentOnly, external].includes(file.path)), "correct-scope and shared-cache unlink reconciliation");
  record("an overlapping subfolder receipt is bootstrapped for the watched parent drive");
  record("a file catalogued by another scanner is reconciled after its whole containing folder is deleted");
  record("a newer uploaded fingerprint supersedes a stale receipt preserved by an older scanner");
  assert.ok((await queryFiles(subRow.driveId)).some(file => file._id === subRow._id));
  assert.ok((await queryFiles(secondRow.driveId)).some(file => file._id === secondRow._id));
  assert.ok((await queryFiles(driveId)).some(file => file.path.endsWith("unrelated.wav")));
  record("watcher reconciliation preserves other drives, other machines and unrelated live files");

  await api(second.token, "removeDrive", { volumeId: `${process.platform}:${media}`, machineId: first.machineId });
  assert.equal(await client.query(anyApi.drives.get, { driveId: secondRow.driveId }), null);
  assert.ok(await client.query(anyApi.drives.get, { driveId }));
  assert.ok(await client.query(anyApi.drives.get, { driveId: subRow.driveId }));
  assert.ok(fs.existsSync(path.join(media, "unrelated.wav")));
  record("token-scoped drive removal cannot remove a same-path drive belonging to another machine");
} catch (error) {
  process.exitCode = 1; results.push({ name: "watcher review regression", status: "failed", error: String(error?.stack || error) });
  process.stderr.write(`FAIL ${error?.stack || error}\n`);
} finally {
  if (watcher && watcher.exitCode === null && watcher.signalCode === null) {
    const stopped = new Promise(resolve => watcher.once("exit", resolve)); watcher.kill(); await stopped;
  }
  fs.writeFileSync(path.join(fixture, "summary.json"), JSON.stringify({ fixture, results }, null, 2));
  process.stdout.write(`Watcher review evidence: ${fixture}\n`);
}
