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
  return { source, destination, filename, open: () => new OperationJournal(filename, "local:job-1") };
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
