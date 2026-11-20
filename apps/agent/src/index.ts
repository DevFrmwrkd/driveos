#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { setImmediate as yieldToIO } from "node:timers/promises";
import { Command } from "commander";
import chokidar from "chokidar";
import dotenv from "dotenv";
import { classifyFile, calculateFileRisk } from "@driveos/shared";
import { isProtectedSourceFile, quarantineDestination, QUARANTINE_FOLDER_NAME } from "./fileOperations.js";
import { walkManifestFiles } from "./manifestFiles.js";
import { createProcessLock } from "./scanLock.js";
import { OperationJournal } from "./operationJournal.js";
import { JobLeaseClient, JobLeaseLostError, RateLimitedError, withRateLimitBackoff } from "./jobLeaseClient.js";
import { isRegenerablePath, verifyKeepCopy, type KeepCopyProof } from "./keepCopy.js";
import { WatchQueue, WatchRootGuard, UnresolvedRemovals, catalogReceipts, catalogSnapshotFromCache, cachedParentIdentities, directoryIdentity, receiptMatchesScope, selectCatalogSnapshot, type CatalogReceipt, type CatalogSnapshot, type DirectoryIdentity } from "./watchQueue.js";
import { requireCatalogReplay } from "./catalogReplay.js";
import { BackendRedirectError, postBackendJson } from "./backendHttp.js";

dotenv.config({ path: path.resolve(process.cwd(), "apps/web/.env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

interface DriveOSConfig {
  machineName: string;
  ownerId: string;
  convexUrl: string;
  authToken?: string;
  // Physical location of this machine (e.g. "Manila Office", "Home Studio").
  // Drives plugged into it inherit this on the dashboard.
  location?: string;
  quarantineRoot: string;
  // When true (default), quarantined files move into a .driveos-quarantine
  // folder at the root of their own volume — a fast same-disk rename that works
  // on external drives and never floods the system disk. When false, everything
  // goes to quarantineRoot (the legacy single-folder behaviour).
  quarantineOnSourceVolume?: boolean;
  scanRoots: string[];
  minFileSizeBytes: number;
  fullHash: boolean;
}

interface HashCacheEntry {
  sizeBytes: number;
  modifiedAt: number;
  quickHash: string;
  fullHash?: string;
  // Fingerprint of the metadata last SUCCESSFULLY uploaded to Convex. When the
  // current fingerprint matches, the file is skipped entirely during sync —
  // re-uploading the whole unchanged catalog every hour is what once burned
  // ~250 GB of database bandwidth in a week. Unset (or stale) → upload.
  uploadedFp?: string;
  catalogReceipt?: CatalogReceipt;
  catalogParent?: DirectoryIdentity;
  observationInvalidated?: boolean;
}

// Persisted scheduler state. Survives restart so pause/resume and the
// hourly cadence are durable across agent crashes and reboots.
interface AgentState {
  paused: boolean;
  pausedAt?: string;
  lastSyncStartedAt?: string;
  lastSyncCompletedAt?: string;
  lastSyncFiles?: number;
  lastSyncBytes?: number;
  lastSyncStatus?: "completed" | "partial";
  lastSyncErrors?: number;
}

interface FileMetadata {
  path: string;
  normalizedPath: string;
  parentPath: string;
  name: string;
  extension: string;
  sizeBytes: number;
  createdAtFile: number;
  modifiedAtFile: number;
  quickHash?: string;
  fullHash?: string;
  classification: string;
  riskLevel: string;
  isGenerated: boolean;
  isRaw: boolean;
  isFinal: boolean;
  isProjectFile: boolean;
  forceObservation?: boolean;
}

const AGENT_VERSION = "1.2.3";
const ONE_MB = 1024 * 1024;
// Metadata for sub-megabyte generic files costs more than the records are
// worth and cache trees can contain millions of them. This floor is enforced
// even if a legacy config requested a smaller minimum.
const MIN_CATALOG_FILE_SIZE_BYTES = ONE_MB;
const DEFAULT_CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL || process.env.DRIVEOS_CONVEX_URL || "https://determined-anaconda-827.convex.cloud";

const LEGACY_CONFIG_PATH = path.resolve("./driveos-config.json");
const LEGACY_HASH_CACHE_PATH = path.resolve("./driveos-hash-cache.json");

function resolveAgentHome() {
  if (process.env.DRIVEOS_AGENT_HOME) return path.resolve(process.env.DRIVEOS_AGENT_HOME);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "DriveOS Agent");
  if (process.platform === "win32") return path.join(process.env.APPDATA || os.homedir(), "DriveOS Agent");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "driveos-agent");
}

const AGENT_HOME = resolveAgentHome();
const CONFIG_PATH = path.join(AGENT_HOME, "driveos-config.json");
const HASH_CACHE_PATH = path.join(AGENT_HOME, "driveos-hash-cache.json");
const OFFLINE_LOG_PATH = path.join(AGENT_HOME, "driveos-agent-offline-log.txt");
const STATE_PATH = path.join(AGENT_HOME, "driveos-agent-state.json");
const SCAN_LOCK_PATH = path.join(AGENT_HOME, "driveos-scan.lock");
const scanLock = createProcessLock(SCAN_LOCK_PATH, { honorLegacyOwner: true });
const acquireScanLock = () => scanLock.acquire();
const releaseScanLock = () => scanLock.release();

const DEFAULT_CONFIG: DriveOSConfig = {
  machineName: "CJ-Workstation",
  ownerId: "cj",
  convexUrl: DEFAULT_CONVEX_URL,
  quarantineRoot: path.join(AGENT_HOME, "quarantine"),
  quarantineOnSourceVolume: true,
  scanRoots: [],
  minFileSizeBytes: ONE_MB,
  fullHash: false,
};

// Per-volume quarantine folder name. Lives at the root of each scanned volume
// when quarantineOnSourceVolume is on, and is in IGNORED_FOLDERS so scans never
// re-catalog files that were just quarantined.

const IGNORED_FOLDERS = new Set([
  ".TRASH",
  ".TRASHES",
  ".SPOTLIGHT-V100",
  ".FSEVENTSD",
  "SYSTEM VOLUME INFORMATION",
  "NODE_MODULES",
  ".GIT",
  ".DS_STORE",
  "TEMPORARY",
  "TMP",
  QUARANTINE_FOLDER_NAME.toUpperCase(),
]);

// Substring markers matched against the lowercased, resolved path.
const CLOUD_SYNC_MARKERS = [
  { name: "iCloud Drive", markers: ["mobile documents", "com~apple~clouddocs", "icloud drive", `${path.sep}cloudstorage${path.sep}icloud`] },
  { name: "Dropbox", markers: [`${path.sep}dropbox${path.sep}`, `${path.sep}cloudstorage${path.sep}dropbox`] },
  { name: "Google Drive", markers: ["google drive", "googledrive", "drivefs", `${path.sep}cloudstorage${path.sep}google`] },
  { name: "OneDrive", markers: ["onedrive", `${path.sep}cloudstorage${path.sep}onedrive`] },
  { name: "Box", markers: [`${path.sep}box${path.sep}`, `${path.sep}cloudstorage${path.sep}box`] },
  { name: "Creative Cloud Files", markers: ["creative cloud files"] },
  // Any macOS file-provider mount lives under ~/Library/CloudStorage — treat the
  // whole tree as cloud-synced even if the specific provider is unrecognized.
  { name: "CloudStorage provider", markers: [`${path.sep}library${path.sep}cloudstorage${path.sep}`] },
];

// Folders that sit directly at the home root for some providers (e.g. ~/Dropbox,
// ~/Google Drive). Matched only when the resolved path is at/under that exact dir.
const CLOUD_HOME_DIRS = [
  { name: "Dropbox", dir: "Dropbox" },
  { name: "Google Drive", dir: "Google Drive" },
  { name: "OneDrive", dir: "OneDrive" },
  { name: "Box", dir: "Box" },
];

const PROJECT_FOLDER_TREE = [
  "00_ADMIN/CONTRACTS",
  "00_ADMIN/LICENSES",
  "00_ADMIN/NOTES",
  "01_BRIEF",
  "02_RAW/A_CAM",
  "02_RAW/B_CAM",
  "02_RAW/AUDIO",
  "02_RAW/DRONE",
  "02_RAW/SCREEN_RECORDINGS",
  "03_PROJECT_FILES/PREMIERE",
  "03_PROJECT_FILES/AFTER_EFFECTS",
  "03_PROJECT_FILES/DAVINCI",
  "03_PROJECT_FILES/FINAL_CUT",
  "04_ASSETS/MUSIC",
  "04_ASSETS/SFX",
  "04_ASSETS/STOCK_FOOTAGE",
  "04_ASSETS/GRAPHICS",
  "04_ASSETS/FONTS",
  "04_ASSETS/LUTS",
  "05_PROXIES",
  "06_RENDERS_CACHE/PREMIERE_PREVIEWS",
  "06_RENDERS_CACHE/AFTER_EFFECTS_CACHE",
  "06_RENDERS_CACHE/DAVINCI_CACHE",
  "07_EXPORTS/REVIEW",
  "07_EXPORTS/FINAL",
  "07_EXPORTS/SOCIAL_CUTDOWNS",
  "08_DELIVERY",
  "09_ARCHIVE_MANIFEST",
];

function ensureAgentHome() {
  fs.mkdirSync(AGENT_HOME, { recursive: true });
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  // Tolerate an empty or truncated file (e.g. a hash-cache write interrupted by
  // a force-quit or an external volume unmounting mid-write). A corrupt cache
  // must never crash a scan — treat it as missing and rebuild it.
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    if (!content.trim()) return null;
    return JSON.parse(content) as T;
  } catch (err: any) {
    console.warn(`[Config Warning] Ignoring unreadable JSON at ${filePath}: ${err.message}`);
    return null;
  }
}

function loadConfig(): DriveOSConfig {
  const current = readJsonFile<Partial<DriveOSConfig>>(CONFIG_PATH);
  if (current) return { ...DEFAULT_CONFIG, ...current };

  const legacy = readJsonFile<Partial<DriveOSConfig>>(LEGACY_CONFIG_PATH);
  if (legacy) return { ...DEFAULT_CONFIG, ...legacy };

  return DEFAULT_CONFIG;
}

