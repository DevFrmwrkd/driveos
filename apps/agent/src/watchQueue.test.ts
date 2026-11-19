import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WatchQueue, WatchRootGuard, UnresolvedRemovals, catalogReceipts, catalogSnapshotFromCache, cachedParentIdentities, directoryIdentity, fingerprintFromUploaded, selectCatalogSnapshot, type CatalogReceipt } from "./watchQueue.js";

function fixture(t: test.TestContext) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "driveos-watch-queue-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const root = path.join(base, "watched");
  fs.mkdirSync(root);
  return { base, root, file: path.join(root, "clip.mov") };
}

function receipt(filePath: string, catalogVersion = 1): CatalogReceipt {
  return { path: filePath, fileId: "file-1", catalogVersion, sizeBytes: 1024, modifiedAtFile: 1234, quickHash: "quick", fullHash: "full" };
}

test("unlink and recreation cancel obsolete hashing and force an identical observation", () => {
  const queue = new WatchQueue<{ path: string; sizeBytes: number }>();
  const old = queue.changed("clip");
  queue.deleted("clip", receipt("clip"));
  assert.equal(queue.metadata("clip", old, { path: "clip", sizeBytes: 1024 }), false);
  const recreated = queue.changed("clip");
  assert.equal(queue.deletions().length, 0);
  assert.equal(queue.metadata("clip", recreated, { path: "clip", sizeBytes: 1024 }), true);
  assert.equal(queue.changes()[0].forceObservation, true);
  assert.equal(queue.invalidated.has("clip"), true);
});

test("an upload acknowledgement racing unlink becomes its deletion proof, not a lost event", () => {
  const queue = new WatchQueue<{ path: string }>();
  const generation = queue.changed("clip");
  queue.metadata("clip", generation, { path: "clip" });
  const upload = queue.changes()[0];
  queue.deleted("clip", receipt("clip", 1));
  queue.uploaded(upload, receipt("clip", 2));
  assert.equal(queue.size, 1);
  assert.equal(queue.deletions()[0].receipt?.catalogVersion, 2);
  assert.equal(queue.invalidated.has("clip"), true);
});

test("late delete receipts cannot discard a newer recreation or a second unlink", () => {
  const queue = new WatchQueue<{ path: string }>();
  queue.deleted("clip", receipt("clip"));
  const first = queue.deletions();
  const generation = queue.changed("clip", true);
  queue.metadata("clip", generation, { path: "clip" });
  assert.equal(queue.deletionReceipts(first, [{ path: "clip", status: "deleted" }]), 0);
  assert.equal(queue.changes().length, 1);
  queue.deleted("clip", receipt("clip", 2));
  assert.equal(queue.deletionReceipts(first, [{ path: "clip", status: "already_deleted" }]), 0);
  assert.equal(queue.deletions()[0].receipt?.catalogVersion, 2);
});

test("partial, missing, unknown and deferred receipts retain work and let later paths proceed", () => {
  const queue = new WatchQueue<{ path: string }>();
  for (const name of ["reserved", "deleted", "missing", "unknown", "later"]) queue.deleted(name, receipt(name));
  const first = queue.deletions(4);
  assert.equal(queue.deletionReceipts(first, [
    { path: "reserved", status: "deferred" }, { path: "deleted", status: "deleted" },
    { path: "unknown", status: "success" },
  ]), 1);
  assert.deepEqual(queue.deletions().map(entry => entry.path), ["later", "reserved", "missing", "unknown"]);
  assert.equal(queue.deletionReceipts(queue.deletions(), undefined), 0);
  assert.equal(queue.size, 4);
});

test("a detached or replacement root holds deletion and the original root can recover", t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, "bytes");
  const parent = directoryIdentity(f.root), guard = new WatchRootGuard([f.root]);
  fs.unlinkSync(f.file);
  assert.equal(guard.fileMissing(f.file, parent), true);
  const detached = path.join(f.base, "detached");
  fs.renameSync(f.root, detached);
  assert.equal(guard.available(), false);
  assert.equal(guard.fileMissing(f.file, parent), false);
  fs.mkdirSync(f.root);
  assert.equal(guard.available(), false);
  assert.equal(guard.fileMissing(f.file, parent), false);
  fs.rmdirSync(f.root);
  fs.renameSync(detached, f.root);
  assert.equal(guard.fileMissing(f.file, parent), true);
  fs.writeFileSync(f.file, "recreated");
  assert.equal(guard.fileMissing(f.file, parent), false);
});

