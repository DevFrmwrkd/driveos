import fs from "node:fs";
import path from "node:path";

// The backend returns its actual stored fingerprint, including its monotonic
// catalog version. A local clock or a freshly hashed file cannot replace this
// acknowledgement when reporting a later disappearance.
export interface CatalogFingerprint {
  path: string;
  sizeBytes: number;
  modifiedAtFile: number;
  quickHash?: string;
  fullHash?: string;
}
export interface CatalogReceipt extends CatalogFingerprint {
  fileId: string;
  catalogVersion: number;
}

function fingerprintOnly(value: CatalogFingerprint): CatalogFingerprint {
  return { path: value.path, sizeBytes: value.sizeBytes, modifiedAtFile: value.modifiedAtFile,
    ...(value.quickHash !== undefined ? { quickHash: value.quickHash } : {}),
    ...(value.fullHash !== undefined ? { fullHash: value.fullHash } : {}) };
}

export function fingerprintFromUploaded(filePath: string, fingerprint?: string): CatalogFingerprint | undefined {
  if (!fingerprint) return undefined;
  const [size, modified, quickHash, fullHash] = fingerprint.split("|");
  if (size === "" || modified === "" || !Number.isFinite(Number(size)) || Number(size) < 0 || !Number.isFinite(Number(modified))) return undefined;
  return { path: filePath, sizeBytes: Number(size), modifiedAtFile: Number(modified),
    ...(quickHash ? { quickHash } : {}), ...(fullHash ? { fullHash } : {}) };
}

export function catalogReceipts(value: unknown): CatalogReceipt[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is CatalogReceipt => Boolean(item &&
    typeof item.path === "string" && typeof item.fileId === "string" && item.fileId.length > 0 &&
    Number.isSafeInteger(item.catalogVersion) && item.catalogVersion >= 0 &&
    Number.isFinite(item.sizeBytes) && item.sizeBytes >= 0 && Number.isFinite(item.modifiedAtFile) &&
    (item.quickHash === undefined || typeof item.quickHash === "string") &&
    (item.fullHash === undefined || typeof item.fullHash === "string")));
}

export interface DirectoryIdentity {
  realPath: string;
  device: string;
  inode: string;
  birthtime: string;
}

export function directoryIdentity(directory: string): DirectoryIdentity {
  const realPath = fs.realpathSync.native(directory);
  const before = fs.statSync(directory, { bigint: true });
  if (!before.isDirectory() || before.ino === 0n) throw new Error("Directory identity is unavailable.");
  // Opening and reading a single entry proves availability without loading a
  // potentially enormous directory into memory. stat alone can succeed on a
  // disconnected mount placeholder or an unreadable directory.
  const reader = fs.opendirSync(directory);
  try { reader.readSync(); } finally { reader.closeSync(); }
  const after = fs.statSync(directory, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs ||
      fs.realpathSync.native(directory) !== realPath) throw new Error("Directory changed during availability check.");
  return {
    realPath: process.platform === "win32" ? realPath.toLowerCase() : realPath,
    device: before.dev.toString(), inode: before.ino.toString(), birthtime: before.birthtimeNs.toString(),
  };
}

export function cachedParentIdentities(inspect = directoryIdentity) {
  const parents = new Map<string, DirectoryIdentity | undefined>();
  return (filePath: string, known?: DirectoryIdentity): DirectoryIdentity | undefined => {
    if (known) return known;
    const directory = path.dirname(filePath);
    if (!parents.has(directory)) {
      try { parents.set(directory, inspect(directory)); }
      catch { parents.set(directory, undefined); }
    }
    return parents.get(directory);
  };
}

function sameDirectory(a: DirectoryIdentity, b: DirectoryIdentity) {
  return a.realPath === b.realPath && a.device === b.device && a.inode === b.inode && a.birthtime === b.birthtime;
}

