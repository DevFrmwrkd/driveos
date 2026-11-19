import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { moveFileSafely } from "./fileOperations.js";

interface Operation {
  kind: "move" | "purge";
  source: string;
  destination?: string;
  size: number;
  modifiedAt: number;
  checksum: string;
  purgeParent?: DirectoryIdentity;
  state: "prepared" | "done";
}
interface JournalData { version: 1; scope: string; operations: Record<string, Operation> }

interface DirectoryIdentity {
  realPath: string;
  device: string;
  inode: string;
  birthtime: string;
}

// A missing file is not evidence of deletion when its external drive/share is
// disconnected. Pin the actual parent directory before deleting, and require
// that same readable directory when reconciling a missing file later.
function directoryIdentity(source: string): DirectoryIdentity {
  const parent = path.dirname(source);
  try {
    const realPath = fs.realpathSync.native(parent);
    const before = fs.statSync(parent, { bigint: true });
    if (!before.isDirectory()) throw new Error("The quarantine parent is not a directory.");
    const directory = fs.opendirSync(parent);
    try { directory.readSync(); } finally { directory.closeSync(); }
    const after = fs.statSync(parent, { bigint: true });
    if (realPath !== fs.realpathSync.native(parent) || before.dev !== after.dev ||
        before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs)
      throw new Error("The quarantine directory changed while checking it.");
    return { realPath, device: before.dev.toString(), inode: before.ino.toString(), birthtime: before.birthtimeNs.toString() };
  } catch (error) {
    throw new Error(`Cannot verify the quarantine directory; reconnect its original drive/share and check permissions: ${parent}`, { cause: error });
  }
}

function sourcePresent(source: string): boolean {
  try { fs.lstatSync(source); return true; }
  catch (error: any) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function sameDirectory(expected: DirectoryIdentity | undefined, current: DirectoryIdentity): void {
  if (!expected) throw new Error("This older purge journal has no directory identity. Preserve it for manual recovery.");
  if (expected.realPath !== current.realPath || expected.device !== current.device ||
      expected.inode !== current.inode || expected.birthtime !== current.birthtime)
    throw new Error("The quarantine directory or volume changed. Reconnect the original drive/share before recovery.");
}

function fingerprint(filename: string) {
  const before = fs.lstatSync(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Not a regular file: ${filename}`);
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filename, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  const after = fs.lstatSync(filename);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
    throw new Error(`File changed while recording operation: ${filename}`);
  return { size: before.size, modifiedAt: before.mtimeMs, checksum: hash.digest("hex") };
}

/** Write intent before touching a file. Keep receipts until the backend acknowledges them.
 * The caller must hold the per-job process lock throughout this journal's lifetime. */
export class OperationJournal {
  private data: JournalData;
  constructor(readonly filename: string, scope: string) {
    if (fs.existsSync(filename)) {
      this.data = JSON.parse(fs.readFileSync(filename, "utf8"));
      if (this.data.version !== 1 || this.data.scope !== scope || !this.data.operations || typeof this.data.operations !== "object")
        throw new Error("Operation journal is invalid; preserve it for manual recovery.");
    } else this.data = { version: 1, scope, operations: {} };
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.data)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.filename);
    // Directory fsync is unavailable on some Windows filesystems.
    try { const dir = fs.openSync(path.dirname(this.filename), "r"); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch { /* best effort */ }
  }

  has(key: string) { return Object.hasOwn(this.data.operations, key); }
  completed(key: string) { return this.data.operations[key]?.state === "done"; }
  destination(key: string) { return this.data.operations[key]?.destination; }

  private prepare(key: string, kind: Operation["kind"], source: string, destination?: string) {
    const existing = this.data.operations[key];
    if (existing) {
      if (existing.kind !== kind || existing.source !== source || existing.destination !== destination)
        throw new Error("The operation no longer matches its durable intent.");
      return existing;
    }
    // An unrelated pre-existing destination is never adopted as our own copy.
    if (destination && fs.existsSync(destination)) throw new Error(`Destination already exists: ${destination}`);
    const op: Operation = { kind, source, destination, ...fingerprint(source),
      ...(kind === "purge" ? { purgeParent: directoryIdentity(source) } : {}), state: "prepared" };
    this.data.operations[key] = op;
    this.persist();
    return op;
  }

  private matches(filename: string, op: Operation, checkTime = false) {
    const actual = fingerprint(filename);
    return actual.size === op.size && actual.checksum === op.checksum && (!checkTime || actual.modifiedAt === op.modifiedAt);
  }

  move(key: string, source: string, destination: string, beforeMutation?: () => void): void {
    const op = this.prepare(key, "move", source, destination);
    if (op.state === "done") {
      if (fs.existsSync(source)) throw new Error(`The original path was recreated after this move; preserve both copies for reconciliation: ${source}`);
      if (!fs.existsSync(destination) || !this.matches(destination, op)) throw new Error(`Completed move destination is missing or changed: ${destination}`);
      return;
    }
    if (fs.existsSync(destination)) {
      if (!this.matches(destination, op)) throw new Error(`Interrupted destination does not match the original; preserve both paths: ${destination}`);
      if (fs.existsSync(source)) {
        if (!this.matches(source, op, true)) throw new Error(`Original changed during interrupted move: ${source}`);
        beforeMutation?.();
        fs.unlinkSync(source);
      }
    } else {
      if (!fs.existsSync(source) || !this.matches(source, op, true)) throw new Error(`Original is missing or changed during recovery: ${source}`);
      beforeMutation?.();
      moveFileSafely(source, destination);
    }
    op.state = "done";
    this.persist();
  }

  purge(key: string, source: string, beforeMutation?: () => void): number {
    const op = this.prepare(key, "purge", source);
    const present = sourcePresent(source);
    const currentParent = directoryIdentity(source);
    if (op.state === "done") {
      if (present) throw new Error(`A new file appeared at a completed deletion path: ${source}`);
      sameDirectory(op.purgeParent, currentParent);
      return op.size;
    }
    if (present) {
      if (!this.matches(source, op, true)) throw new Error(`Quarantined content changed before deletion: ${source}`);
      if (op.purgeParent) sameDirectory(op.purgeParent, currentParent);
      else {
        // Old prepared journals can be upgraded only while the verified file
        // is still present. Persist the new evidence before touching it.
        op.purgeParent = currentParent;
        this.persist();
      }
      sameDirectory(op.purgeParent, directoryIdentity(source));
      beforeMutation?.();
      fs.unlinkSync(source);
    } else sameDirectory(op.purgeParent, currentParent);
    // Only infer a completed unlink with durable intent and the same available
    // parent directory; otherwise leave the operation pending for recovery.
    op.state = "done";
    this.persist();
    return op.size;
  }
}