test("a replaced parent directory does not supply proof that its old file was deleted", t => {
  const f = fixture(t);
  const sub = path.join(f.root, "nested");
  fs.mkdirSync(sub);
  const file = path.join(sub, "clip.mov"), parent = directoryIdentity(sub), guard = new WatchRootGuard([f.root]);
  fs.renameSync(sub, path.join(f.root, "detached"));
  fs.mkdirSync(sub);
  assert.equal(guard.available(), true);
  assert.equal(guard.fileMissing(file, parent), false);
});

test("permission failures never become an ENOENT deletion or same-device fallback", t => {
  const f = fixture(t), parent = directoryIdentity(f.root);
  let unreadable = false;
  const inspect = (directory: string) => {
    if (unreadable) throw Object.assign(new Error("Access denied"), { code: "EACCES" });
    return directoryIdentity(directory);
  };
  const guard = new WatchRootGuard([f.root], inspect);
  unreadable = true;
  assert.equal(guard.available(), false);
  assert.equal(guard.fileMissing(f.file, parent), false);
  unreadable = false;
  const sub = path.join(f.root, "private");
  fs.mkdirSync(sub);
  const deniedParent = directoryIdentity(sub);
  const parentGuard = new WatchRootGuard([f.root], directory => {
    if (directory === sub) throw Object.assign(new Error("Access denied"), { code: "EACCES" });
    return directoryIdentity(directory);
  });
  assert.equal(parentGuard.available(), true);
  assert.equal(parentGuard.fileMissing(path.join(sub, "clip.mov"), deniedParent), false);
});

test("a removed ordinary subtree is distinguishable from an unavailable nested volume", t => {
  const f = fixture(t), guard = new WatchRootGuard([f.root]);
  const sub = path.join(f.root, "deleted-folder");
  fs.mkdirSync(sub);
  const parent = directoryIdentity(sub), file = path.join(sub, "clip.mov");
  fs.rmdirSync(sub);
  assert.equal(guard.fileMissing(file, parent), true);
  assert.equal(guard.fileMissing(file, { ...parent, device: "another-volume" }), false);
});

test("legacy bootstrap uses the successful fingerprint and accepts only complete catalog receipts", () => {
  assert.deepEqual(fingerprintFromUploaded("clip", "1024|1234|old-quick|old-full|RAW|HIGH|0"), {
    path: "clip", sizeBytes: 1024, modifiedAtFile: 1234, quickHash: "old-quick", fullHash: "old-full",
  });
  assert.equal(fingerprintFromUploaded("clip", "NaN|1234|quick|full"), undefined);
  assert.equal(fingerprintFromUploaded("clip", undefined), undefined);
  const legacy = receipt("clip", 0);
  assert.deepEqual(catalogReceipts([legacy, { path: "clip", status: "deleted" }, { ...legacy, catalogVersion: -1 }]), [legacy]);
});

test("a restore revision conflict refreshes proof and reconciles a subsequent physical unlink", t => {
  const f = fixture(t), guard = new WatchRootGuard([f.root]), parent = directoryIdentity(f.root);
  const queue = new WatchQueue<{ path: string }>();
  // The restored original is deleted again before its add observation uploads.
  fs.writeFileSync(f.file, "restored bytes");
  fs.unlinkSync(f.file);
  queue.deleted(f.file, receipt(f.file, 1), parent);
  assert.equal(queue.deletionReceipts(queue.deletions(), [{ path: f.file, status: "conflict" }]), 0);
  const refresh = queue.deletions()[0];
  assert.equal(refresh.receipt, undefined);
  assert.equal(queue.size, 1);
  // The next flush reloads the unchanged disk cache. Its stale v1 receipt must
  // not suppress bootstrap and repeat the same conflict forever.
  queue.refreshFromCache(refresh, receipt(f.file, 1), parent);
  assert.equal(refresh.receipt, undefined);
  assert.deepEqual(Object.keys(refresh.fingerprint!).sort(), ["fullHash", "modifiedAtFile", "path", "quickHash", "sizeBytes"]);
  queue.bootstrapReceipts([refresh], [receipt(f.file, 2)], []);
  assert.equal(queue.deletions()[0].receipt?.catalogVersion, 2);
  assert.equal(guard.fileMissing(f.file, refresh.parent), true);
  assert.equal(queue.deletionReceipts([refresh], [{ path: f.file, status: "deleted" }]), 1);
  assert.equal(queue.size, 0);
});

