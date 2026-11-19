import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { OperationJournal } from "./operationJournal.js";

function setup(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveos-recovery-"));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, "source.dat"), destination = path.join(root, "quarantine", "source.dat"), filename = path.join(root, "journal.json");
  fs.writeFileSync(source, "irreplaceable bytes");
  return { root, source, destination, filename, open: () => new OperationJournal(filename, "local:job-1") };
}

function mountedFixture(t: test.TestContext) {
  const f = setup(t);
  const mount = path.join(f.root, "mounted-drive");
  const detached = path.join(f.root, "detached-drive");
  fs.mkdirSync(mount);
  const source = path.join(mount, "quarantined.dat");
  fs.renameSync(f.source, source);
  return { ...f, source, mount, detached };
}

function interruptPurgeBeforeUnlink(t: test.TestContext, f: ReturnType<typeof mountedFixture>) {
  t.mock.method(fs, "unlinkSync", () => { throw new Error("interrupted before unlink"); });
  assert.throws(() => f.open().purge("item-1", f.source), /interrupted before unlink/);
  t.mock.restoreAll();
  assert.equal(JSON.parse(fs.readFileSync(f.filename, "utf8")).operations["item-1"].state, "prepared");
}

function detach(f: ReturnType<typeof mountedFixture>) {
  assert.equal(path.dirname(path.resolve(f.mount)), path.resolve(f.root));
  assert.equal(path.dirname(path.resolve(f.detached)), path.resolve(f.root));
  fs.renameSync(f.mount, f.detached);
}

test("a new process reconciles a move interrupted after unlink and before its receipt", t => {
  const f = setup(t);
  const rename = fs.renameSync;
  let writes = 0;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    if (++writes === 2) throw new Error("simulated interruption after file move");
    return rename(...args);
  });
  assert.throws(() => f.open().move("file-1", f.source, f.destination), /simulated interruption/);
  assert.equal(fs.existsSync(f.source), false);
  t.mock.restoreAll();
  f.open().move("file-1", f.source, f.destination);
  assert.equal(fs.readFileSync(f.destination, "utf8"), "irreplaceable bytes");
  f.open().move("file-1", f.source, f.destination);
});

test("recovery completes a verified copy left alongside its original", t => {
  const f = setup(t);
  t.mock.method(fs, "unlinkSync", () => { throw new Error("simulated interruption before unlink"); });
  assert.throws(() => f.open().move("file-1", f.source, f.destination), /simulated interruption/);
  t.mock.restoreAll();
  assert.equal(fs.existsSync(f.source), true);
  f.open().move("file-1", f.source, f.destination);
  assert.equal(fs.existsSync(f.source), false);
  assert.equal(fs.readFileSync(f.destination, "utf8"), "irreplaceable bytes");
});

test("a conflicting interrupted destination is preserved and never acknowledged", t => {
  const f = setup(t);
  t.mock.method(fs, "linkSync", () => { throw new Error("simulated interruption before move"); });
  assert.throws(() => f.open().move("file-1", f.source, f.destination));
  t.mock.restoreAll();
  fs.writeFileSync(f.destination, "unrelated replacement");
  assert.throws(() => f.open().move("file-1", f.source, f.destination), /does not match/);
  assert.equal(fs.readFileSync(f.source, "utf8"), "irreplaceable bytes");
  assert.equal(fs.readFileSync(f.destination, "utf8"), "unrelated replacement");
});

test("pre-existing destinations are rejected before intent is recorded", t => {
  const f = setup(t);
  fs.mkdirSync(path.dirname(f.destination)); fs.copyFileSync(f.source, f.destination);
  const journal = f.open();
  assert.throws(() => journal.move("file-1", f.source, f.destination), /already exists/);
  assert.equal(journal.has("file-1"), false);
});

test("purge recovers after deletion but never assumes an unjournaled missing file succeeded", t => {
  const f = setup(t);
  const rename = fs.renameSync;
  let writes = 0;
  t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
    if (++writes === 2) throw new Error("simulated interruption after deletion");
    return rename(...args);
  });
  assert.throws(() => f.open().purge("item-1", f.source), /simulated interruption/);
  t.mock.restoreAll();
  assert.equal(f.open().purge("item-1", f.source), 19);
  assert.throws(() => f.open().purge("unrecorded-item", f.source), { code: "ENOENT" });
  fs.writeFileSync(f.source, "new content");
  assert.throws(() => f.open().purge("item-1", f.source), /new file appeared/);
  assert.equal(fs.readFileSync(f.source, "utf8"), "new content");
});