function saveConfig(config: DriveOSConfig) {
  ensureAgentHome();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function loadHashCache(): Record<string, HashCacheEntry> {
  return readJsonFile<Record<string, HashCacheEntry>>(HASH_CACHE_PATH)
    || readJsonFile<Record<string, HashCacheEntry>>(LEGACY_HASH_CACHE_PATH)
    || {};
}

function saveHashCache(cache: Record<string, HashCacheEntry>) {
  ensureAgentHome();
  // Atomic write: serialize to a temp file then rename over the target. A rename
  // is atomic on the same volume, so a concurrent reader (another volume's scan)
  // never observes a half-written cache — the previous fix's root cause.
  const tmp = `${HASH_CACHE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf-8");
  fs.renameSync(tmp, HASH_CACHE_PATH);
}

// The cache is one JSON file; rewriting it after every 100-file batch is O(n²)
// disk churn on big drives. Persist at most every 30s mid-scan — a crash only
// loses the last interval of hashes, which the next scan recomputes.
let lastHashCacheSaveAt = 0;
function saveHashCacheThrottled(cache: Record<string, HashCacheEntry>) {
  const now = Date.now();
  if (now - lastHashCacheSaveAt < 30_000) return;
  lastHashCacheSaveAt = now;
  saveHashCache(cache);
}

const DEFAULT_STATE: AgentState = { paused: false };

function loadState(): AgentState {
  return { ...DEFAULT_STATE, ...(readJsonFile<Partial<AgentState>>(STATE_PATH) || {}) };
}

function saveState(patch: Partial<AgentState>) {
  ensureAgentHome();
  const next = { ...loadState(), ...patch };
  fs.writeFileSync(STATE_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function cloudSyncProvider(targetPath: string) {
  const resolved = path.resolve(targetPath);
  const normalized = resolved.toLowerCase();
  for (const provider of CLOUD_SYNC_MARKERS) {
    if (provider.markers.some((marker) => normalized.includes(marker.toLowerCase()))) return provider.name;
  }
  // Home-rooted provider folders: only match the exact ~/<dir> tree, so an
  // unrelated path that merely contains the word "box" isn't flagged.
  const home = os.homedir();
  for (const { name, dir } of CLOUD_HOME_DIRS) {
    const base = path.join(home, dir);
    const rel = path.relative(base, resolved);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return name;
  }
  return null;
}

function enforceLocalStatePath(label: string, targetPath: string) {
  const provider = cloudSyncProvider(targetPath);
  if (!provider) return;
  console.error(`[Safety Block] ${label} is inside ${provider}: ${path.resolve(targetPath)}`);
  console.error("[Safety Block] DriveOS stores scanner state in the app data directory to avoid cloud-sync loops.");
  process.exit(1);
}

function enforceTrackableRoot(label: string, targetPath: string, allowCloudRoot = false) {
  const provider = cloudSyncProvider(targetPath);
  if (!provider) return;
  const resolved = path.resolve(targetPath);
  if (!allowCloudRoot) {
    console.error(`[Safety Block] ${label} appears to be inside ${provider}: ${resolved}`);
    console.error("[Safety Block] Cloud-synced folders must be enabled explicitly with --allow-cloud-root.");
    console.error("[Safety Block] DriveOS will scan metadata only and will not create cache/config files inside that folder.");
    process.exit(1);
  }
  console.warn(`[Cloud Folder Warning] Tracking ${provider} path as metadata only: ${resolved}`);
}

function validateRuntimeConfig(config: DriveOSConfig) {
  ensureAgentHome();
  enforceLocalStatePath("Agent data directory", AGENT_HOME);
  enforceLocalStatePath("Quarantine root", config.quarantineRoot);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isFileStable(filePath: string, waitMs = 2000) {
  const first = fs.statSync(filePath);
  await sleep(waitMs);
  const second = fs.statSync(filePath);
  return first.size === second.size && first.mtimeMs === second.mtimeMs;
}

function resolveConvexHttpUrl(convexUrl: string) {
  const trimmed = convexUrl.replace(/\/+$/, "");
  if (trimmed.endsWith("/api")) return trimmed.slice(0, -4);
  return trimmed.replace(".convex.cloud", ".convex.site");
}

// Transport failures remain distinct from server-requested rate-limit delays.
class BackendSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendSyncError";
  }
}

function recordSyncFailure(endpoint: string, message: string) {
  ensureAgentHome();
  // Never persist the request payload here. A failed uploadBatch can contain
  // hundreds of KB of metadata and the old offline log could fill the disk
  // while Convex was unavailable.
  fs.appendFileSync(
    OFFLINE_LOG_PATH,
    `[${new Date().toISOString()}] ${endpoint}: ${message}\n`,
    "utf-8"
  );
}

async function syncToConvex(endpoint: string, payload: any) {
  const config = loadConfig();
  const baseUrl = resolveConvexHttpUrl(config.convexUrl);
  const url = `${baseUrl}/api/${endpoint}`;
  console.log(`[Convex Sync] POST ${url}`);

  let response: Response;
  let text: string;
  try {
    ({ response, text } = await postBackendJson(url, payload, config.authToken));
  } catch (err: any) {
    const message = err?.message || "Network request failed";
    console.warn(`[Convex Sync Stopped] ${endpoint} failed: ${message}`);
    recordSyncFailure(endpoint, message);
    throw new BackendSyncError(message);
  }

  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // Non-JSON error page; fall through with the raw status below.
  }

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("Retry-After")) || 60;
    throw new RateLimitedError(body.error || "Rate limited by backend", retryAfter);
  }

  if (!response.ok) {
    const message = body.error || `HTTP Error: ${response.status} ${response.statusText}`;
    console.warn(`[Convex Sync Stopped] ${endpoint} failed: ${message}`);
    recordSyncFailure(endpoint, message);
    throw new BackendSyncError(message);
  }

  return body;
}

async function calculateQuickHash(filePath: string, sizeBytes: number): Promise<string> {
  if (sizeBytes < 4096) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash("md5").update(content).digest("hex");
  }

  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(3072);

  try {
    fs.readSync(fd, buffer, 0, 1024, 0);
    fs.readSync(fd, buffer, 1024, 1024, Math.round(sizeBytes / 2) - 512);
    fs.readSync(fd, buffer, 2048, 1024, sizeBytes - 1024);

    const sizeBuffer = Buffer.alloc(8);
    sizeBuffer.writeBigInt64BE(BigInt(sizeBytes));

    return crypto.createHash("md5").update(buffer).update(sizeBuffer).digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

function calculateFullHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function shouldIgnoreDirectory(entry: string) {
  return IGNORED_FOLDERS.has(entry.toUpperCase());
}

function normalizeExtension(fileName: string) {
  const ext = path.extname(fileName).replace(/^\./, "");
  return ext.toLowerCase();
}

function isProjectFileName(fileName: string) {
  return [".prproj", ".aep", ".drp", ".fcpxml", ".psd", ".ai"].some((ext) =>
    fileName.toLowerCase().endsWith(ext)
  );
}

function getDriveMetrics(rootPath: string) {
  try {
    const stats = fs.statfsSync(rootPath);
    const blockSize = Number(stats.bsize);
    const capacityBytes = Number(stats.blocks) * blockSize;
    const freeBlocks = Number(stats.bavail || stats.bfree);
    const freeBytes = freeBlocks * blockSize;
    return {
      capacityBytes,
      freeBytes,
      usedBytes: Math.max(0, capacityBytes - freeBytes),
      filesystem: "local",
    };
  } catch {
    return {
      capacityBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      filesystem: "unknown",
    };
  }
}

async function buildFileMetadata(
  filePath: string,
  statObj: fs.Stats,
  hashCache: Record<string, HashCacheEntry>,
  calculateFull: boolean
): Promise<FileMetadata> {
  const entry = path.basename(filePath);
  const cacheKey = `${filePath}-${statObj.size}`;
  const cached = hashCache[cacheKey];

  let quickHash = cached?.modifiedAt === statObj.mtimeMs && !cached.observationInvalidated ? cached.quickHash : undefined;
  let fullHash = cached?.modifiedAt === statObj.mtimeMs && !cached.observationInvalidated ? cached.fullHash : undefined;

  if (!quickHash) {
    quickHash = await calculateQuickHash(filePath, statObj.size);
  }
  if (calculateFull && !fullHash) {
    fullHash = await calculateFullHash(filePath);
  }

  // Spread first: a plain overwrite would drop uploadedFp and silently turn
  // every scan back into a full re-upload.
  hashCache[cacheKey] = {
    ...hashCache[cacheKey],
    sizeBytes: statObj.size,
    modifiedAt: statObj.mtimeMs,
    quickHash,
    fullHash,
  };

  const classification = classifyFile(filePath, entry);
  const riskLevel = calculateFileRisk(classification, statObj.size);

  return {
    path: filePath,
    normalizedPath: filePath.toLowerCase(),
    parentPath: path.dirname(filePath),
    name: entry,
    extension: normalizeExtension(entry),
    sizeBytes: statObj.size,
    createdAtFile: statObj.birthtimeMs,
    modifiedAtFile: statObj.mtimeMs,
    quickHash,
    fullHash,
    classification,
    riskLevel,
    isGenerated: classification === "CACHE" || classification === "PROXY" || classification === "RENDER_PREVIEW",
    isRaw: classification === "RAW",
    isFinal: classification === "EXPORT_FINAL",
    isProjectFile: isProjectFileName(entry),
  };
}

// Everything the backend stores about a file, in one comparable string. If the
// current fingerprint equals the one recorded at the last successful upload,
// the backend already has identical data and the file is skipped. The derived
// flags (isGenerated/isRaw/isFinal) follow classification, so covering
// classification covers them too.
function metadataFingerprint(meta: FileMetadata): string {
  return [
    meta.sizeBytes,
    meta.modifiedAtFile,
    meta.quickHash ?? "",
    meta.fullHash ?? "",
    meta.classification,
    meta.riskLevel,
    meta.isProjectFile ? 1 : 0,
  ].join("|");
}

// Must mirror the cacheKey built in buildFileMetadata.
function cacheKeyFor(meta: FileMetadata): string {
  return `${meta.path}-${meta.sizeBytes}`;
}

// Record a successful upload in the hash cache so the next scan skips these
// files. Only called after the backend confirmed the batch (never in offline
// mode) — an unstamped file simply retries on the next cycle.
function stampUploaded(hashCache: Record<string, HashCacheEntry>, files: FileMetadata[], receipts?: unknown) {
  const acknowledged = new Map(catalogReceipts(receipts).map(receipt => [receipt.path, receipt]));
  for (const meta of files) {
    const key = cacheKeyFor(meta);
    const receipt = acknowledged.get(meta.path);
    let parent: DirectoryIdentity | undefined;
    if (receipt) { try { parent = directoryIdentity(path.dirname(meta.path)); } catch { /* Deletions require root availability too. */ } }
    hashCache[key] = {
      ...hashCache[key],
      sizeBytes: meta.sizeBytes,
      modifiedAt: meta.modifiedAtFile,
      quickHash: meta.quickHash || hashCache[key]?.quickHash || "",
      fullHash: meta.fullHash ?? (hashCache[key]?.modifiedAt === meta.modifiedAtFile ? hashCache[key]?.fullHash : undefined),
      uploadedFp: metadataFingerprint(meta),
      catalogReceipt: receipt,
      catalogParent: parent,
      observationInvalidated: undefined,
    };
  }
}

async function walkFiles(
  dir: string,
  visitor: (filePath: string, statObj: fs.Stats) => Promise<void>,
  minFileSizeBytes = 0,
  maxFileSizeBytes = Infinity
) {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err: any) {
    console.warn(`[Permission Denied] Skipping directory ${dir}: ${err.message}`);
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    let statObj: fs.Stats;
    try {
      statObj = fs.statSync(fullPath);
    } catch (err: any) {
      console.warn(`[Skip File] Cannot stat ${fullPath}: ${err.message}`);
      continue;
    }

    if (statObj.isDirectory()) {
      if (shouldIgnoreDirectory(entry)) {
        console.log(`[Ignored Folder] Skipping ${entry}`);
        continue;
      }
      await walkFiles(fullPath, visitor, minFileSizeBytes, maxFileSizeBytes);
    } else if (statObj.isFile() && statObj.size >= minFileSizeBytes && statObj.size < maxFileSizeBytes) {
      await visitor(fullPath, statObj);
    }
  }
}

function buildProjectManifest(project: any, projectId: string, root: string) {
  return {
    projectId,
    projectName: project?.name || project?.projectName || path.basename(root),
    client: project?.client || "",
    showName: project?.showName || "",
    owner: project?.ownerId || project?.owner || loadConfig().ownerId,
    createdAt: new Date().toISOString(),
    status: project?.status || "active",
    tier: project?.tier || "hot",
    folderTemplate: project?.template || "DriveOS Standard",
    deleteRules: {
      raw: "never_auto_delete",
      projectFiles: "never_auto_delete",
      finalExports: "keep",
      proxies: "safe_after_delivery",
      cache: "safe_after_confirmation",
      reviewExports: "safe_after_final_delivery",
    },
  };
}

function writeProjectStructure(root: string, project: any, projectId: string, allowCloud = false) {
  // Scaffolding writes ~28 folders + a manifest. Refuse to do that inside a
  // cloud-synced folder unless explicitly allowed — it would spawn many small
  // files that trigger sync churn.
  const provider = cloudSyncProvider(root);
  if (provider && !allowCloud) {
    throw new Error(
      `Refusing to scaffold a project inside ${provider}: ${path.resolve(root)}. ` +
      `Cloud-synced folders generate sync churn. Use --allow-cloud-root to override.`
    );
  }
  if (provider) {
    console.warn(`[Cloud Folder Warning] Scaffolding project inside ${provider}: ${path.resolve(root)}`);
  }

  for (const branch of PROJECT_FOLDER_TREE) {
    fs.mkdirSync(path.join(root, branch), { recursive: true });
  }

  const manifest = buildProjectManifest(project, projectId, root);
  const manifestPath = path.join(root, "09_ARCHIVE_MANIFEST", "project_manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  return { manifest, manifestPath };
}

async function renewJobLease(job: any) {
  // A fresh lease skips HTTP. Still service socket-close events and timers
  // between synchronous file operations, including before terminal reports.
  await yieldToIO();
  if (!(job.leaseClient instanceof JobLeaseClient)) throw new Error("The job has no active lease.");
  await job.leaseClient.ensureValid();
}

async function reportJob(job: any, payload: any) {
  await withRateLimitBackoff(async () => {
    await renewJobLease(job);
    const result = await syncToConvex("updateJobStatus", { ...payload, jobId: job._id, claimToken: job.claimToken, keepCopyProtocol: 1 });
    if (!result.claimed) throw new Error(`Job result was not accepted: ${result.reason || result.status}`);
  });
}

async function executeQuarantineJob(job: any, config: DriveOSConfig, journal: OperationJournal) {
  validateRuntimeConfig(config);
  const quarantineFiles = [];
  const failures: { fileId: string; error: string }[] = [];
  const timestamp = new Date().toISOString().split("T")[0];

  for (const file of job.files || []) {
    if (isProtectedSourceFile(file)) {
      console.warn(`[Quarantine Blocked] Protected ${file.classification} file skipped: ${file.path}`);
      failures.push({ fileId: file._id, error: "Protected source file" });
      continue;
    }

    if (!fs.existsSync(file.path) && !journal.has(file._id)) {
      console.warn(`[Quarantine Warning] File was missing: ${file.path}`);
      failures.push({ fileId: file._id, error: "Source file is missing" });
      continue;
    }

    const destination = journal.destination(file._id) || quarantineDestination(file.path, config, job._id, timestamp);

    console.log(`[Quarantine Execute] ${file.path} -> ${destination}`);
    try {
      let keepStillCurrent: (() => void) | undefined;
      await renewJobLease(job);
      if (!journal.has(file._id)) {
        const current = fs.statSync(file.path);
        if (current.size !== file.sizeBytes || (typeof file.modifiedAtFile === "number" && Math.abs(current.mtimeMs - file.modifiedAtFile) > 1)) {
          throw new Error("File changed since its last scan. Scan it again before cleanup.");
        }
        const classification = classifyFile(file.path, path.basename(file.path));
        if (!["CACHE", "RENDER_PREVIEW", "PROXY"].includes(classification)) {
          if (!file.fullHash || await calculateFullHash(file.path) !== file.fullHash) {
            throw new Error("The duplicate content hash is missing or changed. Run a full-hash scan before cleanup.");
          }
        }
      }
      // A database duplicate can have been deleted or edited since the scan.
      // Reconcile already-moved journal receipts without demanding a keep copy
      // which may have disappeared after that earlier physical operation.
      if (!isRegenerablePath(file.path) && !(journal.has(file._id) && !fs.existsSync(file.path))) {
        const proof: KeepCopyProof | undefined = job.result?.keepCopyProofs?.find((entry: KeepCopyProof) => entry.fileId === file._id);
        keepStillCurrent = await verifyKeepCopy({ fileId: file._id, path: file.path, sizeBytes: file.sizeBytes, fullHash: file.fullHash }, proof, job.machineId);
      }
      await renewJobLease(job);
      journal.move(file._id, file.path, destination, keepStillCurrent);
    } catch (err: any) {
      if (err instanceof RateLimitedError || err instanceof JobLeaseLostError) throw err;
      // Preserve a running job when a physical move may have succeeded but its
      // receipt could not be persisted. The next attempt reconciles the journal.
      if (journal.completed(file._id) || (journal.has(file._id) && !fs.existsSync(file.path))) throw err;
      console.error(`[Quarantine Error] Could not move ${file.path}: ${err.message}`);
      failures.push({ fileId: file._id, error: err.message });
      continue;
    }
    quarantineFiles.push({
      fileId: file._id,
      originalPath: file.path,
      quarantinePath: destination,
      sizeBytes: file.sizeBytes,
    });
  }

  await reportJob(job, {
    status: failures.length > 0 ? "failed" : "completed",
    quarantineFiles,
    result: { moved: quarantineFiles.length, failures },
  });

  console.log(`[Quarantine Result] Relocated ${quarantineFiles.length} file(s); ${failures.length} skipped or failed.`);
}

// Permanently delete quarantined files whose rollback window expired. The backend
// only ever queues items already past 14 days, so this is the point of no return.
// Reports back exactly which items were removed, so a file that's already gone or
// fails to delete simply isn't marked deleted (it stays recoverable in the UI).
async function executePurgeJob(job: any, journal: OperationJournal) {
  const purgeItems: { quarantineItemId: string; quarantinePath: string; fileId?: string; originalPath?: string;
    sizeBytes?: number; fullHash?: string; requiresKeepCopy?: boolean; keepCopyProof?: KeepCopyProof }[] = job.result?.purgeItems || [];
  const purgedItemIds: string[] = [];
  const failures: { quarantineItemId: string; error: string }[] = [];
  let freedBytes = 0;

  for (const item of purgeItems) {
    try {
      let keepStillCurrent: (() => void) | undefined;
      await renewJobLease(job);
      if ((item.requiresKeepCopy || !isRegenerablePath(item.originalPath)) &&
          !(journal.has(item.quarantineItemId) && !fs.existsSync(item.quarantinePath))) {
        keepStillCurrent = await verifyKeepCopy({ fileId: item.fileId || "", path: item.quarantinePath,
          sizeBytes: item.sizeBytes ?? -1, fullHash: item.fullHash }, item.keepCopyProof, job.machineId);
      }
      await renewJobLease(job);
      freedBytes += journal.purge(item.quarantineItemId, item.quarantinePath, keepStillCurrent);
      console.log(`[Purge] Permanently deleted ${item.quarantinePath}`);
      purgedItemIds.push(item.quarantineItemId);
    } catch (err: any) {
      if (err instanceof RateLimitedError || err instanceof JobLeaseLostError) throw err;
      if (journal.has(item.quarantineItemId) && !fs.existsSync(item.quarantinePath)) throw err;
      console.error(`[Purge Error] Could not delete ${item.quarantinePath}: ${err.message}`);
      failures.push({ quarantineItemId: item.quarantineItemId, error: err.message });
    }
  }

  await reportJob(job, {
    status: failures.length > 0 ? "failed" : "completed",
    result: { purgedItemIds, failures },
  });
  console.log(`[Success] Purged ${purgedItemIds.length} item(s), freed ${(freedBytes / (1024 ** 3)).toFixed(2)} GB.`);
}

async function generateArchiveManifest(projectId: string, rootOverride?: string, verify = false, expectedManifestChecksum?: string, allowCloudRoot = false) {
  const projectRes = await syncToConvex("getProject", { projectId });
  const project = projectRes.project;
  const configuredRoot = rootOverride || project?.rootPath;
  if (!project || !configuredRoot || !path.isAbsolute(configuredRoot) || !fs.existsSync(configuredRoot)) {
    throw new Error("The project must have an existing absolute local root before a manifest can be generated.");
  }
  const root = path.resolve(configuredRoot);
  const provider = cloudSyncProvider(root);
  if (provider && !allowCloudRoot) throw new Error("Archive manifests must be generated on a local project drive. Use --allow-cloud-root for an explicit CLI override.");
  if (provider) console.warn(`[Cloud Folder Warning] Generating a full-checksum manifest inside ${provider}: ${root}`);
  const manifestPath = path.join(root, "09_ARCHIVE_MANIFEST", "archive_manifest.json");
  let baseline: any = null;
  if (verify) {
    if (!expectedManifestChecksum || !fs.existsSync(manifestPath)) throw new Error("Generate a checksummed archive manifest before verifying this project.");
    const saved = fs.readFileSync(manifestPath, "utf8");
    if (crypto.createHash("sha256").update(saved).digest("hex") !== expectedManifestChecksum) throw new Error("The saved manifest changed since it was registered.");
    baseline = JSON.parse(saved);
    if (!Array.isArray(baseline.files) || baseline.files.some((file: any) => !file.fullHash)) throw new Error("The manifest has no complete SHA-256 inventory. Generate it again.");
  }
  const hashCache: Record<string, HashCacheEntry> = {};
  const files: any[] = [];
  let totalBytes = 0;
  await walkManifestFiles(root, async (filePath, stats) => {
    const metadata = await buildFileMetadata(filePath, stats, hashCache, false);
    // Verification must re-read content, even when a cached size/mtime matches.
    const fullHash = await calculateFullHash(filePath);
    const after = fs.statSync(filePath);
    if (stats.size !== after.size || stats.mtimeMs !== after.mtimeMs) throw new Error(`File changed while generating manifest: ${filePath}`);
    totalBytes += stats.size;
    files.push({ path: metadata.path, sizeBytes: metadata.sizeBytes, modifiedAtFile: metadata.modifiedAtFile,
      quickHash: metadata.quickHash, fullHash, classification: metadata.classification });
  });
  if (baseline) {
    const current = new Map(files.map(file => [path.resolve(file.path), file]));
    if (current.size !== baseline.files.length) throw new Error("Project inventory changed since the manifest was generated.");
    for (const entry of baseline.files) {
      const file = current.get(path.resolve(entry.path));
      if (!file || file.sizeBytes !== entry.sizeBytes || file.fullHash !== entry.fullHash) throw new Error(`Archive verification failed for ${entry.path}`);
    }
    const verificationResult = { verified: true, checkedFiles: files.length, checkedAt: Date.now() };
    await syncToConvex("createManifest", { projectId, createdBy: project.ownerId || loadConfig().ownerId,
      fileCount: files.length, totalBytes, manifestPath, checksum: expectedManifestChecksum, verificationResult });
    return { manifestPath, checksum: expectedManifestChecksum, fileCount: files.length, totalBytes, verificationResult };
  }
  const manifest = { ...buildProjectManifest(project, projectId, root), generatedAt: new Date().toISOString(),
    rootPath: root, fileCount: files.length, totalBytes, files };
  const serialized = JSON.stringify(manifest, null, 2);
  const checksum = crypto.createHash("sha256").update(serialized).digest("hex");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, serialized, "utf8");
  await syncToConvex("createManifest", { projectId, createdBy: project.ownerId || loadConfig().ownerId,
    fileCount: files.length, totalBytes, manifestPath, checksum });
  return { manifestPath, checksum, fileCount: files.length, totalBytes };
}

async function executeJob(job: any, config: DriveOSConfig): Promise<boolean> {
  if (!["approved", "queued", "running"].includes(job.status)) throw new Error("Only approved, queued, or interrupted jobs can run.");
  const scope = `${resolveConvexHttpUrl(config.convexUrl)}|${config.machineName}|${job._id}|${job.action}`;
  const journalPath = path.join(AGENT_HOME, "jobs", `${crypto.createHash("sha256").update(scope).digest("hex")}.json`);
  const executionLock = createProcessLock(`${journalPath}.lock`, { honorLegacyOwner: false });
  if (!await executionLock.acquire()) {
    console.log(`[Agent Queue] Job ${job._id} is active in another local process.`);
    return false;
  }
  let heartbeat: NodeJS.Timeout | undefined;
  let claimed = false;
  try {
    console.log(`[Agent Queue] Executing job ${job._id}: ${job.action}`);
    job.claimToken = crypto.randomUUID();
    const claim = await withRateLimitBackoff(() => syncToConvex("updateJobStatus", { jobId: job._id, status: "running", claimToken: job.claimToken, keepCopyProtocol: 1 }));
    if (claim.claimed !== true) {
      console.log(`[Agent Queue] Job ${job._id} was already claimed or completed — skipped.`);
      return false;
    }
    claimed = true;
    job.leaseClient = new JobLeaseClient(() => syncToConvex("updateJobStatus", { jobId: job._id, status: "running", claimToken: job.claimToken, keepCopyProtocol: 1 }));
    const journal = new OperationJournal(journalPath, scope);
    let renewing = false;
    heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void renewJobLease(job).catch((error: Error) => console.warn(`[Agent Lease] ${error.message}`)).finally(() => { renewing = false; });
    }, 20_000);
    heartbeat.unref();

    if (job.action === "quarantine") {
      await executeQuarantineJob(job, config, journal);
      return true;
    }

    if (job.action === "purge") {
      await executePurgeJob(job, journal);
      return true;
    }

    if (job.action === "restore") {
      const quarantineId = job.result?.quarantineId;
      if (!quarantineId) {
        await reportJob(job, { status: "failed", result: { error: "Restore job is missing its quarantine item." } });
        return true;
      }
      const response = await syncToConvex("getQuarantineItem", { quarantineId });
      const item = response.item;
      if (!item) {
        await reportJob(job, { status: "failed", result: { error: "The quarantine item is unavailable on this machine." } });
        return true;
      }
      await renewJobLease(job);
      try {
        journal.move(quarantineId, item.quarantinePath, item.originalPath);
      } catch (error: any) {
        if (fs.existsSync(item.quarantinePath) || !journal.has(quarantineId)) {
          await reportJob(job, { status: "failed", result: { error: error.message } });
          return true;
        }
        throw error;
      }
      await reportJob(job, { status: "completed", result: { restoredQuarantineIds: [quarantineId] } });
      return true;
    }

    if (job.action === "scan") {
      const root = job.result?.rootPath;
      if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) throw new Error("The requested drive is unavailable on this machine.");
      if (!await acquireScanLock()) throw new Error("Another scan is running. Retry when it finishes.");
      try {
        const scan = await performScan(root, loadConfig(), { checkStability: true });
        await reportJob(job, { status: scan.partial ? "failed" : "completed", result: { ...job.result, ...scan } });
      } finally {
        await releaseScanLock();
      }
      return true;
    }

    if (job.action === "generate_manifest") {
      const result = await generateArchiveManifest(job.result?.projectId, job.result?.rootPath, Boolean(job.result?.verify), job.result?.expectedManifestChecksum);
      await reportJob(job, { status: "completed", result });
      return true;
    }

    if (job.action === "create_folder_structure") {
      const result = job.result || {};
      const rootPath = result.rootPath;
      if (!rootPath) throw new Error("create_folder_structure job missing result.rootPath");

      const { manifest, manifestPath } = writeProjectStructure(rootPath, result, result.projectId || job._id);
      const manifestJson = fs.readFileSync(manifestPath, "utf8");
      await syncToConvex("createManifest", {
        projectId: result.projectId || job._id,
        createdBy: result.owner || config.ownerId,
        fileCount: 1,
        totalBytes: Buffer.byteLength(manifestJson),
        manifestPath,
        checksum: crypto.createHash("sha256").update(manifestJson).digest("hex"),
      });
      await reportJob(job, { status: "completed", result: { ...result, manifestPath, folderCount: PROJECT_FOLDER_TREE.length, completedAt: Date.now() } });
      console.log(`[Success] Created project folder structure at ${rootPath}.`);
      return true;
    }

    throw new Error(`Unsupported agent action: ${job.action}`);
  } catch (error: any) {
    // Destructive operations keep their lease/journal on an unexpected stop.
    // A later attempt can finish reporting files already moved or deleted.
    if (claimed && !["quarantine", "purge", "restore"].includes(job.action)) {
      try { await reportJob(job, { status: "failed", result: { error: error.message } }); }
      catch { /* expired or offline: leave running for recovery */ }
    }
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await executionLock.release();
  }
}

interface ScanOptions {
  fullHash?: boolean;
  allowCloudRoot?: boolean;
  checkStability?: boolean;
  // Size window for progressive scanning: pass 1 covers >= maxFileSizeBytes
  // (big media first, fast results), pass 2 fills in the rest.
  minFileSizeBytes?: number;
  maxFileSizeBytes?: number;
  passLabel?: string;
  // In-memory hash cache shared across all volumes in one sync cycle, so they
  // don't reload each other's mid-scan writes.
  sharedHashCache?: Record<string, HashCacheEntry>;
  // Ignore uploadedFp and re-send every file (first sync or explicit
  // --force-full). Normal cycles upload only what changed.
  forceFullUpload?: boolean;
}

interface ScanResult {
  partial: boolean;
  fileCount: number;
  byteCount: number;
  errorsCount: number;
  skippedUnstable: number;
  uploadedCount: number;
  skippedUnchanged: number;
  baselinedCount: number;
}

// Single batched scan of one directory: register machine/drive, open a scan
// session, walk files >minSize, upload metadata in chunks of 100, and close the
// session. This is the unit of work the hourly scheduler and `scan-now` reuse.
async function performScan(scanDir: string, config: DriveOSConfig, options: ScanOptions = {}): Promise<ScanResult> {
  enforceTrackableRoot("Scan target", scanDir, Boolean(options.allowCloudRoot));
  validateRuntimeConfig(config);

  // A sync cycle scanning several volumes shares one in-memory cache (passed via
  // options.sharedHashCache) so volumes don't reload each other's mid-scan
  // writes. A one-shot `scan` loads its own.
  const hashCache = options.sharedHashCache ?? loadHashCache();
  const calculateFull = Boolean(options.fullHash || config.fullHash);
  const driveMetrics = getDriveMetrics(scanDir);
  const cloudProvider = cloudSyncProvider(scanDir);

  // A legacy config may contain 0 here. Never allow it to turn cache crumbs and
  // sidecar files into millions of database documents again.
  const minBytes = Math.max(
    MIN_CATALOG_FILE_SIZE_BYTES,
    options.minFileSizeBytes ?? config.minFileSizeBytes
  );
  const maxBytes = options.maxFileSizeBytes ?? Infinity;
  const sizeRange = Number.isFinite(maxBytes)
    ? `${Math.round(minBytes / ONE_MB)}–${Math.round(maxBytes / ONE_MB)} MB`
    : `larger than ${Math.round(minBytes / ONE_MB)} MB`;
  console.log(`[Scan Start]${options.passLabel ? ` (${options.passLabel})` : ""} Crawling files ${sizeRange} in ${scanDir}`);
  if (cloudProvider) {
    console.warn(`[Cloud Folder] ${scanDir} is in ${cloudProvider} — tracking as metadata-only (cloud tier), not a normal drive.`);
  }

  const machineRes = await syncToConvex("registerMachine", {
    name: config.machineName,
    ownerId: config.ownerId,
    agentVersion: AGENT_VERSION,
    platform: process.platform,
    location: config.location,
  });
  const machineId = machineRes.machineId || config.machineName;

  // Cloud-synced roots register as metadata-tracked (tier "cloud", filesystem
  // "cloud") so the dashboard never treats them as a normal local hot drive.
  const driveRes = await syncToConvex("registerDrive", {
    label: path.basename(scanDir),
    volumeId: `${process.platform}:${scanDir}`,
    machineId,
    ownerId: config.ownerId,
    ...driveMetrics,
    filesystem: cloudProvider ? "cloud" : driveMetrics.filesystem,
    mountPath: scanDir,
    tier: cloudProvider ? "cloud" : "hot",
  });
  const driveId = driveRes.driveId;
  const canBootstrapDeltaBaseline = driveRes.hasCatalog === true;

  // The backend just created this drive row, so it holds no catalog for it
  // (first-ever scan, or the drive was forgotten/removed and re-added). Any
  // local "already uploaded" stamps under this root are stale — drop them so
  // this scan re-sends everything instead of skipping into an empty catalog.
  if (driveRes.isNew) {
    const rootPrefix = scanDir.endsWith(path.sep) ? scanDir : scanDir + path.sep;
    let cleared = 0;
    for (const key of Object.keys(hashCache)) {
      if (key.startsWith(rootPrefix) && requireCatalogReplay(hashCache[key], { driveId, machineId }, true)) cleared++;
    }
    if (cleared > 0) {
      // Persist the replay fence before any ACK; its cache save may be throttled.
      saveHashCache(hashCache);
      console.log(`[Delta Sync] Backend has no catalog for ${scanDir} — re-uploading all ${cleared} previously synced file(s).`);
    }
  }

  const scanRes = await syncToConvex("startScan", {
    machineId,
    driveId,
    rootPath: scanDir,
    agentVersion: AGENT_VERSION,
  });
  const sessionId = scanRes.sessionId || `offline-${Date.now()}`;

  const fileBatch: FileMetadata[] = [];
  const result: ScanResult = {
    partial: false,
    fileCount: 0,
    byteCount: 0,
    errorsCount: 0,
    skippedUnstable: 0,
    uploadedCount: 0,
    skippedUnchanged: 0,
    baselinedCount: 0,
  };

  // Set when the backend rejects an upload or becomes unavailable. The rest of
  // the walk becomes a no-op instead of hammering the same failing endpoint.
  // Whatever wasn't confirmed stays unstamped and retries on a later cycle.
  let uploadStopped = false;

  // Uploads run as a background chain so hashing never stalls on the network.
  // Each link catches its own error to keep the chain alive; backpressure in
  // flushBatch keeps hashing from racing unboundedly ahead of slow uploads.
  let uploadChain: Promise<void> = Promise.resolve();
  let pendingUploads = 0;

  async function flushBatch(final = false) {
    const batch = fileBatch.splice(0, fileBatch.length);
    if (batch.length > 0 && !uploadStopped) {
      pendingUploads++;
      uploadChain = uploadChain
        .then(async () => {
          if (uploadStopped) return;
          console.log(`[${final ? "Final " : ""}Batch Upload] Syncing ${batch.length} file(s) to Convex`);
          const uploaded = await syncToConvex("uploadBatch", { scanSessionId: sessionId, machineId, driveId, files: batch, catalogReceiptProtocol: 1 });
          stampUploaded(hashCache, batch, uploaded.receipts);
          result.uploadedCount += batch.length;
          saveHashCacheThrottled(hashCache);
        })
        .catch((err: any) => {
          uploadStopped = true;
          // Force-persist stamps for batches that DID succeed before this failure.
          // Otherwise the throttled save could drop the last <30s of confirmed
          // uploads, so the next cycle re-uploads them — feeding the re-scan loop.
          saveHashCache(hashCache);
          if (err instanceof RateLimitedError) {
            console.warn(`[Upload Budget] Backend rate limit hit — stopping uploads for this scan (retry in ~${err.retryAfterSeconds}s or next cycle): ${err.message}`);
            return;
          }
          result.errorsCount++;
          console.warn(`[Upload Error] Batch of ${batch.length} file(s) failed: ${err.message}`);
        })
        .finally(() => {
          pendingUploads--;
        });
    }
    if (final || pendingUploads > 3) await uploadChain;
  }

  // Hash several files concurrently: per-file time on spinning disks is seek
  // latency the drive can overlap, so a small pool gives a 2-4x faster walk.
  const HASH_CONCURRENCY = 12;
  let activeTasks = 0;
  const slotWaiters: (() => void)[] = [];
  const inFlight = new Set<Promise<void>>();

  const processFile = async (filePath: string, statObj: fs.Stats) => {
    if (uploadStopped) return;
    try {
      // Skip files that are still being written so we never index a half-flushed
      // export. Only files modified in the last minute can be mid-write, so the
      // 2-second stability wait is skipped for everything else — otherwise a big
      // drive pays 2s per file and a full scan takes hours.
      const recentlyModified = Date.now() - statObj.mtimeMs < 60_000;
      if (options.checkStability && recentlyModified && !(await isFileStable(filePath))) {
        result.skippedUnstable++;
        console.log(`[Scan Skip] File still changing, deferring to next cycle: ${filePath}`);
        return;
      }
      const existingCacheEntry = hashCache[`${filePath}-${statObj.size}`];
      if (existingCacheEntry) requireCatalogReplay(existingCacheEntry, { driveId, machineId });
      const meta = await buildFileMetadata(filePath, statObj, hashCache, calculateFull);
      result.fileCount++;
      result.byteCount += statObj.size;

      // Upgrade bridge from agent 1.0: its hash cache predates uploadedFp, but
      // registerDrive confirmed this drive already has a backend catalog. Trust
      // only cache entries that still match the current stat/hash. This avoids
      // a one-time 10M-row replay merely to establish the delta baseline.
      if (
        !options.forceFullUpload &&
        canBootstrapDeltaBaseline &&
        !existingCacheEntry?.uploadedFp &&
        !existingCacheEntry?.observationInvalidated &&
        existingCacheEntry?.modifiedAt === meta.modifiedAtFile &&
        existingCacheEntry.quickHash === meta.quickHash &&
        existingCacheEntry.fullHash === meta.fullHash
      ) {
        stampUploaded(hashCache, [meta]);
        result.skippedUnchanged++;
        result.baselinedCount++;
        return;
      }

      // Delta sync: the backend already has this exact metadata — skip the
      // upload entirely. This is the change that turns an hourly cycle over an
      // unchanged catalog into ~zero Convex traffic.
      if (!options.forceFullUpload && hashCache[cacheKeyFor(meta)]?.uploadedFp === metadataFingerprint(meta)) {
        result.skippedUnchanged++;
        return;
      }

      // This is a modern observation awaiting a server acknowledgement, not
      // an old 1.0 cache baseline. Keep it retryable if this batch fails or a
      // later batch persists the cache before the scan is interrupted.
      const pendingEntry = hashCache[cacheKeyFor(meta)];
      delete pendingEntry.uploadedFp;
      pendingEntry.observationInvalidated = true;
      fileBatch.push(meta);
      if (fileBatch.length >= 100) await flushBatch();
    } catch (err: any) {
      result.errorsCount++;
      console.warn(`[Scan Error] ${filePath}: ${err.message}`);
    }
  };

  await walkFiles(
    scanDir,
    async (filePath, statObj) => {
      if (activeTasks >= HASH_CONCURRENCY) {
        await new Promise<void>((resolve) => slotWaiters.push(resolve));
      }
      activeTasks++;
      const task = processFile(filePath, statObj).finally(() => {
        activeTasks--;
        inFlight.delete(task);
        const next = slotWaiters.shift();
        if (next) next();
      });
      inFlight.add(task);
    },
    minBytes,
    maxBytes
  );

  await Promise.all([...inFlight]);
  await flushBatch(true);
  saveHashCache(hashCache);
  // A rate-limited upload is incomplete even when it is not counted as a file
  // error. Preserve that outcome through jobs, one-shot commands and cycles.
  result.partial = uploadStopped || result.errorsCount > 0;
  await syncToConvex("completeScan", {
    sessionId,
    status: result.partial ? "partial" : "completed",
    errorsCount: result.errorsCount,
    // True walk totals: with delta sync the per-batch progress counts only
    // changed files, so the session record gets the real numbers here.
    filesSeen: result.fileCount,
    bytesSeen: result.byteCount,
  });

  console.log(`[Scan ${result.partial ? "Partial" : "Complete"}] ${scanDir} — ${result.fileCount} file(s) seen (${result.uploadedCount} uploaded, ${result.skippedUnchanged} unchanged, ${result.baselinedCount} baselined from agent 1.0 cache), ${(result.byteCount / 1024 ** 4).toFixed(2)} TB, errors: ${result.errorsCount}, deferred: ${result.skippedUnstable}`);
  return result;
}

// One sync cycle over every configured scan root. Respects the persisted pause
// flag and records last-run stats so `status` and restart recovery are accurate.
async function runSyncCycle(config: DriveOSConfig, options: ScanOptions = {}): Promise<ScanResult | null> {
  if (loadState().paused) {
    console.log("[Sync] Agent is paused — skipping this cycle. Run `driveos-agent resume` to continue.");
    return null;
  }

  const roots = config.scanRoots.filter(Boolean);
  if (roots.length === 0) {
    console.log("[Sync] No folders are being tracked yet. Add a drive or folder to start scanning.");
    return null;
  }

  // Refuse to run alongside another scan (daemon vs. manual scan-now). Two
  // concurrent scans clobber each other's hash-cache stamps and never converge.
  if (!await acquireScanLock()) {
    console.log("[Sync] Another scan is already running — skipping this cycle to avoid duplicate work.");
    return null;
  }

  try {
    return await runSyncCycleLocked(config, options, roots);
  } finally {
    await releaseScanLock();
  }
}

async function runSyncCycleLocked(config: DriveOSConfig, options: ScanOptions, roots: string[]): Promise<ScanResult> {
  saveState({ lastSyncStartedAt: new Date().toISOString() });
  const totals: ScanResult = {
    partial: false,
    fileCount: 0,
    byteCount: 0,
    errorsCount: 0,
    skippedUnstable: 0,
    uploadedCount: 0,
    skippedUnchanged: 0,
    baselinedCount: 0,
  };

  // Full-catalog uploads are manual only. Even a no-op server mutation must
  // read each existing document, so an automatic weekly "self-heal" would
  // reintroduce a predictable bandwidth spike.
  const forceFullUpload = Boolean(options.forceFullUpload);
  if (forceFullUpload) {
    console.log("[Sync] Manual full upload cycle: re-sending all file metadata (--force-full).");
  }

  // One shared hash cache for the whole cycle: every volume reads and writes the
  // same in-memory object, so a mid-scan save by one volume can't corrupt what
  // the next volume loads from disk.
  const sharedHashCache = loadHashCache();

  // Progressive scan: pass 1 covers big media (the bulk of duplicate bytes) on
  // every root so duplicates surface on the dashboard within minutes; pass 2
  // re-walks for the remaining small files, so nothing is ever skipped. Each
  // pass completion triggers backend analysis, so results refresh after both.
  const PROGRESSIVE_THRESHOLD = 50 * ONE_MB;
  const passes = config.minFileSizeBytes < PROGRESSIVE_THRESHOLD
    ? [
        { passLabel: "pass 1/2: large media", minFileSizeBytes: PROGRESSIVE_THRESHOLD, maxFileSizeBytes: Infinity },
        { passLabel: "pass 2/2: remaining files", minFileSizeBytes: config.minFileSizeBytes, maxFileSizeBytes: PROGRESSIVE_THRESHOLD },
      ]
    : [{ passLabel: undefined, minFileSizeBytes: config.minFileSizeBytes, maxFileSizeBytes: Infinity }];

  for (const pass of passes) {
    for (const root of roots) {
      // Roots must be absolute. A relative root can't be resolved reliably from a
      // packaged app (cwd is the app folder, not the project), so flag it clearly.
      if (!path.isAbsolute(root)) {
        console.warn(`[Sync] Ignoring folder "${root}" — please re-add it as a full path via Add drive.`);
        continue;
      }
      const resolved = path.resolve(root);
      if (!fs.existsSync(resolved)) {
        // Disconnected drive / missing root: skip safely, keep last-known catalog in Convex.
        console.warn(`[Sync] Folder not found right now (skipped, last catalog kept): ${resolved}`);
        continue;
      }
      try {
        const res = await performScan(resolved, config, { ...options, checkStability: true, sharedHashCache, ...pass, forceFullUpload });
        totals.partial ||= res.partial;
        totals.fileCount += res.fileCount;
        totals.byteCount += res.byteCount;
        totals.errorsCount += res.errorsCount;
        totals.skippedUnstable += res.skippedUnstable;
        totals.uploadedCount += res.uploadedCount;
        totals.skippedUnchanged += res.skippedUnchanged;
        totals.baselinedCount += res.baselinedCount;
      } catch (err: any) {
        console.error(`[Sync] Scan of ${resolved} failed: ${err.message}`);
        totals.partial = true;
        totals.errorsCount++;
      }
    }
  }

  saveState({
    // Keep the successful timestamp and its matching totals together when
    // only part of the catalog synced. Attempt details are reported below.
    ...(!totals.partial ? {
      lastSyncCompletedAt: new Date().toISOString(),
      lastSyncFiles: totals.fileCount,
      lastSyncBytes: totals.byteCount,
    } : {}),
    lastSyncStatus: totals.partial ? "partial" : "completed",
    lastSyncErrors: totals.errorsCount,
  });
  console.log(`[Sync Cycle ${totals.partial ? "Partial" : "Complete"}] ${totals.fileCount} file(s) across ${roots.length} root(s), ${(totals.byteCount / 1024 ** 4).toFixed(2)} TB — ${totals.uploadedCount} uploaded, ${totals.skippedUnchanged} unchanged (skipped), ${totals.baselinedCount} upgrade-baselined, errors: ${totals.errorsCount}.`);
  return totals;
}

const program = new Command();

program
  .name("driveos-agent")
  .description("Storage Command Center CLI Agent for local computers and mounted drives")
  .version(AGENT_VERSION);

program
  .command("init")
  .description("Initialize agent configuration and setup local roots")
  .option("-m, --machine <name>", "Machine workstation name", DEFAULT_CONFIG.machineName)
  .option("-o, --owner <ownerId>", "Owner / Lead Editor ID", DEFAULT_CONFIG.ownerId)
  .option("-c, --convex <url>", "Convex deployment URL (.convex.cloud or .convex.site)", DEFAULT_CONFIG.convexUrl)
  .option("-l, --location <location>", "Physical location of this machine (e.g. \"Manila Office\")")
  .option("-q, --quarantine <path>", "Fallback quarantine folder (used only with --central-quarantine)", DEFAULT_CONFIG.quarantineRoot)
  .option("--central-quarantine", "Quarantine all drives into one folder instead of per-volume (per-volume is default and required for external drives)")
  .option("-r, --roots <paths>", "Comma-separated default scan roots")
  .option("--auth-token <token>", "Optional bearer token for Convex HTTP endpoints")
  .option("--min-size-mb <mb>", "Minimum file size to scan", "1")
  .option("--full-hash", "Calculate streaming SHA-256 hashes during scans")
  .option("--allow-cloud-root", "Allow cloud-synced folders as scan roots with metadata-only warnings")
  .action((options) => {
    // Store roots as absolute paths so they resolve correctly even when the agent
    // runs from inside a packaged desktop app (where cwd is the app folder).
    const scanRoots = options.roots
      ? String(options.roots).split(",").map((root) => root.trim()).filter(Boolean).map((root) => path.resolve(root))
      : DEFAULT_CONFIG.scanRoots;

    const config: DriveOSConfig = {
      machineName: options.machine,
      ownerId: options.owner,
      convexUrl: options.convex,
      authToken: options.authToken,
      location: options.location,
      quarantineRoot: options.quarantine,
      quarantineOnSourceVolume: !options.centralQuarantine,
      scanRoots,
      minFileSizeBytes: Math.max(0, Number(options.minSizeMb) * ONE_MB),
      fullHash: Boolean(options.fullHash),
    };

    enforceLocalStatePath("Agent data directory", AGENT_HOME);
    enforceLocalStatePath("Quarantine root", config.quarantineRoot);
    for (const root of config.scanRoots) enforceTrackableRoot("Scan root", root, Boolean(options.allowCloudRoot));

    saveConfig(config);
    fs.mkdirSync(config.quarantineRoot, { recursive: true });
    for (const root of config.scanRoots) {
      if (!fs.existsSync(root)) console.warn(`[Config Warning] Scan root does not exist yet: ${path.resolve(root)}`);
    }

    console.log(`[Success] DriveOS Agent configured in ${CONFIG_PATH}`);
    console.log({
      ...config,
      authToken: config.authToken ? "[set]" : undefined,
      appDataDir: AGENT_HOME,
      hashCachePath: HASH_CACHE_PATH,
    });
  });

program
  .command("connect")
  .description("Connect this machine to DriveOS: store backend URL + machine token (from the dashboard)")
  .requiredOption("--token <token>", "Per-machine token issued by the DriveOS dashboard")
  .requiredOption("--machine <name>", "Machine name this token was issued for")
  .option("-c, --convex <url>", "Convex deployment URL (.convex.cloud or .convex.site)", DEFAULT_CONVEX_URL)
  .option("-o, --owner <ownerId>", "Owner / Lead Editor ID")
  .option("-l, --location <location>", "Physical location of this machine (e.g. \"Manila Office\")")
  .action(async (options) => {
    const config = loadConfig();
    const next: DriveOSConfig = {
      ...config,
      convexUrl: options.convex || config.convexUrl,
      machineName: options.machine,
      authToken: String(options.token).trim(),
      ownerId: options.owner || config.ownerId,
      location: options.location || config.location,
    };
    enforceLocalStatePath("Agent data directory", AGENT_HOME);

    // Verify the token with a direct authenticated call so we can distinguish a
    // rejected token (401) from a real network outage before saving.
    const baseUrl = resolveConvexHttpUrl(next.convexUrl);
    try {
      const { response: res } = await postBackendJson(`${baseUrl}/api/registerMachine`, {
        name: next.machineName,
        ownerId: next.ownerId,
        agentVersion: AGENT_VERSION,
        platform: process.platform,
        location: next.location,
      }, next.authToken, { timeoutMs: 30_000, discardBody: true });
      if (res.status === 401) {
        console.error("[Connect] Token rejected (401). Re-issue a token in the dashboard for this machine and try again.");
        process.exitCode = 1;
        return;
      }
      if (!res.ok) {
        console.error(`[Connect] Backend error ${res.status}. Saved nothing.`);
        process.exitCode = 1;
        return;
      }
      saveConfig(next);
      console.log(`[Connect] Connected as "${next.machineName}". Backend: ${next.convexUrl}`);
      console.log("[Connect] Token stored in the app-data config. You can now run `driveos-agent scan-now` or `sync`.");
    } catch (err: any) {
      if (err instanceof BackendRedirectError) {
        console.error(`[Connect] ${err.message} Saved nothing.`);
        process.exitCode = 1;
        return;
      }
      // Network failure: save anyway so the agent works once back online.
      saveConfig(next);
      console.warn(`[Connect] Saved credentials, but could not reach the backend (${err.message}). It will sync when online.`);
    }
  });

program
  .command("install-drive")
  .description("Install DriveOS scan/watch hooks into a mounted drive root")
  .requiredOption("-p, --path <dir>", "Mounted drive or folder root")
  .option("-n, --name <label>", "Drive label")
  .option("--allow-cloud-root", "Allow hook metadata inside a cloud-synced folder")
  .action((options) => {
    const root = path.resolve(options.path);
    if (!fs.existsSync(root)) {
      console.error(`[Error] Target path does not exist: ${root}`);
      process.exit(1);
    }
    enforceTrackableRoot("Drive hook target", root, Boolean(options.allowCloudRoot));

    const hookDir = path.join(root, ".driveos");
    fs.mkdirSync(hookDir, { recursive: true });

    const config = loadConfig();
    const driveConfig = {
      label: options.name || path.basename(root),
      rootPath: root,
      installedAt: new Date().toISOString(),
      machineName: config.machineName,
      quarantineRoot: path.resolve(config.quarantineRoot),
      scanCommand: `driveos-agent scan --path "${root}"`,
      watchCommand: `driveos-agent watch --path "${root}"`,
    };

    fs.writeFileSync(path.join(hookDir, "driveos-drive.json"), JSON.stringify(driveConfig, null, 2), "utf-8");
    fs.writeFileSync(path.join(hookDir, "scan.sh"), `#!/usr/bin/env bash\ndriveos-agent scan --path "${root}"\n`, "utf-8");
    fs.writeFileSync(path.join(hookDir, "watch.sh"), `#!/usr/bin/env bash\ndriveos-agent watch --path "${root}"\n`, "utf-8");
    fs.chmodSync(path.join(hookDir, "scan.sh"), 0o755);
    fs.chmodSync(path.join(hookDir, "watch.sh"), 0o755);

    // Register the folder so the scheduled `sync` actually scans it. Normalize
    // every root to an absolute path (dropping any stale relative entries) and
    // dedupe, so the desktop "Add drive" reliably starts tracking the folder.
    const existing = config.scanRoots.map((r) => path.resolve(r));
    const merged = Array.from(new Set([...existing, root]));
    config.scanRoots = merged;
    saveConfig(config);
    console.log(`[Success] Now tracking ${root} for hourly sync.`);

    console.log(`[Success] Installed DriveOS hooks in ${hookDir}`);
  });