export class WatchRootGuard {
  private readonly roots: { path: string; identity: DirectoryIdentity }[];
  constructor(roots: string[], private readonly inspect = directoryIdentity) {
    this.roots = [...new Set(roots.map(root => path.resolve(root)))].map(root => ({ path: root, identity: inspect(root) }));
  }
  available(): boolean {
    try { return this.roots.every(root => sameDirectory(root.identity, this.inspect(root.path))); }
    catch { return false; }
  }
  // A disappeared nested mount must not look like ordinary deletion merely
  // because the directory containing that mount remains available.
  fileMissing(filePath: string, parent?: DirectoryIdentity): boolean {
    if (!this.available() || !parent) return false;
    try { fs.lstatSync(filePath); return false; }
    catch (error: any) { if (error.code !== "ENOENT") return false; }
    try {
      const currentParent = this.inspect(path.dirname(filePath));
      return sameDirectory(parent, currentParent) && this.available();
    } catch (error: any) {
      if (error.code !== "ENOENT") return false;
      // A whole ordinary directory may have been removed. Its watched root on
      // the same device is sufficient; a nested external volume is not.
      return this.roots.some(root => root.identity.device === parent.device &&
        (parent.realPath === root.identity.realPath ||
          parent.realPath.startsWith(root.identity.realPath.endsWith(path.sep) ? root.identity.realPath : root.identity.realPath + path.sep))) &&
        this.available();
    }
  }
}

export type WatchChange<T> = { path: string; generation: number; kind: "change"; metadata?: T; parent?: DirectoryIdentity; forceObservation: boolean };
export type WatchDeletion = { path: string; generation: number; kind: "delete"; receipt?: CatalogReceipt; fingerprint?: CatalogFingerprint; parent?: DirectoryIdentity;
  attemptedFingerprint?: boolean; conflictRefreshes?: number; rejectedVersion?: number; retiredReason?: "catalog_mismatch" | "conflict_limit" };

