import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createProcessLock } from "./scanLock.js";

function fixture(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveos-lock-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return path.join(root, "scan.lock");
}

function message(child: ChildProcess): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Lock worker did not respond")), 10_000);
    const receive = (value: unknown) => finish(undefined, value);
    const exit = () => finish(new Error("Lock worker exited before responding"));
    function finish(error?: Error, value?: unknown) {
      clearTimeout(timeout);
      child.off("message", receive);
      child.off("exit", exit);
      if (error) reject(error); else resolve(value);
    }
    child.once("message", receive);
    child.once("exit", exit);
  });
}

async function command(child: ChildProcess, value: string): Promise<any> {
  const response = message(child);
  child.send(value);
  return response;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill();
  await exited;
}

async function worker(t: test.TestContext, lockPath: string): Promise<ChildProcess> {
  const source = `
    import { createProcessLock } from ${JSON.stringify(new URL("./scanLock.js", import.meta.url).href)};
    const lock = createProcessLock(process.argv[1]);
    process.on('message', async (value) => {
      if (value === 'acquire') process.send({ acquired: await lock.acquire(), reason: lock.lastFailure });
      if (value === 'release') { await lock.release(); process.send({ released: true }); }
    });
    process.send({ ready: true });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, lockPath], { windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  t.after(() => stop(child));
  assert.equal((await message(child)).ready, true);
  return child;
}

test("simultaneous processes grant one lock and transfer it after release", async t => {
  const lockPath = fixture(t);
  const children = await Promise.all(Array.from({ length: 4 }, () => worker(t, lockPath)));
  const results = await Promise.all(children.map(child => command(child, "acquire")));
  assert.equal(results.filter(result => result.acquired).length, 1);
  const winner = results.findIndex(result => result.acquired);
  const next = (winner + 1) % children.length;
  assert.match(results[next].reason, /lock (port|pipe).*unavailable/);
  assert.equal((await command(children[winner], "release")).released, true);
  assert.equal((await command(children[next], "acquire")).acquired, true);
  await command(children[next], "release");
});

test("a killed lock owner can be replaced without waiting for an age deadline", async t => {
  const lockPath = fixture(t);
  const first = await worker(t, lockPath);
  assert.equal((await command(first, "acquire")).acquired, true);
  await stop(first);
  const second = createProcessLock(lockPath);
  t.after(() => second.release());
  assert.equal(await second.acquire(), true);
  await second.release();
});

test("a live legacy owner is protected beyond the old 30-minute deadline", async t => {
  const lockPath = fixture(t);
  const legacy = await worker(t, lockPath);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: legacy.pid, at: Date.now() - 24 * 60 * 60 * 1000 }));
  const lock = createProcessLock(lockPath);
  t.after(() => lock.release());
  assert.equal(await lock.acquire(), false);
  assert.match(lock.lastFailure!, /older agent process/);
  await stop(legacy);
  assert.equal(await lock.acquire(), true);
  await lock.release();
});

test("a live OS lock owner is never replaced because its metadata is old", async t => {
  const lockPath = fixture(t);
  const first = createProcessLock(lockPath);
  const second = createProcessLock(lockPath);
  t.after(() => first.release());
  t.after(() => second.release());
  assert.equal(await first.acquire(), true);
  const record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  fs.writeFileSync(lockPath, JSON.stringify({ ...record, at: 1 }));
  assert.equal(await second.acquire(), false);
  await first.release();
  assert.equal(await second.acquire(), true);
  await second.release();
});

test("release does not remove another owner's metadata", async t => {
  const lockPath = fixture(t);
  const lock = createProcessLock(lockPath);
  t.after(() => lock.release());
  assert.equal(await lock.acquire(), true);
  const record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const replacement = { ...record, token: "replacement-owner" };
  fs.writeFileSync(lockPath, JSON.stringify(replacement));
  await lock.release();
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")), replacement);
  // Current-transport metadata's stale/reused PID cannot prevent recovery once
  // its OS lock is free (v3 named pipes on Windows, v2 TCP elsewhere).
  assert.equal(await lock.acquire(), true);
  await lock.release();
});

test("Windows named-pipe locks work when TCP bind is denied", { skip: process.platform !== "win32" }, async t => {
  const lockPath = fixture(t);
  const listen = net.Server.prototype.listen;
  let tcpAttempts = 0;
  t.mock.method(net.Server.prototype, "listen", function (this: net.Server, ...args: any[]) {
    const options = args[0];
    if (options && typeof options === "object" && "port" in options) {
      tcpAttempts++;
      queueMicrotask(() => this.emit("error", Object.assign(new Error("TCP is reserved"), { code: "EACCES" })));
      return this;
    }
    return (listen as any).apply(this, args);
  } as typeof listen);
  const lock = createProcessLock(lockPath);
  t.after(() => lock.release());
  assert.equal(await lock.acquire(), true);
  const record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(record.version, 3);
  assert.equal(record.transport, "pipe");
  assert.equal(tcpAttempts, 0);
  await lock.release();
});

test("Windows named-pipe first-instance binding rejects another process without metadata", { skip: process.platform !== "win32" }, async t => {
  const lockPath = fixture(t);
  const canonical = path.join(fs.realpathSync.native(path.dirname(lockPath)), path.basename(lockPath)).toLowerCase();
  const pipeName = `\\\\.\\pipe\\driveos-lock-${crypto.createHash("sha256").update(canonical).digest("hex")}`;
  const source = `
    import net from 'node:net';
    const server = net.createServer(socket => socket.destroy());
    server.listen({ path: process.argv[1], exclusive: true }, () => process.send({ ready: true }));
  `;
  const owner = spawn(process.execPath, ["--input-type=module", "--eval", source, pipeName], {
    windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  t.after(() => stop(owner));
  assert.equal((await message(owner)).ready, true);
  assert.equal(fs.existsSync(lockPath), false);
  const lock = createProcessLock(lockPath);
  t.after(() => lock.release());
  assert.equal(await lock.acquire(), false);
  assert.match(lock.lastFailure!, /lock pipe.*unavailable/);
  await stop(owner);
  assert.equal(await lock.acquire(), true);
  await lock.release();
});

test("Windows upgrade waits for a live v2 TCP owner even when the v1 guard is disabled", { skip: process.platform !== "win32" }, async t => {
  const lockPath = fixture(t);
  const source = `
    import fs from 'node:fs';
    import net from 'node:net';
    const server = net.createServer(socket => socket.destroy());
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      fs.writeFileSync(process.argv[1], JSON.stringify({ kind: 'driveos-process-lock', version: 2,
        pid: process.pid, token: 'legacy-tcp-owner', host: '127.0.0.1', port: server.address().port, at: 1 }));
      process.send({ ready: true });
    });
  `;
  const owner = spawn(process.execPath, ["--input-type=module", "--eval", source, lockPath], {
    windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  t.after(() => stop(owner));
  assert.equal((await message(owner)).ready, true);
  const lock = createProcessLock(lockPath, { honorLegacyOwner: false });
  t.after(() => lock.release());
  assert.equal(await lock.acquire(), false);
  assert.match(lock.lastFailure!, /older agent process/);
  await stop(owner);
  assert.equal(await lock.acquire(), true);
  await lock.release();
});