program
  .command("forget-drive")
  .description("Stop tracking a drive/folder: drop it from scan roots and remove its DriveOS catalog (files on disk are untouched)")
  .requiredOption("-p, --path <dir>", "Tracked drive or folder root to forget")
  .action(async (options) => {
    const root = path.resolve(options.path);
    const config = loadConfig();

    // Drop from scan roots so the scheduler stops re-adding/re-scanning it.
    const before = config.scanRoots.length;
    config.scanRoots = config.scanRoots.filter((r) => path.resolve(r) !== root);
    const dropped = before - config.scanRoots.length;
    saveConfig(config);
    if (dropped > 0) console.log(`[Forget Drive] Removed ${root} from scan roots.`);
    else console.warn(`[Forget Drive] ${root} was not in scan roots (removing catalog anyway).`);

    // Remove the catalog from the backend, matched by the same volumeId
    // performScan registers the drive with. Local untrack already succeeded, so
    // an offline backend is a soft warning rather than a failure.
    const res = await syncToConvex("removeDrive", {
      volumeId: `${process.platform}:${root}`,
      machineId: config.machineName,
    });
    if ((res as any).offline) {
      console.warn("[Forget Drive] Untracked locally, but the backend was offline. The catalog will clear on the next successful sync or when you remove it from the dashboard.");
    } else if ((res as any).removed) {
      console.log(`[Success] Stopped tracking ${root}. Removed ${(res as any).filesRemoved ?? 0} file record(s) from DriveOS. Files on disk are untouched.`);
    } else {
      console.log(`[Success] Stopped tracking ${root} locally. No catalog existed in the backend for it.`);
    }
  });