test("legacy cached paths capture parent identity once before a whole subtree is removed", t => {
  const f = fixture(t), guard = new WatchRootGuard([f.root]);
  const sub = path.join(f.root, "legacy-folder");
  fs.mkdirSync(sub);
  const file = path.join(sub, "clip.mov"), sibling = path.join(sub, "other.mov");
  fs.writeFileSync(file, "legacy bytes");
  let reads = 0;
  const parentFor = cachedParentIdentities(directory => { reads++; return directoryIdentity(directory); });
  const parent = parentFor(file);
  assert.deepEqual(parentFor(sibling), parent);
  assert.equal(reads, 1);
  const fingerprint = fingerprintFromUploaded(file, "1024|1234|quick|full|RAW|HIGH|0")!;
  fs.unlinkSync(file);
  fs.rmdirSync(sub);
  const queue = new WatchQueue<{ path: string }>();
  assert.equal(queue.deleted(file, undefined, parent, fingerprint), true);
  const deletion = queue.deletions()[0];
  assert.equal(guard.fileMissing(file, deletion.parent), true);
  queue.bootstrapReceipts([deletion], [receipt(file)], []);
  assert.equal(guard.fileMissing(file, deletion.parent), true);
  assert.equal(queue.deletionReceipts([deletion], [{ path: file, status: "deleted" }]), 1);
  assert.equal(queue.size, 0);
});

test("an actual bootstrap fingerprint mismatch is retired without deleting or retrying the newer row", () => {
  const queue = new WatchQueue<{ path: string }>();
  queue.deleted("clip", receipt("clip"));
  queue.deletionReceipts(queue.deletions(), [{ path: "clip", status: "conflict" }]);
  const stale = queue.deletions();
  queue.bootstrapReceipts(stale, [], [{ path: "clip", status: "conflict" }]);
  assert.equal(stale[0].retiredReason, "catalog_mismatch");
  for (let retry = 0; retry < 10; retry++) assert.equal(queue.deletions().length, 0);
});

test("continuous catalog conflicts have a bounded refresh budget", () => {
  const queue = new WatchQueue<{ path: string }>();
  queue.deleted("clip", receipt("clip"));
  let last;
  for (let revision = 1; revision <= 3; revision++) {
    last = queue.deletions()[0];
    queue.bootstrapReceipts([last], [receipt("clip", revision)], []);
    queue.deletionReceipts([last], [{ path: "clip", status: "conflict" }]);
  }
  assert.equal(queue.size, 0);
  assert.equal(last?.retiredReason, "conflict_limit");
});

test("a thousand never-uploaded removals leave no pending queue or invalidation set", () => {
  const queue = new WatchQueue<{ path: string }>();
  for (let index = 0; index < 1000; index++) {
    const name = `tiny-${index}`;
    const generation = queue.changed(name, true);
    assert.equal(queue.deleted(name), false);
    assert.equal(queue.metadata(name, generation, { path: name }), false);
  }
  assert.equal(queue.size, 0);
  assert.equal(queue.invalidated.size, 0);
  for (let retry = 0; retry < 10; retry++) assert.deepEqual(queue.deletions(), []);
});

test("unlink during an unacknowledged upload retains its attempted fingerprint for recovery", () => {
  const queue = new WatchQueue<{ path: string }>();
  const generation = queue.changed("clip", true);
  queue.metadata("clip", generation, { path: "clip" });
  const change = queue.changes()[0];
  queue.beginUpload(change, receipt("clip"));
  assert.equal(queue.deleted("clip"), true);
  // Simulate a transport failure after the backend accepted the upload.
  queue.endUpload(change);
  assert.equal(queue.size, 1);
  const pending = queue.deletions()[0];
  assert.equal(pending.receipt, undefined);
  assert.equal(pending.fingerprint?.quickHash, "quick");
  queue.bootstrapReceipts([pending], [receipt("clip", 1)], []);
  assert.equal(queue.deletionReceipts([pending], [{ path: "clip", status: "deleted" }]), 1);
  assert.equal(queue.size, 0);
});

test("an existing file's newer accepted-but-lost upload survives its older cached acknowledgement", () => {
  const queue = new WatchQueue<{ path: string }>();
  const old = receipt("clip", 1), next = { ...receipt("clip", 2), quickHash: "new-quick", fullHash: "new-full", modifiedAtFile: 5678 };
  const generation = queue.changed("clip");
  queue.metadata("clip", generation, { path: "clip" });
  const change = queue.changes()[0];
  queue.beginUpload(change, next);
  queue.deleted("clip", old, undefined, old);
  queue.endUpload(change); // Backend committed v2; its response never arrived.
  const deletion = queue.deletions()[0];
  assert.equal(deletion.fingerprint?.quickHash, "new-quick");
  queue.deleted("clip", old, undefined, old); // Duplicate unlink must coalesce.
  assert.equal(queue.deletions()[0], deletion);
  assert.equal(deletion.fingerprint?.quickHash, "new-quick");
  queue.refreshFromCache(deletion, old);
  assert.equal(deletion.fingerprint?.quickHash, "new-quick");
  queue.deletionReceipts([deletion], [{ path: "clip", status: "conflict" }]);
  assert.equal(deletion.receipt, undefined);
  assert.equal(deletion.fingerprint?.quickHash, "new-quick");
  queue.refreshFromCache(deletion, old);
  assert.equal(deletion.receipt, undefined);
  queue.bootstrapReceipts([deletion], [next], []);
  assert.equal(queue.deletions()[0].receipt?.catalogVersion, 2);
  assert.equal(queue.deletionReceipts([deletion], [{ path: "clip", status: "deleted" }]), 1);
  assert.equal(queue.size, 0);
});