// Entries remain queued while requests are in flight. Only an acknowledgement
// for the same generation may remove one, so late responses cannot erase a
// recreation or a second unlink that happened during that request.
export class WatchQueue<T extends { path: string }> {
  private generation = 0;
  private readonly entries = new Map<string, WatchChange<T> | WatchDeletion>();
  private readonly inFlight = new Map<string, { generation: number; fingerprint: CatalogFingerprint; parent?: DirectoryIdentity }>();
  readonly invalidated = new Set<string>();
  get size() { return this.entries.size; }
  changed(filePath: string, forceObservation = false): number {
    const previous = this.entries.get(filePath);
    const generation = ++this.generation;
    forceObservation ||= previous?.kind === "delete" || (previous?.kind === "change" && previous.forceObservation);
    this.entries.set(filePath, { path: filePath, generation, kind: "change", forceObservation });
    if (forceObservation) this.invalidated.add(filePath);
    return generation;
  }
  deleted(filePath: string, receipt?: CatalogReceipt, parent?: DirectoryIdentity, fingerprint?: CatalogFingerprint): boolean {
    const uploading = this.inFlight.get(filePath);
    // Repeated unlink notifications without an intervening add/change describe
    // the same absence. In particular, do not replace a retained lost-response
    // upload fingerprint with the older persisted acknowledgement.
    if (!uploading && this.entries.get(filePath)?.kind === "delete") return true;
    // The current upload may have replaced an older acknowledged catalog
    // version even when its response is lost. Keep that newer attempted
    // fingerprint for a subsequent lookup if the old receipt conflicts.
    fingerprint = uploading?.fingerprint || fingerprint;
    parent = uploading?.parent || parent;
    // A tiny/unindexed file has no acknowledged catalog state to reconcile.
    // Retaining it cannot ever produce a safe deletion request. An in-flight
    // upload is different: its response may be lost after the server accepted
    // it, so preserve the attempted fingerprint for bounded receipt lookup.
    if (!receipt && !fingerprint) {
      this.entries.delete(filePath);
      this.invalidated.delete(filePath);
      return false;
    }
    this.invalidated.add(filePath);
    this.entries.set(filePath, { path: filePath, generation: ++this.generation, kind: "delete", receipt, parent,
      fingerprint: fingerprintOnly(fingerprint || receipt!), ...(uploading ? { attemptedFingerprint: true } : {}) });
    return true;
  }
  isCurrent(filePath: string, generation: number): boolean { return this.entries.get(filePath)?.generation === generation; }
  metadata(filePath: string, generation: number, metadata: T, parent?: DirectoryIdentity): boolean {
    const entry = this.entries.get(filePath);
    if (entry?.kind !== "change" || entry.generation !== generation) return false;
    entry.metadata = metadata;
    entry.parent = parent;
    return true;
  }
  changes(limit = 500): WatchChange<T>[] {
    return [...this.entries.values()].filter((entry): entry is WatchChange<T> => entry.kind === "change" && Boolean(entry.metadata)).slice(0, limit);
  }
  unpreparedChanges(limit = 20): WatchChange<T>[] {
    return [...this.entries.values()].filter((entry): entry is WatchChange<T> => entry.kind === "change" && !entry.metadata).slice(0, limit);
  }
  deletions(limit = 500): WatchDeletion[] {
    return [...this.entries.values()].filter((entry): entry is WatchDeletion => entry.kind === "delete").slice(0, limit);
  }
  beginUpload(change: WatchChange<T>, fingerprint: CatalogFingerprint) {
    this.inFlight.set(change.path, { generation: change.generation, fingerprint: fingerprintOnly(fingerprint), parent: change.parent });
  }
  endUpload(change: WatchChange<T>) {
    if (this.inFlight.get(change.path)?.generation === change.generation) this.inFlight.delete(change.path);
  }
  refreshFromCache(entry: WatchDeletion, receipt: CatalogReceipt, parent?: DirectoryIdentity) {
    if (!this.isCurrent(entry.path, entry.generation) || receipt.path !== entry.path ||
      receipt.catalogVersion <= Math.max(entry.receipt?.catalogVersion ?? -1, entry.rejectedVersion ?? -1)) return;
    entry.receipt = receipt;
    if (!entry.attemptedFingerprint) {
      entry.fingerprint = fingerprintOnly(receipt);
      entry.parent = parent || entry.parent;
    }
  }
  uploaded(change: WatchChange<T>, receipt: CatalogReceipt, parent?: DirectoryIdentity) {
    const current = this.entries.get(change.path);
    if (current?.kind === "delete" && current.generation > change.generation) {
      current.receipt = receipt;
      current.fingerprint = fingerprintOnly(receipt);
      current.attemptedFingerprint = undefined;
      current.parent = parent;
    } else this.acknowledge(change);
  }
  acknowledge(entry: { path: string; generation: number }): boolean {
    if (!this.isCurrent(entry.path, entry.generation)) return false;
    this.entries.delete(entry.path);
    this.invalidated.delete(entry.path);
    return true;
  }
  defer(entry: { path: string; generation: number }) {
    const current = this.entries.get(entry.path);
    if (current?.generation !== entry.generation) return;
    this.entries.delete(entry.path);
    this.entries.set(entry.path, current);
  }
  bootstrapReceipts(batch: WatchDeletion[], receipts: unknown, rejected: unknown) {
    const accepted = new Map(catalogReceipts(receipts).map(receipt => [receipt.path, receipt]));
    const denied = new Map((Array.isArray(rejected) ? rejected : []).filter(item => item && typeof item.path === "string").map(item => [item.path, item]));
    for (const entry of batch) {
      if (!this.isCurrent(entry.path, entry.generation)) continue;
      const receipt = accepted.get(entry.path);
      if (receipt) {
        entry.receipt = receipt;
        entry.fingerprint = fingerprintOnly(receipt);
        entry.attemptedFingerprint = undefined;
      } else if (["conflict", "not_found"].includes(denied.get(entry.path)?.status)) {
        // A different catalog fingerprint cannot be deleted from this old
        // observation. Retire the event, without touching the newer row or
        // repeatedly spending lookups that cannot provide a matching proof.
        if (denied.get(entry.path)?.status === "conflict") entry.retiredReason = "catalog_mismatch";
        this.acknowledge(entry);
      } else this.defer(entry);
    }
  }
  deletionReceipts(batch: WatchDeletion[], receipts: unknown): number {
    if (!Array.isArray(receipts)) return 0;
    const byPath = new Map(receipts.filter(receipt => receipt && typeof receipt.path === "string").map(receipt => [receipt.path, receipt]));
    let acknowledged = 0;
    for (const entry of batch) {
      const receipt = byPath.get(entry.path);
      // Deferred quarantine reservations and missing/malformed receipts retry.
      if (receipt?.status === "conflict" && this.isCurrent(entry.path, entry.generation)) {
        entry.rejectedVersion = Math.max(entry.rejectedVersion ?? -1, entry.receipt?.catalogVersion ?? -1);
        entry.fingerprint ||= fingerprintOnly(entry.receipt!);
        entry.receipt = undefined;
        entry.conflictRefreshes = (entry.conflictRefreshes || 0) + 1;
        if (entry.conflictRefreshes >= 3) {
          entry.retiredReason = "conflict_limit";
          if (this.acknowledge(entry)) acknowledged++;
        } else this.defer(entry);
      } else if (["deleted", "already_deleted", "not_found"].includes(receipt?.status) && this.acknowledge(entry)) acknowledged++;
      else this.defer(entry);
    }
    return acknowledged;
  }
}