program
  .command("scan")
  .description("Recursively scan directory metadata and upload to Convex (one-shot)")
  .requiredOption("-p, --path <dir>", "Directory path to scan")
  .option("--full-hash", "Calculate streaming SHA-256 full hashes for this scan")
  .option("--allow-cloud-root", "Allow scanning a cloud-synced folder as metadata-only")
  .option("--check-stability", "Skip files that are still being written")
  .option("--force-full", "Re-upload all metadata even if unchanged since the last sync")
  .action(async (options) => {
    const scanDir = path.resolve(options.path);
    if (!fs.existsSync(scanDir)) {
      console.error(`[Error] Target path does not exist: ${scanDir}`);
      process.exit(1);
    }
    const config = loadConfig();
    if (!await acquireScanLock()) throw new Error(scanLock.lastFailure || "Another scan is already running.");
    try {
      const result = await performScan(scanDir, config, {
        fullHash: Boolean(options.fullHash),
        allowCloudRoot: Boolean(options.allowCloudRoot),
        checkStability: Boolean(options.checkStability),
        forceFullUpload: Boolean(options.forceFull),
      });
      if (result.partial) process.exitCode = 1;
    } finally { await releaseScanLock(); }
  });

program
  .command("sync")
  .description("Scheduled, batched sync: scan all configured roots once per interval (default hourly)")
  .option("--interval-minutes <minutes>", "Minutes between sync cycles", "60")
  .option("--once", "Run a single sync cycle and exit (no scheduling)")
  .option("--full-hash", "Calculate streaming SHA-256 full hashes during scans")
  .option("--allow-cloud-root", "Allow cloud-synced roots as metadata-only")
  .option("--force-full", "Re-upload all metadata even if unchanged since the last sync")
  .action(async (options) => {
    const config = loadConfig();
    validateRuntimeConfig(config);
    const scanOpts: ScanOptions = {
      fullHash: Boolean(options.fullHash),
      allowCloudRoot: Boolean(options.allowCloudRoot),
      forceFullUpload: Boolean(options.forceFull),
    };
    const intervalMs = Math.max(1, Number(options.intervalMinutes) || 60) * 60 * 1000;

    // Always run an immediate catch-up cycle on start (unless paused), then pick
    // up any jobs approved in the dashboard.
    const firstScan = await runSyncCycle(config, scanOpts);
    // --force-full applies to the first cycle only; scheduled cycles fall back
    // to delta sync.
    scanOpts.forceFullUpload = false;
    await runPendingJobs(config);
    if (options.once) {
      if (firstScan?.partial) process.exitCode = 1;
      return;
    }

    console.log(`[Scheduler Started] Next sync in ${Math.round(intervalMs / 60000)} minute(s). Convex receives one batched update per cycle — no constant streaming.`);

    // Adaptive scan scheduler. A fixed hourly setInterval kept re-scanning a
    // quiet drive 24 rounds/day on a PC left on — each round re-reads the
    // catalog to compute the delta, and a lost hash cache turns that into a
    // full re-upload. Mirroring the job poller below: when a cycle uploads
    // nothing, back the interval off (base → up to SCAN_MAX_MS); a cycle that
    // actually changed something resets to base. A hard daily ceiling caps the
    // number of cycles so even a broken delta cache can't loop unbounded — the
    // backend's per-tenant daily upload budget is the final backstop, but this
    // stops us from wastefully hammering it up to that limit.
    const SCAN_BASE_MS = intervalMs;
    const SCAN_MAX_MS = Math.max(intervalMs, 6 * 60 * 60 * 1000); // cap idle backoff at 6h
    const SCAN_MAX_CYCLES_PER_DAY = Math.max(24, Math.ceil((24 * 60 * 60 * 1000) / intervalMs));
    let scanDelay = SCAN_BASE_MS;
    let cyclesToday = 0;
    let dayWindowStart = 0; // ms epoch of the current 24h counting window; set on first tick
    let syncTimer: NodeJS.Timeout;

    const scheduleScan = (delay: number) => {
      syncTimer = setTimeout(async () => {
        // Roll the 24h counting window and enforce the ceiling BEFORE running a
        // cycle. If capped, reschedule for the remainder of the window and skip
        // the cycle entirely (single reschedule — no try/finally double-arm).
        const now = Date.now();
        if (dayWindowStart === 0 || now - dayWindowStart >= 24 * 60 * 60 * 1000) {
          dayWindowStart = now;
          cyclesToday = 0;
        }
        if (cyclesToday >= SCAN_MAX_CYCLES_PER_DAY) {
          const waitMs = Math.max(60_000, 24 * 60 * 60 * 1000 - (now - dayWindowStart));
          console.warn(`[Scan Ceiling] Hit ${SCAN_MAX_CYCLES_PER_DAY} sync cycles in 24h — pausing scans for ${Math.round(waitMs / 60000)} min to protect the daily budget.`);
          scheduleScan(waitMs);
          return;
        }
        cyclesToday++;

        try {
          // Add/remove drive actions run in separate CLI processes. Reload roots
          // each cycle so the resident scheduler immediately honors that config.
          const res = await runSyncCycle(loadConfig(), scanOpts);
          // Back off both idle and incomplete cycles. A rejected upload must
          // not look idle or cause minute-by-minute retries of a limited API.
          const quiet = res != null && !res.partial && res.uploadedCount === 0;
          scanDelay = quiet || res?.partial ? Math.min(scanDelay * 2, SCAN_MAX_MS) : SCAN_BASE_MS;
          if (res?.partial) console.log(`[Scan Retry] Cycle incomplete — retrying in ${Math.round(scanDelay / 60000)} min.`);
          if (quiet) console.log(`[Scan Idle] No changes this cycle — next scan in ${Math.round(scanDelay / 60000)} min.`);
        } catch (err: any) {
          console.error(`[Scan Cycle Error] ${err.message}`);
          scanDelay = Math.min(scanDelay * 2, SCAN_MAX_MS);
        } finally {
          scheduleScan(scanDelay);
        }
      }, delay);
    };
    scheduleScan(scanDelay);

    // Adaptive job poller. A fixed 60s timer against a metered backend was a real
    // cost leak: an idle agent left running for a week made ~40k pointless calls
    // (verifyMachineToken + rate-limit + a table read every minute). Now the
    // interval backs off when nothing is queued (60s → up to 30min) and resets
    // to fast only when a job actually runs. A 429 pauses polling for its
    // Retry-After, so we never hammer a backend that already said "stop".
    const JOB_POLL_MIN_MS = 60 * 1000;
    const JOB_POLL_MAX_MS = 30 * 60 * 1000;
    let jobPollDelay = JOB_POLL_MIN_MS;
    let jobsTimer: NodeJS.Timeout;

    const scheduleJobPoll = (delay: number) => {
      jobsTimer = setTimeout(async () => {
        try {
          const executed = await runPendingJobs(loadConfig());
          // Work found → poll fast again; idle → back off, capped.
          jobPollDelay = executed > 0 ? JOB_POLL_MIN_MS : Math.min(jobPollDelay * 2, JOB_POLL_MAX_MS);
        } catch (err: any) {
          if (err instanceof RateLimitedError) {
            jobPollDelay = Math.max(err.retryAfterSeconds * 1000, JOB_POLL_MAX_MS);
            console.warn(`[Agent Queue] Rate limited — pausing job polling for ${Math.round(jobPollDelay / 60000)} min.`);
          } else {
            jobPollDelay = Math.min(jobPollDelay * 2, JOB_POLL_MAX_MS);
            console.error(`[Agent Queue] Poll failed: ${err.message}`);
          }
        } finally {
          scheduleJobPoll(jobPollDelay);
        }
      }, delay);
    };
    scheduleJobPoll(jobPollDelay);

    const shutdown = () => { clearTimeout(syncTimer); clearTimeout(jobsTimer); console.log("\n[Scheduler Stopped]"); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("scan-now")
  .description("Flush a sync cycle immediately across all configured roots (ignores schedule, respects pause)")
  .option("--full-hash", "Calculate streaming SHA-256 full hashes for this scan")
  .option("--allow-cloud-root", "Allow cloud-synced roots as metadata-only")
  .option("--force-full", "Re-upload all metadata even if unchanged since the last sync")
  .action(async (options) => {
    const config = loadConfig();
    validateRuntimeConfig(config);
    const res = await runSyncCycle(config, {
      fullHash: Boolean(options.fullHash),
      allowCloudRoot: Boolean(options.allowCloudRoot),
      forceFullUpload: Boolean(options.forceFull),
    });
    process.exitCode = res?.partial ? 1 : 0;
  });

program
  .command("pause")
  .description("Pause scheduled syncs (persists across restart)")
  .action(() => {
    const state = saveState({ paused: true, pausedAt: new Date().toISOString() });
    console.log(`[Paused] Scheduled syncs are paused since ${state.pausedAt}. A running scheduler will skip cycles until you resume.`);
  });

program
  .command("resume")
  .description("Resume scheduled syncs")
  .action(() => {
    saveState({ paused: false, pausedAt: undefined });
    console.log("[Resumed] Scheduled syncs will run on the next cycle. Run `driveos-agent scan-now` to sync immediately.");
  });

program
  .command("status")
  .description("Show agent scheduler state (paused/running, last sync)")
  .option("--json", "Emit machine-readable JSON (used by the desktop tray app)")
  .action((options) => {
    const state = loadState();
    const config = loadConfig();
    const status = {
      connected: Boolean(config.authToken),
      machineName: config.machineName,
      convexUrl: config.convexUrl,
      paused: state.paused,
      pausedAt: state.pausedAt,
      scanRoots: config.scanRoots,
      lastSyncStartedAt: state.lastSyncStartedAt,
      lastSyncCompletedAt: state.lastSyncCompletedAt,
      lastSyncStatus: state.lastSyncStatus,
      lastSyncErrors: state.lastSyncErrors,
      lastSyncFiles: state.lastSyncFiles,
      lastSyncTB: state.lastSyncBytes ? (state.lastSyncBytes / 1024 ** 4).toFixed(2) : undefined,
      appDataDir: AGENT_HOME,
    };
    if (options.json) {
      // Single clean JSON line so the tray app can parse stdout reliably.
      process.stdout.write(JSON.stringify(status) + "\n");
    } else {
      console.log(status);
    }
  });

program
  .command("watch")
  .description("Queue watched folder changes and upload metadata in safe batches (never per-event)")
  .requiredOption("-p, --path <dir>", "Directory path to watch")
  .option("--interval-minutes <minutes>", "Batch upload interval; defaults to hourly", "60")
  .option("--debounce-seconds <seconds>", "Wait for files to settle before queueing metadata", "8")
  .option("--allow-cloud-root", "Allow watching a cloud-synced folder as metadata-only")
  .action(async (options) => {
    const watchDir = path.resolve(options.path);
    const config = loadConfig();
    validateRuntimeConfig(config);
    const hashCache = loadHashCache();
    const pending = new Map<string, NodeJS.Timeout>();
    const intervalMs = Math.max(1, Number(options.intervalMinutes) || 60) * 60 * 1000;
    const debounceMs = Math.max(1, Number(options.debounceSeconds) || 8) * 1000;

    if (!fs.existsSync(watchDir)) {
      console.error(`[Error] Target path does not exist: ${watchDir}`);
      process.exit(1);
    }
    enforceTrackableRoot("Watch target", watchDir, Boolean(options.allowCloudRoot));

    // Resolve the same catalog root/drive identity used by scheduled scans.
    // The old watcher omitted driveId and used a fake scanSessionId, which made
    // watched files distinct from the same paths uploaded by the scanner.
    const containingRoots = config.scanRoots
      .map((root) => path.resolve(root))
      .filter((root) => {
        const relative = path.relative(root, watchDir);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      })
      .sort((a, b) => b.length - a.length);
    const catalogRoot = containingRoots[0] || watchDir;
    const rootGuard = new WatchRootGuard([watchDir, catalogRoot]);
    const uploaded = new Map<string, CatalogSnapshot>();
    const cacheKeys = new Map<string, Set<string>>();
    const parentIdentityFor = cachedParentIdentities();
    const cloudProvider = cloudSyncProvider(catalogRoot);
    const machineRes = await syncToConvex("registerMachine", {
      name: config.machineName,
      ownerId: config.ownerId,
      agentVersion: AGENT_VERSION,
      platform: process.platform,
      location: config.location,
    });
    const machineId = machineRes.machineId;
    const driveMetrics = getDriveMetrics(catalogRoot);
    const driveRes = await syncToConvex("registerDrive", {
      label: path.basename(catalogRoot),
      volumeId: `${process.platform}:${catalogRoot}`,
      machineId,
      ownerId: config.ownerId,
      ...driveMetrics,
      filesystem: cloudProvider ? "cloud" : driveMetrics.filesystem,
      mountPath: catalogRoot,
      tier: cloudProvider ? "cloud" : "hot",
    });
    const driveId = driveRes.driveId;
    const catalogScope = { driveId, machineId };
    const queue = new WatchQueue<FileMetadata>(catalogScope);
    const unresolved = new UnresolvedRemovals();

    function indexCatalogCache(cache: Record<string, HashCacheEntry>, selected?: Set<string>) {
      for (const [key, entry] of Object.entries(cache)) {
        const filePath = key.slice(0, -(String(entry.sizeBytes).length + 1));
        if (selected && !selected.has(filePath)) continue;
        const relative = path.relative(watchDir, filePath);
        if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) continue;
        if (!cacheKeys.has(filePath)) cacheKeys.set(filePath, new Set());
        cacheKeys.get(filePath)!.add(key);
        const cached = catalogSnapshotFromCache(filePath, entry);
        if (!cached) continue;
        const snapshot = selectCatalogSnapshot(uploaded.get(filePath), {
          ...cached, parent: parentIdentityFor(filePath, cached.parent),
        }, catalogScope);
        uploaded.set(filePath, snapshot);
      }
    }
    indexCatalogCache(hashCache);

    if (driveRes.isNew) {
      const rootPrefix = catalogRoot.endsWith(path.sep) ? catalogRoot : catalogRoot + path.sep;
      for (const key of Object.keys(hashCache)) {
        if (key.startsWith(rootPrefix)) delete hashCache[key].uploadedFp;
      }
    }

    function clearUploadStamps(cache: Record<string, HashCacheEntry>) {
      for (const [key, entry] of Object.entries(cache)) {
        const filePath = key.slice(0, -(String(entry.sizeBytes).length + 1));
        if (queue.invalidated.has(filePath)) { delete entry.uploadedFp; entry.observationInvalidated = true; }
      }
    }

    function clearPathUploadStamp(filePath: string) {
      for (const key of cacheKeys.get(filePath) || []) {
        if (hashCache[key]) { delete hashCache[key].uploadedFp; hashCache[key].observationInvalidated = true; }
      }
    }

    let ignoredRemovals = 0;
    function removed(filePath: string) {
      const timer = pending.get(filePath);
      if (timer) clearTimeout(timer);
      pending.delete(filePath);
      const snapshot = uploaded.get(filePath);
      let parent = snapshot?.parent;
      if (snapshot && !parent) { try { parent = directoryIdentity(path.dirname(filePath)); } catch { /* Hold until physical availability can be proven. */ } }
      const queued = queue.deleted(filePath, snapshot?.receipt, parent, snapshot?.fingerprint);
      // Preserve the successful fingerprint/receipt for deletion CAS, but make
      // an identical recreation upload again instead of trusting that stamp.
      clearPathUploadStamp(filePath);
      if (!queued) {
        unresolved.removed(filePath);
        if (unresolved.size >= 500) void processQueue();
        return;
      }
      unresolved.cancel(filePath);
      console.log(`[Watcher File Removed] Queued catalog reconciliation: ${filePath}`);
    }

    let flushing: Promise<void> | undefined;
    let retryAfter = 0;
    function processQueue(): Promise<void> {
      if (flushing) return flushing;
      flushing = flushQueue().catch(error => {
        console.warn(`[Watcher Sync] Queue remains held after local failure: ${error.message}`);
      }).finally(() => { flushing = undefined; });
      return flushing;
    }

    async function flushQueue() {
      if ((!queue.size && !unresolved.size) || Date.now() < retryAfter) return;
      if (loadState().paused) {
        console.log(`[Watcher Paused] Holding ${queue.size} queued change(s) until resume.`);
        return;
      }
      if (!rootGuard.available()) {
        console.warn("[Watcher Safety] Watched root is unavailable or its physical identity changed; holding catalog changes.");
        return;
      }
      // An outage or a file that was still being written may have prevented
      // the debounce callback from hashing it. Retry preparation on the next
      // interval, without needing another filesystem event.
      await Promise.all(queue.unpreparedChanges().map(entry => enqueue(entry.path, entry.generation)));
      if (!await acquireScanLock()) return;
      let persistedCache: Record<string, HashCacheEntry> | undefined;
      try {
        persistedCache = loadHashCache();
        const unknown = unresolved.snapshot();
        const relevant = new Set([...unknown.map(entry => entry.path), ...queue.deletions().map(entry => entry.path)]);
        indexCatalogCache(persistedCache, relevant);
        for (let start = 0; start < unknown.length; start += 500) {
          for (const entry of unknown.slice(start, start + 500)) {
            if (!unresolved.consume(entry)) continue;
            const snapshot = uploaded.get(entry.path);
            if (snapshot && queue.deleted(entry.path, snapshot.receipt, snapshot.parent, snapshot.fingerprint)) {
              clearPathUploadStamp(entry.path);
            } else {
              for (const key of cacheKeys.get(entry.path) || []) {
                if (!hashCache[key]?.catalogReceipt && !hashCache[key]?.uploadedFp) delete hashCache[key];
              }
              cacheKeys.delete(entry.path);
              ignoredRemovals++;
            }
          }
          await yieldToIO();
        }
        if (ignoredRemovals) console.log(`[Watcher Removed] ${ignoredRemovals} removal(s) had no uploaded catalog fingerprint after refreshing the scan cache.`);
        // Unknown tiny-file churn drains locally and never opens scan sessions
        // or sends receipt requests when the fresh cache proves nothing uploaded.
        if (!queue.size) { persistedCache = undefined; return; }
        clearUploadStamps(hashCache);
        clearUploadStamps(persistedCache);
        const batch = queue.changes();
        const deletions = queue.deletions();
        for (const deletion of deletions) {
          const snapshot = uploaded.get(deletion.path);
          if (snapshot) queue.refreshFromSnapshot(deletion, snapshot);
        }
        function assertCanSync() {
          if (loadState().paused) throw new Error("Watcher paused; queued changes remain held.");
          if (!rootGuard.available()) throw new Error("Watched root became unavailable or changed.");
        }
        assertCanSync();
        console.log(`[Watcher Batch] Flushing up to ${batch.length} file change(s) and ${deletions.length} removal(s) to Convex`);
        const scanRes = await syncToConvex("startScan", {
          machineId, driveId, rootPath: watchDir, agentVersion: AGENT_VERSION,
        });
        const sessionId = scanRes.sessionId;
        let partial = false;
        for (let i = 0; i < batch.length; i += 100) {
          assertCanSync();
          const slice = batch.slice(i, i + 100).filter(change => {
            if (!queue.isCurrent(change.path, change.generation)) return false;
            try {
              const current = fs.statSync(change.path);
              if (current.isFile() && current.size === change.metadata!.sizeBytes && current.mtimeMs === change.metadata!.modifiedAtFile) return true;
              schedule(change.path, change.forceObservation);
            } catch (error: any) { if (error.code === "ENOENT") removed(change.path); }
            return false;
          });
          if (!slice.length) continue;
          for (const change of slice) queue.beginUpload(change, change.metadata!);
          let result: any;
          try {
            result = await syncToConvex("uploadBatch", {
              scanSessionId: sessionId, machineId, driveId, catalogReceiptProtocol: 1,
              files: slice.map(change => ({ ...change.metadata!, ...(change.forceObservation ? { forceObservation: true } : {}) })),
            });
          } finally { for (const change of slice) queue.endUpload(change); }
          const receipts = new Map(catalogReceipts(result.receipts).filter(receipt => receiptMatchesScope(receipt, catalogScope)).map(receipt => [receipt.path, receipt]));
          for (const change of slice) {
            const meta = change.metadata!, receipt = receipts.get(change.path);
            if (!receipt || receipt.sizeBytes !== meta.sizeBytes || receipt.modifiedAtFile !== meta.modifiedAtFile ||
                receipt.quickHash !== meta.quickHash || (meta.fullHash && receipt.fullHash !== meta.fullHash)) {
              partial = true;
              continue;
            }
            const current = queue.isCurrent(change.path, change.generation);
            stampUploaded(hashCache, [meta], [receipt]);
            stampUploaded(persistedCache, [meta], [receipt]);
            hashCache[cacheKeyFor(meta)].catalogParent = change.parent;
            persistedCache[cacheKeyFor(meta)].catalogParent = change.parent;
            uploaded.set(change.path, { receipt, fingerprint: receipt, parent: change.parent });
            queue.uploaded(change, receipt, change.parent);
            if (!current) {
              delete hashCache[cacheKeyFor(meta)].uploadedFp;
              delete persistedCache[cacheKeyFor(meta)].uploadedFp;
              hashCache[cacheKeyFor(meta)].observationInvalidated = true;
              persistedCache[cacheKeyFor(meta)].observationInvalidated = true;
            }
          }
          if (partial) break; // Missing acknowledgements remain queued for retry.
        }

        for (let i = 0; i < deletions.length; i += 100) {
          assertCanSync();
          const candidates = deletions.slice(i, i + 100).filter(entry => {
            if (!queue.isCurrent(entry.path, entry.generation)) return false;
            if (rootGuard.fileMissing(entry.path, entry.parent)) return true;
            try { if (fs.statSync(entry.path).isFile()) schedule(entry.path, true); } catch { queue.defer(entry); }
            return false;
          });
          const legacy = candidates.filter(entry => !entry.receipt && entry.fingerprint);
          if (legacy.length) {
            assertCanSync();
            const result = await syncToConvex("getCatalogReceipts", {
              scanSessionId: sessionId, machineId, driveId, files: legacy.map(entry => entry.fingerprint),
            });
            queue.bootstrapReceipts(legacy, result.receipts, result.rejected);
            for (const entry of legacy) {
              if (entry.retiredReason) console.warn(`[Watcher Safety] Catalog fingerprint changed; removed event retired without deleting the newer row. Review/rescan: ${entry.path}`);
            }
          }
          // Recheck after the lookup/network wait. An unplugged volume or a
          // recreation during that wait must not become a catalog deletion.
          const ready = candidates.filter(entry => entry.receipt && queue.isCurrent(entry.path, entry.generation) && rootGuard.fileMissing(entry.path, entry.parent));
          const readyPaths = new Set(ready.map(entry => entry.path));
          for (const entry of candidates) {
            if (!readyPaths.has(entry.path) && queue.isCurrent(entry.path, entry.generation)) {
              partial = true;
              try { if (fs.statSync(entry.path).isFile()) schedule(entry.path, true); } catch { queue.defer(entry); }
            }
            if (!entry.receipt && queue.isCurrent(entry.path, entry.generation)) {
              partial = true;
              queue.defer(entry);
              console.warn(`[Watcher Safety] No matching catalog receipt for removed path; holding for review/rescan: ${entry.path}`);
            }
          }
          if (!ready.length) continue;
          assertCanSync();
          const result = await syncToConvex("reportMissingFiles", {
            scanSessionId: sessionId, machineId, driveId, files: ready.map(entry => entry.receipt),
          });
          if (queue.deletionReceipts(ready, result.receipts) !== ready.length) partial = true;
          for (const entry of ready) {
            if (!entry.receipt && entry.conflictRefreshes && queue.isCurrent(entry.path, entry.generation)) {
              console.log(`[Watcher Conflict] Refreshing catalog receipt after newer observation: ${entry.path}`);
            }
            if (entry.retiredReason) console.warn(`[Watcher Safety] Catalog kept changing; removed event retired without another deletion. Review/rescan: ${entry.path}`);
          }
          // A reappearance may race the HTTP request before chokidar delivers
          // its add event. Force a fresh observation even for identical stats.
          for (const entry of ready) {
            try { if (fs.statSync(entry.path).isFile()) schedule(entry.path, true); } catch { /* Still absent. */ }
          }
        }
        clearUploadStamps(persistedCache);
        saveHashCache(persistedCache);
        await syncToConvex("completeScan", {
          sessionId, status: partial ? "partial" : "completed", errorsCount: partial ? 1 : 0,
          filesSeen: batch.length, bytesSeen: batch.reduce((total, entry) => total + entry.metadata!.sizeBytes, 0),
        });
      } catch (error: any) {
        if (error instanceof RateLimitedError) retryAfter = Date.now() + error.retryAfterSeconds * 1000;
        console.warn(`[Watcher Sync] Holding ${queue.size} change(s) for retry: ${error.message}`);
      } finally {
        try { if (persistedCache) { clearUploadStamps(persistedCache); saveHashCache(persistedCache); } }
        finally { await releaseScanLock(); }
      }
    }

    async function enqueue(filePath: string, generation: number) {
      try {
        if (!rootGuard.available() || !queue.isCurrent(filePath, generation)) return;
        if (!(await isFileStable(filePath))) {
          console.log(`[Watcher Stable Check] Skipping actively changing file until next event: ${filePath}`);
          return;
        }
        const statObj = fs.statSync(filePath);
        if (!statObj.isFile() || statObj.size < Math.max(config.minFileSizeBytes, MIN_CATALOG_FILE_SIZE_BYTES)) { queue.acknowledge({ path: filePath, generation }); return; }
        const parent = directoryIdentity(path.dirname(filePath));
        const key = `${filePath}-${statObj.size}`;
        // Hashing can outlive a later unlink/add or a second debounce callback.
        // Do not let obsolete asynchronous work overwrite the live cache.
        const localCache: Record<string, HashCacheEntry> = hashCache[key] ? { [key]: hashCache[key] } : {};
        const meta = await buildFileMetadata(filePath, statObj, localCache, config.fullHash);
        const after = fs.statSync(filePath);
        if (!queue.isCurrent(filePath, generation) || !rootGuard.available()) return;
        if (statObj.dev !== after.dev || statObj.ino !== after.ino || statObj.size !== after.size ||
            statObj.mtimeMs !== after.mtimeMs || statObj.ctimeMs !== after.ctimeMs) { schedule(filePath); return; }
        if (!queue.invalidated.has(filePath) && hashCache[cacheKeyFor(meta)]?.uploadedFp === metadataFingerprint(meta)) { queue.acknowledge({ path: filePath, generation }); return; }
        hashCache[key] = localCache[key];
        if (!cacheKeys.has(filePath)) cacheKeys.set(filePath, new Set());
        cacheKeys.get(filePath)!.add(key);
        queue.metadata(filePath, generation, meta, parent);
      } catch (err: any) {
        console.warn(`[Watcher Skip] ${filePath}: ${err.message}`);
      }
    }

    function schedule(filePath: string, forceObservation = false) {
      unresolved.cancel(filePath);
      const generation = queue.changed(filePath, forceObservation);
      if (forceObservation) clearPathUploadStamp(filePath);
      const existing = pending.get(filePath);
      if (existing) clearTimeout(existing);
      pending.set(filePath, setTimeout(() => {
        pending.delete(filePath);
        void enqueue(filePath, generation);
      }, debounceMs));
    }

    const interval = setInterval(() => void processQueue(), intervalMs);
    process.on("SIGINT", () => {
      clearInterval(interval);
      Promise.resolve(processQueue()).finally(() => process.exit(0));
    });
    process.on("SIGTERM", () => {
      clearInterval(interval);
      Promise.resolve(processQueue()).finally(() => process.exit(0));
    });

    console.log(`[Watcher Started] Watching ${watchDir}`);
    console.log(`[Watcher Started] Upload interval: ${Math.round(intervalMs / 60000)} minute(s); debounce: ${Math.round(debounceMs / 1000)} second(s)`);
    chokidar
      .watch(watchDir, {
        ignored: (candidate) => shouldIgnoreDirectory(path.basename(candidate)),
        persistent: true,
        ignoreInitial: true,
      })
      .on("add", filePath => schedule(filePath, true))
      .on("change", filePath => schedule(filePath))
      .on("unlink", removed);
  });

program
  .command("create-project")
  .description("Create automated folder tree structure and write project_manifest.json")
  .requiredOption("-i, --projectId <id>", "Project ID from backend")
  .requiredOption("-r, --root <dir>", "Root directory to build project")
  .option("--allow-cloud-root", "Allow creating project folders inside a cloud-synced root")
  .action(async (options) => {
    const root = path.resolve(options.root);
    enforceTrackableRoot("Project root", root, Boolean(options.allowCloudRoot));
    const config = loadConfig();
    validateRuntimeConfig(config);
    const projectRes = await syncToConvex("getProject", { projectId: options.projectId });
    const project = projectRes.project || {};
    const { manifest, manifestPath } = writeProjectStructure(root, project, options.projectId);
    const manifestJson = fs.readFileSync(manifestPath, "utf8");

    await syncToConvex("createManifest", {
      projectId: options.projectId,
      createdBy: project.ownerId || config.ownerId,
      fileCount: 1,
      totalBytes: Buffer.byteLength(manifestJson),
      manifestPath,
      checksum: crypto.createHash("sha256").update(manifestJson).digest("hex"),
    });

    console.log(`[Wizard Success] Created project folder structure at ${root}`);
    console.log(`[Wizard Success] Manifest: ${manifestPath}`);
  });

// Poll the backend once for approved jobs and execute them. Shared by the
// `run-jobs` CLI command and the background scheduler so a Quarantine approved
// in the web dashboard runs on its own — no manual command needed. Respects the
// pause flag and never throws: a failed job is marked failed and the rest run.
async function runPendingJobs(config: DriveOSConfig): Promise<number> {
  if (loadState().paused) return 0;
  const jobs = await syncToConvex("pollPendingJobs", { machineId: config.machineName, leaseProtocol: 1, keepCopyProtocol: 1 });
  if ((jobs as any).offline || !Array.isArray(jobs) || jobs.length === 0) return 0;

  let executed = 0;
  for (const job of jobs) {
    try {
      if (await executeJob(job, config)) executed++;
    } catch (err: any) {
      console.error(`[Agent Execution Error] Job ${job._id} failed: ${err.message}`);
    }
  }
  return executed;
}

program
  .command("run-jobs")
  .description("Poll Convex backend for pending cleanup and folder-creation actions and execute them")
  .action(async () => {
    const config = loadConfig();
    validateRuntimeConfig(config);
    console.log(`[Agent Queue] Polling pending actions for machine "${config.machineName}"`);
    const executed = await runPendingJobs(config);
    if (executed === 0) console.log("[Agent Queue] No pending approved jobs. Queue is idle.");
    else console.log(`[Agent Queue] Executed ${executed} job(s).`);
  });

program
  .command("quarantine")
  .description("Execute an approved quarantine job immediately")
  .requiredOption("-j, --jobId <id>", "Cleanup job ID")
  .action(async (options) => {
    const config = loadConfig();
    validateRuntimeConfig(config);
    const res = await syncToConvex("getJob", { jobId: options.jobId, keepCopyProtocol: 1 });
    if (!res.job || res.offline) {
      console.error(`[Error] Job not found or Convex is offline: ${options.jobId}`);
      process.exit(1);
    }
    await executeJob(res.job, config);
  });

program
  .command("restore")
  .description("Restore a quarantined file to its original path")
  .requiredOption("-q, --quarantineId <id>", "Quarantine item ID")
  .action(async (options) => {
    const config = loadConfig();
    validateRuntimeConfig(config);
    const request = await syncToConvex("requestRestore", { quarantineId: options.quarantineId });
    const response = await syncToConvex("getJob", { jobId: request.jobId, keepCopyProtocol: 1 });
    if (!response.job) throw new Error("The restore job is unavailable on this machine.");
    await executeJob(response.job, config);
    const final = await syncToConvex("getJob", { jobId: request.jobId, keepCopyProtocol: 1 });
    if (final.job?.status === "failed") throw new Error(final.job.result?.error || "Restore failed; inspect the quarantined file before retrying.");
    if (final.job?.status !== "completed") throw new Error("The restore is still running in another agent. Retry after it finishes.");
  });

program
  .command("manifest")
  .description("Generate an archive manifest for a project root")
  .requiredOption("-i, --projectId <id>", "Project ID from backend")
  .option("-r, --root <dir>", "Project root path; defaults to backend project.rootPath")
  .option("--full-hash", "Compatibility option: archive manifests always include full SHA-256 checksums")
  .option("--allow-cloud-root", "Allow writing manifest inside a cloud-synced project root")
  .action(async (options) => {
    const config = loadConfig();
    validateRuntimeConfig(config);
    const root = options.root ? path.resolve(options.root) : undefined;
    const result = await generateArchiveManifest(options.projectId, root, false, undefined, Boolean(options.allowCloudRoot));
    console.log(`[Manifest Success] ${result.manifestPath}`);
    console.log(`[Manifest Success] ${result.fileCount} file(s), checksum ${result.checksum}`);
  });

void program.parseAsync(process.argv).catch((error: Error) => {
  console.error(`[Agent Error] ${error.message}`);
  process.exitCode = 1;
});