test("overlapping scan roots bootstrap a receipt for the watcher drive instead of sending the other drive's file id", () => {
  const scope = { driveId: "parent-drive", machineId: "machine-a" };
  const foreign = { ...receipt("clip", 99), fileId: "subfolder-file", driveId: "subfolder-drive", machineId: scope.machineId };
  const actual = { ...receipt("clip", 1), fileId: "parent-file", ...scope };
  const snapshot = selectCatalogSnapshot(undefined, { receipt: foreign, fingerprint: foreign }, scope);
  assert.equal(snapshot.receipt, undefined);
  const queue = new WatchQueue<{ path: string }>(scope);
  queue.deleted("clip", foreign, undefined, snapshot.fingerprint);
  const deletion = queue.deletions()[0];
  assert.equal(deletion.receipt, undefined);
  queue.refreshFromCache(deletion, foreign);
  assert.equal(deletion.receipt, undefined);
  queue.bootstrapReceipts([deletion], [actual], []);
  assert.equal(queue.deletions()[0].receipt?.fileId, actual.fileId);
  assert.equal(queue.deletionReceipts([deletion], [{ path: "clip", status: "deleted" }]), 1);
  assert.equal(queue.size, 0);
});

test("legacy unscoped receipts and receipts from another machine supply only lookup fingerprints", () => {
  const scope = { driveId: "drive-a", machineId: "machine-a" };
  for (const untrusted of [receipt("clip"), { ...receipt("clip"), driveId: scope.driveId, machineId: "machine-b" }]) {
    const queue = new WatchQueue<{ path: string }>(scope);
    queue.deleted("clip", untrusted);
    assert.equal(queue.deletions()[0].receipt, undefined);
    assert.equal(queue.deletions()[0].fingerprint?.quickHash, untrusted.quickHash);
    queue.bootstrapReceipts(queue.deletions(), [untrusted], []);
    assert.equal(queue.deletions()[0].receipt, undefined);
  }
});

test("catalog revisions are compared only within one file id in the current machine and drive", () => {
  const scope = { driveId: "drive-a", machineId: "machine-a" };
  const old = { ...receipt("clip", 99), fileId: "old-file", ...scope };
  const replacement = { ...receipt("clip", 1), fileId: "new-file", ...scope };
  const snapshot = selectCatalogSnapshot({ receipt: old, fingerprint: old }, { receipt: replacement, fingerprint: replacement }, scope);
  assert.equal(snapshot.receipt?.fileId, replacement.fileId);
  const queue = new WatchQueue<{ path: string }>(scope);
  queue.deleted("clip", old);
  const deletion = queue.deletions()[0];
  queue.deletionReceipts([deletion], [{ path: "clip", status: "conflict" }]);
  queue.refreshFromCache(deletion, replacement);
  assert.equal(deletion.receipt?.fileId, replacement.fileId);
});

test("a scanner's new acknowledgement discovered after unlink still reconciles a removed whole folder", t => {
  const f = fixture(t), scope = { driveId: "drive-a", machineId: "machine-a" };
  const guard = new WatchRootGuard([f.root]);
  const sub = path.join(f.root, "external-scan");
  fs.mkdirSync(sub);
  const file = path.join(sub, "clip.mov");
  fs.writeFileSync(file, "another scanner observed this");
  const parent = directoryIdentity(sub);
  const acknowledged = { ...receipt(file), ...scope };
  const queue = new WatchQueue<{ path: string }>(scope), unresolved = new UnresolvedRemovals();
  // The running watcher has no receipt, but a manual scan has just persisted it.
  fs.unlinkSync(file); fs.rmdirSync(sub);
  assert.equal(queue.deleted(file), false);
  unresolved.removed(file);
  const pending = unresolved.snapshot()[0];
  const snapshot = selectCatalogSnapshot(undefined, { receipt: acknowledged, fingerprint: acknowledged, parent }, scope);
  assert.equal(unresolved.consume(pending), true);
  assert.equal(queue.deleted(file, snapshot.receipt, snapshot.parent, snapshot.fingerprint), true);
  assert.equal(guard.fileMissing(file, queue.deletions()[0].parent), true);
  assert.equal(queue.deletionReceipts(queue.deletions(), [{ path: file, status: "deleted" }]), 1);
  assert.equal(queue.size, 0);
  assert.equal(unresolved.size, 0);
});

