import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { isRegenerablePath, verifyKeepCopy, type KeepCopyProof } from "./keepCopy.js";
import { OperationJournal } from "./operationJournal.js";

function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "driveos-keep-copy-"));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const source = path.join(root, "candidate.wav"), keep = path.join(root, "keep.wav");
  const bytes = "a unique piece of licensed music";
  fs.writeFileSync(source, bytes); fs.writeFileSync(keep, bytes);
  const fullHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const candidate = { fileId: "candidate", path: source, sizeBytes: Buffer.byteLength(bytes), fullHash };
  const proof: KeepCopyProof = { fileId: candidate.fileId, keepFileId: "keep", keepPath: keep, keepMachineId: "machine-a", fullHash, sizeBytes: candidate.sizeBytes };
  return { root, source, keep, bytes, candidate, proof };
}

test("a fresh distinct same-machine physical keep is required, not its catalog checksum", async t => {
  const f = fixture(t);
  await verifyKeepCopy(f.candidate, f.proof, "machine-a");
  fs.unlinkSync(f.keep);
  await assert.rejects(verifyKeepCopy(f.candidate, f.proof, "machine-a"), { code: "ENOENT" });
  assert.equal(fs.readFileSync(f.source, "utf8"), f.bytes);
});

test("changed keep content is rejected even when its size and modification time are preserved", async t => {
  const f = fixture(t);
  const original = fs.statSync(f.keep);
  fs.writeFileSync(f.keep, "X".repeat(f.candidate.sizeBytes));
  fs.utimesSync(f.keep, original.atime, original.mtime);
  await assert.rejects(verifyKeepCopy(f.candidate, f.proof, "machine-a"), /content changed/);
  assert.equal(fs.readFileSync(f.source, "utf8"), f.bytes);
});

test("missing, foreign-machine, wrong-file, same-id and same-path proofs fail closed", async t => {
  const f = fixture(t);
  await assert.rejects(verifyKeepCopy(f.candidate, undefined, "machine-a"), /keep-copy proof/);
  for (const proof of [
    { ...f.proof, keepMachineId: "machine-b" }, { ...f.proof, fileId: "another-file" },
    { ...f.proof, keepFileId: f.candidate.fileId }, { ...f.proof, sizeBytes: f.proof.sizeBytes + 1 },
  ]) await assert.rejects(verifyKeepCopy(f.candidate, proof, "machine-a"), /keep-copy proof/);
  await assert.rejects(verifyKeepCopy(f.candidate, { ...f.proof, keepPath: f.source }, "machine-a"), /separate path and physical file identity/);
});

test("a hard link does not count as a separate physical keep copy", async t => {
  const f = fixture(t);
  fs.unlinkSync(f.keep); fs.linkSync(f.source, f.keep);
  await assert.rejects(verifyKeepCopy(f.candidate, f.proof, "machine-a"), /separate path and physical file identity/);
});

test("a changed candidate cannot be purged merely because its old keep copy still matches", async t => {
  const f = fixture(t);
  fs.writeFileSync(f.source, "Z".repeat(f.candidate.sizeBytes));
  await assert.rejects(verifyKeepCopy(f.candidate, f.proof, "machine-a"), /content changed/);
  assert.equal(fs.readFileSync(f.keep, "utf8"), f.bytes);
});

test("a keep disappearing after hashing still blocks the journal's final unlink", async t => {
  const f = fixture(t);
  const stillCurrent = await verifyKeepCopy(f.candidate, f.proof, "machine-a");
  fs.unlinkSync(f.keep);
  const journal = new OperationJournal(path.join(f.root, "journal.json"), "keep-copy-race");
  assert.throws(() => journal.purge("candidate", f.source, stillCurrent), { code: "ENOENT" });
  assert.equal(fs.readFileSync(f.source, "utf8"), f.bytes);
  assert.equal(journal.completed("candidate"), false);
});

test("post-hash keep edits cannot hide behind a restored size and modification time", async t => {
  const f = fixture(t);
  const before = fs.statSync(f.keep);
  const stillCurrent = await verifyKeepCopy(f.candidate, f.proof, "machine-a");
  // Keep this deterministic on filesystems whose change timestamp has coarse
  // resolution; no mutation occurs until after the verified snapshot exists.
  await new Promise(resolve => setTimeout(resolve, 20));
  fs.writeFileSync(f.keep, "Y".repeat(f.candidate.sizeBytes));
  fs.utimesSync(f.keep, before.atime, before.mtime);
  const journal = new OperationJournal(path.join(f.root, "journal.json"), "keep-copy-content-race");
  assert.throws(() => journal.purge("candidate", f.source, stillCurrent), /changed after checksum verification/);
  assert.equal(fs.readFileSync(f.source, "utf8"), f.bytes);
  assert.equal(journal.completed("candidate"), false);
});

test("only generated cache, preview and proxy paths bypass physical duplicate proof", () => {
  assert.equal(isRegenerablePath(undefined), false);
  assert.equal(isRegenerablePath("/Show/04_ASSETS/MUSIC/license.wav"), false);
  assert.equal(isRegenerablePath(String.raw`D:\Show\06_RENDERS_CACHE\preview.dat`), true);
  assert.equal(isRegenerablePath("/Show/05_PROXIES/take.mp4"), true);
});