test("restore retries preserve a newly-created original and journal scope is checked", t => {
  const f = setup(t);
  t.mock.method(fs, "linkSync", () => { throw new Error("interrupted restore"); });
  assert.throws(() => f.open().move("restore-1", f.source, f.destination));
  t.mock.restoreAll();
  fs.writeFileSync(f.destination, "new original");
  assert.throws(() => f.open().move("restore-1", f.source, f.destination), /does not match/);
  assert.throws(() => new OperationJournal(f.filename, "another:job-1"), /invalid/);
  assert.equal(fs.readFileSync(f.source, "utf8"), "irreplaceable bytes");
});

test("a replacement at an already-moved original path is preserved for reconciliation", t => {
  const f = setup(t);
  f.open().move("file-1", f.source, f.destination);
  fs.writeFileSync(f.source, "new original");
  assert.throws(() => f.open().move("file-1", f.source, f.destination), /original path was recreated/);
  assert.equal(fs.readFileSync(f.source, "utf8"), "new original");
  assert.equal(fs.readFileSync(f.destination, "utf8"), "irreplaceable bytes");
});

test("a disconnected purge volume remains pending and its detached file is preserved", t => {
  const f = mountedFixture(t);
  interruptPurgeBeforeUnlink(t, f);
  detach(f);
  assert.throws(() => f.open().purge("item-1", f.source), /Cannot verify the quarantine directory/);
  assert.equal(fs.readFileSync(path.join(f.detached, "quarantined.dat"), "utf8"), "irreplaceable bytes");
  assert.equal(JSON.parse(fs.readFileSync(f.filename, "utf8")).operations["item-1"].state, "prepared");
});

test("a replacement mount at the same path is not evidence that the old file was deleted", t => {
  const f = mountedFixture(t);
  interruptPurgeBeforeUnlink(t, f);
  detach(f);
  fs.mkdirSync(f.mount);
  assert.throws(() => f.open().purge("item-1", f.source), /directory or volume changed/);
  assert.equal(fs.readFileSync(path.join(f.detached, "quarantined.dat"), "utf8"), "irreplaceable bytes");
  assert.equal(JSON.parse(fs.readFileSync(f.filename, "utf8")).operations["item-1"].state, "prepared");
});

test("unreadable purge parents and permission-denied file probes cannot confirm a deletion", t => {
  const f = mountedFixture(t);
  interruptPurgeBeforeUnlink(t, f);
  fs.unlinkSync(f.source);
  t.mock.method(fs, "opendirSync", () => { throw Object.assign(new Error("access denied"), { code: "EACCES" }); });
  assert.throws(() => f.open().purge("item-1", f.source), /Cannot verify the quarantine directory/);
  t.mock.restoreAll();
  const lstat = fs.lstatSync;
  t.mock.method(fs, "lstatSync", ((filename: fs.PathLike, ...args: any[]) => {
    if (String(filename) === f.source) throw Object.assign(new Error("file access denied"), { code: "EACCES" });
    return (lstat as any)(filename, ...args);
  }) as typeof fs.lstatSync);
  assert.throws(() => f.open().purge("item-1", f.source), /file access denied/);
  t.mock.restoreAll();
  assert.equal(JSON.parse(fs.readFileSync(f.filename, "utf8")).operations["item-1"].state, "prepared");
  assert.equal(f.open().purge("item-1", f.source), 19);
});

test("completed purge receipts require the original directory to remain available", t => {
  const f = mountedFixture(t);
  assert.equal(f.open().purge("item-1", f.source), 19);
  detach(f);
  assert.throws(() => f.open().purge("item-1", f.source), /Cannot verify the quarantine directory/);
  fs.mkdirSync(f.mount);
  assert.throws(() => f.open().purge("item-1", f.source), /directory or volume changed/);
});

test("old purge journals upgrade only while the verified source is still present", t => {
  const f = mountedFixture(t);
  interruptPurgeBeforeUnlink(t, f);
  const data = JSON.parse(fs.readFileSync(f.filename, "utf8"));
  delete data.operations["item-1"].purgeParent;
  fs.writeFileSync(f.filename, JSON.stringify(data));
  assert.equal(f.open().purge("item-1", f.source), 19);
  assert.ok(JSON.parse(fs.readFileSync(f.filename, "utf8")).operations["item-1"].purgeParent);
});

test("old purge journals without directory evidence fail closed when the source is absent", t => {
  for (const state of ["prepared", "done"]) {
    const f = mountedFixture(t);
    interruptPurgeBeforeUnlink(t, f);
    fs.unlinkSync(f.source);
    const data = JSON.parse(fs.readFileSync(f.filename, "utf8"));
    delete data.operations["item-1"].purgeParent;
    data.operations["item-1"].state = state;
    fs.writeFileSync(f.filename, JSON.stringify(data));
    assert.throws(() => f.open().purge("item-1", f.source), /older purge journal has no directory identity/);
    assert.equal(JSON.parse(fs.readFileSync(f.filename, "utf8")).operations["item-1"].state, state);
  }
});