test("a fresh local cache pass drains a thousand genuinely unindexed unlinks without catalog work", () => {
  const queue = new WatchQueue<{ path: string }>(), unresolved = new UnresolvedRemovals();
  for (let index = 0; index < 1000; index++) {
    const name = `unindexed-${index}`;
    assert.equal(queue.deleted(name), false);
    unresolved.removed(name);
  }
  const pending = unresolved.snapshot();
  for (let start = 0; start < pending.length; start += 500) {
    for (const entry of pending.slice(start, start + 500)) assert.equal(unresolved.consume(entry), true);
  }
  assert.equal(queue.size, 0);
  assert.equal(queue.invalidated.size, 0);
  assert.equal(unresolved.size, 0);
});

test("a recreation cancels an unresolved unlink and old cache work cannot discard a second unlink", () => {
  const unresolved = new UnresolvedRemovals();
  unresolved.removed("clip");
  const beforeAdd = unresolved.snapshot()[0];
  unresolved.cancel("clip");
  assert.equal(unresolved.consume(beforeAdd), false);
  unresolved.removed("clip");
  const beforeSecond = unresolved.snapshot()[0];
  unresolved.removed("clip");
  assert.equal(unresolved.consume(beforeSecond), false);
  assert.equal(unresolved.size, 1);
  assert.equal(unresolved.consume(unresolved.snapshot()[0]), true);
});

test("an older scanner's acknowledged fingerprint supersedes its preserved stale receipt", () => {
  const scope = { driveId: "drive-a", machineId: "machine-a" };
  const old = { ...receipt("clip", 1), ...scope };
  const next = { ...receipt("clip", 2), ...scope, modifiedAtFile: 5678, quickHash: "new-quick", fullHash: "new-full" };
  // This is the old stampUploaded behavior: spread all unknown fields, then
  // replace the acknowledged metadata/fingerprint without knowing about ACKs.
  const cache = { sizeBytes: old.sizeBytes, modifiedAt: old.modifiedAtFile, quickHash: old.quickHash, fullHash: old.fullHash,
    catalogReceipt: old, uploadedFp: `${old.sizeBytes}|${old.modifiedAtFile}|${old.quickHash}|${old.fullHash}|CACHE|green` };
  const oldStamp = (meta: CatalogReceipt) => ({ ...cache, sizeBytes: meta.sizeBytes, modifiedAt: meta.modifiedAtFile,
    quickHash: meta.quickHash, fullHash: meta.fullHash, uploadedFp: `${meta.sizeBytes}|${meta.modifiedAtFile}|${meta.quickHash}|${meta.fullHash}|CACHE|green` });
  const disk = oldStamp(next);
  assert.equal(disk.catalogReceipt.catalogVersion, 1);
  const refreshed = catalogSnapshotFromCache("clip", disk)!;
  assert.equal(refreshed.receipt, undefined);
  assert.equal(refreshed.fingerprint.quickHash, "new-quick");
  const selected = selectCatalogSnapshot({ receipt: old, fingerprint: old }, refreshed, scope);
  assert.equal(selected.receipt, undefined);
  const queue = new WatchQueue<{ path: string }>(scope);
  queue.deleted("clip", old);
  const deletion = queue.deletions()[0];
  queue.refreshFromSnapshot(deletion, selected);
  assert.equal(deletion.receipt, undefined);
  assert.equal(deletion.fingerprint?.quickHash, "new-quick");
  queue.bootstrapReceipts([deletion], [next], []);
  assert.equal(queue.deletionReceipts([deletion], [{ path: "clip", status: "deleted" }]), 1);
  assert.equal(queue.size, 0);
});

test("a quick-only legacy fingerprint preserves a matching server-retained full hash", () => {
  const stored = receipt("clip", 2);
  const snapshot = catalogSnapshotFromCache("clip", { catalogReceipt: stored,
    uploadedFp: `${stored.sizeBytes}|${stored.modifiedAtFile}|${stored.quickHash}||CACHE|green` });
  assert.equal(snapshot?.receipt, stored);
  assert.equal(snapshot?.fingerprint.fullHash, stored.fullHash);
  assert.equal(snapshot?.receiptInvalidated, undefined);
});
