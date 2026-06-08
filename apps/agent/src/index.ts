#!/usr/bin/env node

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { Command } from "commander";
import chokidar from "chokidar";
import dotenv from "dotenv";
import { classifyFile, calculateFileRisk } from "@driveos/shared";

dotenv.config({ path: path.resolve(process.cwd(), "apps/web/.env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

interface DriveOSConfig {
  machineName: string;
  ownerId: string;
  convexUrl: string;
  authToken?: string;
  quarantineRoot: string;
  scanRoots: string[];
  minFileSizeBytes: number;
  fullHash: boolean;
}

interface HashCacheEntry {
  sizeBytes: number;
  modifiedAt: number;
  quickHash: string;
  fullHash?: string;
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
}

const AGENT_VERSION = "1.0.0";
const ONE_MB = 1024 * 1024;
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

const DEFAULT_CONFIG: DriveOSConfig = {
  machineName: "CJ-Workstation",
  ownerId: "cj",
  convexUrl: DEFAULT_CONVEX_URL,
  quarantineRoot: path.join(AGENT_HOME, "quarantine"),
  scanRoots: [],
  minFileSizeBytes: ONE_MB,
  fullHash: false,
};

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
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
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
  fs.writeFileSync(HASH_CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
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

async function syncToConvex(endpoint: string, payload: any) {
  const config = loadConfig();
  const baseUrl = resolveConvexHttpUrl(config.convexUrl);
  const url = `${baseUrl}/api/${endpoint}`;
  console.log(`[Convex Sync] POST ${url}`);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.authToken) headers.Authorization = `Bearer ${config.authToken}`;

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(body.error || `HTTP Error: ${response.status} ${response.statusText}`);
    }
    return body;
  } catch (err: any) {
    console.warn(`[Convex Offline Mode] ${endpoint} failed: ${err.message}`);
    ensureAgentHome();
    fs.appendFileSync(
      OFFLINE_LOG_PATH,
      `[${new Date().toISOString()}] ${endpoint}: ${JSON.stringify(payload)}\n`,
      "utf-8"
    );
    return { success: true, offline: true };
  }
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

  let quickHash = cached?.modifiedAt === statObj.mtimeMs ? cached.quickHash : undefined;
  let fullHash = cached?.modifiedAt === statObj.mtimeMs ? cached.fullHash : undefined;

  if (!quickHash) {
    quickHash = await calculateQuickHash(filePath, statObj.size);
  }
  if (calculateFull && !fullHash) {
    fullHash = await calculateFullHash(filePath);
  }

  hashCache[cacheKey] = {
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

async function walkFiles(
  dir: string,
  visitor: (filePath: string, statObj: fs.Stats) => Promise<void>,
  minFileSizeBytes = 0
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
      await walkFiles(fullPath, visitor, minFileSizeBytes);
    } else if (statObj.isFile() && statObj.size >= minFileSizeBytes) {
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

function preserveOriginalPath(originalPath: string) {
  const parsed = path.parse(path.resolve(originalPath));
  return path.join(parsed.root.replace(/[:/\\]+/g, "_"), path.relative(parsed.root, path.resolve(originalPath)));
}

async function executeQuarantineJob(job: any, config: DriveOSConfig) {
  validateRuntimeConfig(config);
  const quarantineFiles = [];
  const timestamp = new Date().toISOString().split("T")[0];

  for (const file of job.files || []) {
    if (["RAW", "EXPORT_FINAL", "PROJECT_FILE", "ADMIN", "ARCHIVE_MANIFEST"].includes(file.classification)) {
      console.warn(`[Quarantine Blocked] Protected ${file.classification} file skipped: ${file.path}`);
      continue;
    }

    const destination = path.join(config.quarantineRoot, timestamp, job._id, preserveOriginalPath(file.path));
    fs.mkdirSync(path.dirname(destination), { recursive: true });

    if (!fs.existsSync(file.path)) {
      console.warn(`[Quarantine Warning] File was missing: ${file.path}`);
      continue;
    }

    console.log(`[Quarantine Execute] ${file.path} -> ${destination}`);
    fs.renameSync(file.path, destination);
    quarantineFiles.push({
      fileId: file._id,
      originalPath: file.path,
      quarantinePath: destination,
      sizeBytes: file.sizeBytes,
    });
  }

  await syncToConvex("updateJobStatus", {
    jobId: job._id,
    status: "completed",
    quarantineFiles,
  });

  console.log(`[Success] Relocated ${quarantineFiles.length} file(s) to quarantine.`);
}

async function executeJob(job: any, config: DriveOSConfig) {
  console.log(`[Agent Queue] Executing job ${job._id}: ${job.action}`);
  await syncToConvex("updateJobStatus", { jobId: job._id, status: "running" });

  if (job.action === "quarantine") {
    await executeQuarantineJob(job, config);
    return;
  }

  if (job.action === "create_folder_structure") {
    const result = job.result || {};
    const rootPath = result.rootPath;
    if (!rootPath) throw new Error("create_folder_structure job missing result.rootPath");

    const { manifest, manifestPath } = writeProjectStructure(rootPath, result, result.projectId || job._id);
    await syncToConvex("createManifest", {
      projectId: result.projectId || job._id,
      createdBy: result.owner || config.ownerId,
      fileCount: PROJECT_FOLDER_TREE.length + 1,
      totalBytes: Buffer.byteLength(JSON.stringify(manifest)),
      manifestPath,
      checksum: crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    });
    await syncToConvex("updateJobStatus", { jobId: job._id, status: "completed" });
    console.log(`[Success] Created project folder structure at ${rootPath}.`);
    return;
  }

  await syncToConvex("updateJobStatus", { jobId: job._id, status: "completed" });
}

interface ScanOptions {
  fullHash?: boolean;
  allowCloudRoot?: boolean;
  checkStability?: boolean;
}

interface ScanResult {
  fileCount: number;
  byteCount: number;
  errorsCount: number;
  skippedUnstable: number;
}

// Single batched scan of one directory: register machine/drive, open a scan
// session, walk files >minSize, upload metadata in chunks of 100, and close the
// session. This is the unit of work the hourly scheduler and `scan-now` reuse.
async function performScan(scanDir: string, config: DriveOSConfig, options: ScanOptions = {}): Promise<ScanResult> {
  enforceTrackableRoot("Scan target", scanDir, Boolean(options.allowCloudRoot));
  validateRuntimeConfig(config);

  const hashCache = loadHashCache();
  const calculateFull = Boolean(options.fullHash || config.fullHash);
  const driveMetrics = getDriveMetrics(scanDir);
  const cloudProvider = cloudSyncProvider(scanDir);

  console.log(`[Scan Start] Crawling files larger than ${Math.round(config.minFileSizeBytes / ONE_MB)} MB in ${scanDir}`);
  if (cloudProvider) {
    console.warn(`[Cloud Folder] ${scanDir} is in ${cloudProvider} — tracking as metadata-only (cloud tier), not a normal drive.`);
  }

  const machineRes = await syncToConvex("registerMachine", {
    name: config.machineName,
    ownerId: config.ownerId,
    agentVersion: AGENT_VERSION,
    platform: process.platform,
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

  const scanRes = await syncToConvex("startScan", {
    machineId,
    driveId,
    rootPath: scanDir,
    agentVersion: AGENT_VERSION,
  });
  const sessionId = scanRes.sessionId || `offline-${Date.now()}`;

  const fileBatch: FileMetadata[] = [];
  const result: ScanResult = { fileCount: 0, byteCount: 0, errorsCount: 0, skippedUnstable: 0 };

  async function flushBatch(final = false) {
    if (fileBatch.length === 0) return;
    console.log(`[${final ? "Final " : ""}Batch Upload] Syncing ${fileBatch.length} file(s) to Convex`);
    await syncToConvex("uploadBatch", { scanSessionId: sessionId, machineId, driveId, files: fileBatch });
    fileBatch.length = 0;
    saveHashCache(hashCache);
  }

  await walkFiles(
    scanDir,
    async (filePath, statObj) => {
      try {
        // Skip files that are still being written so we never index a half-flushed export.
        if (options.checkStability && !(await isFileStable(filePath))) {
          result.skippedUnstable++;
          console.log(`[Scan Skip] File still changing, deferring to next cycle: ${filePath}`);
          return;
        }
        fileBatch.push(await buildFileMetadata(filePath, statObj, hashCache, calculateFull));
        result.fileCount++;
        result.byteCount += statObj.size;
        if (fileBatch.length >= 100) await flushBatch();
      } catch (err: any) {
        result.errorsCount++;
        console.warn(`[Scan Error] ${filePath}: ${err.message}`);
      }
    },
    config.minFileSizeBytes
  );

  await flushBatch(true);
  saveHashCache(hashCache);
  await syncToConvex("completeScan", {
    sessionId,
    status: result.errorsCount > 0 ? "partial" : "completed",
    errorsCount: result.errorsCount,
  });

  console.log(`[Scan Complete] ${scanDir} — ${result.fileCount} file(s), ${(result.byteCount / 1024 ** 4).toFixed(2)} TB, errors: ${result.errorsCount}, deferred: ${result.skippedUnstable}`);
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

  saveState({ lastSyncStartedAt: new Date().toISOString() });
  const totals: ScanResult = { fileCount: 0, byteCount: 0, errorsCount: 0, skippedUnstable: 0 };

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
      const res = await performScan(resolved, config, { ...options, checkStability: true });
      totals.fileCount += res.fileCount;
      totals.byteCount += res.byteCount;
      totals.errorsCount += res.errorsCount;
      totals.skippedUnstable += res.skippedUnstable;
    } catch (err: any) {
      console.error(`[Sync] Scan of ${resolved} failed: ${err.message}`);
      totals.errorsCount++;
    }
  }

  saveState({
    lastSyncCompletedAt: new Date().toISOString(),
    lastSyncFiles: totals.fileCount,
    lastSyncBytes: totals.byteCount,
  });
  console.log(`[Sync Cycle Complete] ${totals.fileCount} file(s) across ${roots.length} root(s), ${(totals.byteCount / 1024 ** 4).toFixed(2)} TB.`);
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
  .option("-q, --quarantine <path>", "Quarantine storage folder", DEFAULT_CONFIG.quarantineRoot)
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
      quarantineRoot: options.quarantine,
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
  .action(async (options) => {
    const config = loadConfig();
    const next: DriveOSConfig = {
      ...config,
      convexUrl: options.convex || config.convexUrl,
      machineName: options.machine,
      authToken: String(options.token).trim(),
      ownerId: options.owner || config.ownerId,
    };
    enforceLocalStatePath("Agent data directory", AGENT_HOME);

    // Verify the token with a direct authenticated call so we can distinguish a
    // rejected token (401) from a real network outage before saving.
    const baseUrl = resolveConvexHttpUrl(next.convexUrl);
    try {
      const res = await fetch(`${baseUrl}/api/registerMachine`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${next.authToken}` },
        body: JSON.stringify({
          name: next.machineName,
          ownerId: next.ownerId,
          agentVersion: AGENT_VERSION,
          platform: process.platform,
        }),
      });
      if (res.status === 401) {
        console.error("[Connect] Token rejected (401). Re-issue a token in the dashboard for this machine and try again.");
        process.exit(1);
      }
      if (!res.ok) {
        console.error(`[Connect] Backend error ${res.status}. Saved nothing.`);
        process.exit(1);
      }
      saveConfig(next);
      console.log(`[Connect] Connected as "${next.machineName}". Backend: ${next.convexUrl}`);
      console.log("[Connect] Token stored in the app-data config. You can now run `driveos-agent scan-now` or `sync`.");
    } catch (err: any) {
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
  .command("scan")
  .description("Recursively scan directory metadata and upload to Convex (one-shot)")
  .requiredOption("-p, --path <dir>", "Directory path to scan")
  .option("--full-hash", "Calculate streaming SHA-256 full hashes for this scan")
  .option("--allow-cloud-root", "Allow scanning a cloud-synced folder as metadata-only")
  .option("--check-stability", "Skip files that are still being written")
  .action(async (options) => {
    const scanDir = path.resolve(options.path);
    if (!fs.existsSync(scanDir)) {
      console.error(`[Error] Target path does not exist: ${scanDir}`);
      process.exit(1);
    }
    const config = loadConfig();
    await performScan(scanDir, config, {
      fullHash: Boolean(options.fullHash),
      allowCloudRoot: Boolean(options.allowCloudRoot),
      checkStability: Boolean(options.checkStability),
    });
  });

program
  .command("sync")
  .description("Scheduled, batched sync: scan all configured roots once per interval (default hourly)")
  .option("--interval-minutes <minutes>", "Minutes between sync cycles", "60")
  .option("--once", "Run a single sync cycle and exit (no scheduling)")
  .option("--full-hash", "Calculate streaming SHA-256 full hashes during scans")
  .option("--allow-cloud-root", "Allow cloud-synced roots as metadata-only")
  .action(async (options) => {
    const config = loadConfig();
    validateRuntimeConfig(config);
    const scanOpts: ScanOptions = {
      fullHash: Boolean(options.fullHash),
      allowCloudRoot: Boolean(options.allowCloudRoot),
    };
    const intervalMs = Math.max(1, Number(options.intervalMinutes) || 60) * 60 * 1000;

    // Always run an immediate catch-up cycle on start (unless paused).
    await runSyncCycle(config, scanOpts);
    if (options.once) return;

    console.log(`[Scheduler Started] Next sync in ${Math.round(intervalMs / 60000)} minute(s). Convex receives one batched update per cycle — no constant streaming.`);
    const timer = setInterval(() => { void runSyncCycle(config, scanOpts); }, intervalMs);

    const shutdown = () => { clearInterval(timer); console.log("\n[Scheduler Stopped]"); process.exit(0); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("scan-now")
  .description("Flush a sync cycle immediately across all configured roots (ignores schedule, respects pause)")
  .option("--full-hash", "Calculate streaming SHA-256 full hashes for this scan")
  .option("--allow-cloud-root", "Allow cloud-synced roots as metadata-only")
  .action(async (options) => {
    const config = loadConfig();
    validateRuntimeConfig(config);
    const res = await runSyncCycle(config, {
      fullHash: Boolean(options.fullHash),
      allowCloudRoot: Boolean(options.allowCloudRoot),
    });
    if (!res) process.exitCode = 0;
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
  .action((options) => {
    const watchDir = path.resolve(options.path);
    const config = loadConfig();
    validateRuntimeConfig(config);
    const hashCache = loadHashCache();
    let queue: FileMetadata[] = [];
    const pending = new Map<string, NodeJS.Timeout>();
    const intervalMs = Math.max(1, Number(options.intervalMinutes) || 60) * 60 * 1000;
    const debounceMs = Math.max(1, Number(options.debounceSeconds) || 8) * 1000;

    if (!fs.existsSync(watchDir)) {
      console.error(`[Error] Target path does not exist: ${watchDir}`);
      process.exit(1);
    }
    enforceTrackableRoot("Watch target", watchDir, Boolean(options.allowCloudRoot));

    // Flushes the accumulated local change-queue as ONE batched upload cycle.
    // Only ever called on the interval timer or the safety cap — never per FS event.
    async function processQueue() {
      if (queue.length === 0) return;
      if (loadState().paused) {
        console.log(`[Watcher Paused] Holding ${queue.length} queued change(s) until resume.`);
        return;
      }
      const batch = queue;
      queue = [];
      console.log(`[Watcher Batch] Flushing ${batch.length} file change(s) to Convex`);
      for (let i = 0; i < batch.length; i += 100) {
        await syncToConvex("uploadBatch", {
          scanSessionId: `watch-${config.machineName}`,
          machineId: config.machineName,
          files: batch.slice(i, i + 100),
        });
      }
      saveHashCache(hashCache);
    }

    // Builds metadata into the local queue. Does NOT upload — uploads happen only
    // in processQueue() on the interval, so filesystem events never stream to Convex.
    async function enqueue(filePath: string) {
      try {
        const statObj = fs.statSync(filePath);
        if (!statObj.isFile() || statObj.size < config.minFileSizeBytes) return;
        if (!(await isFileStable(filePath))) {
          console.log(`[Watcher Stable Check] Skipping actively changing file until next event: ${filePath}`);
          return;
        }
        queue.push(await buildFileMetadata(filePath, statObj, hashCache, config.fullHash));
        // Safety cap only — bounds memory if a huge burst arrives between intervals.
        if (queue.length >= 500) {
          console.log("[Watcher Cap] Local queue reached 500 — flushing early to bound memory.");
          await processQueue();
        }
      } catch (err: any) {
        console.warn(`[Watcher Skip] ${filePath}: ${err.message}`);
      }
    }

    function schedule(filePath: string) {
      const existing = pending.get(filePath);
      if (existing) clearTimeout(existing);
      pending.set(filePath, setTimeout(() => {
        pending.delete(filePath);
        void enqueue(filePath);
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
      .on("add", schedule)
      .on("change", schedule)
      .on("unlink", (filePath) => {
        console.log(`[Watcher File Removed] ${filePath}`);
      });
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

    await syncToConvex("createManifest", {
      projectId: options.projectId,
      createdBy: project.ownerId || config.ownerId,
      fileCount: PROJECT_FOLDER_TREE.length + 1,
      totalBytes: Buffer.byteLength(JSON.stringify(manifest)),
      manifestPath,
      checksum: crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    });

    console.log(`[Wizard Success] Created project folder structure at ${root}`);
    console.log(`[Wizard Success] Manifest: ${manifestPath}`);
  });

program
  .command("run-jobs")
  .description("Poll Convex backend for pending cleanup and folder-creation actions and execute them")
  .action(async () => {
    const config = loadConfig();
    validateRuntimeConfig(config);
    console.log(`[Agent Queue] Polling pending actions for machine "${config.machineName}"`);

    const jobs = await syncToConvex("pollPendingJobs", { machineId: config.machineName });
    if ((jobs as any).offline || !Array.isArray(jobs) || jobs.length === 0) {
      console.log("[Agent Queue] No pending approved jobs. Queue is idle.");
      return;
    }

    for (const job of jobs) {
      try {
        await executeJob(job, config);
      } catch (err: any) {
        console.error(`[Agent Execution Error] Job ${job._id} failed: ${err.message}`);
        await syncToConvex("updateJobStatus", { jobId: job._id, status: "failed", result: { error: err.message } });
      }
    }
  });

program
  .command("quarantine")
  .description("Execute an approved quarantine job immediately")
  .requiredOption("-j, --jobId <id>", "Cleanup job ID")
  .action(async (options) => {
    const config = loadConfig();
    validateRuntimeConfig(config);
    const res = await syncToConvex("getJob", { jobId: options.jobId });
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
    const res = await syncToConvex("getQuarantineItem", { quarantineId: options.quarantineId });
    const item = res.item;
    if (!item || res.offline) {
      console.error(`[Error] Quarantine item not found or Convex is offline: ${options.quarantineId}`);
      process.exit(1);
    }

    if (!fs.existsSync(item.quarantinePath)) {
      console.error(`[Error] Quarantined file missing: ${item.quarantinePath}`);
      process.exit(1);
    }

    fs.mkdirSync(path.dirname(item.originalPath), { recursive: true });
    fs.renameSync(item.quarantinePath, item.originalPath);
    await syncToConvex("markQuarantineRestored", { quarantineId: options.quarantineId });
    console.log(`[Restore Success] ${item.quarantinePath} -> ${item.originalPath}`);
  });

program
  .command("manifest")
  .description("Generate an archive manifest for a project root")
  .requiredOption("-i, --projectId <id>", "Project ID from backend")
  .option("-r, --root <dir>", "Project root path; defaults to backend project.rootPath")
  .option("--full-hash", "Calculate streaming SHA-256 full hashes for manifest entries")
  .option("--allow-cloud-root", "Allow writing manifest inside a cloud-synced project root")
  .action(async (options) => {
    const config = loadConfig();
    validateRuntimeConfig(config);
    const projectRes = await syncToConvex("getProject", { projectId: options.projectId });
    const project = projectRes.project || {};
    const root = path.resolve(options.root || project.rootPath || "");

    if (!root || !fs.existsSync(root)) {
      console.error("[Error] Project root is required and must exist. Pass --root or set project.rootPath in Convex.");
      process.exit(1);
    }
    enforceTrackableRoot("Manifest root", root, Boolean(options.allowCloudRoot));

    const hashCache = loadHashCache();
    const files: any[] = [];
    let totalBytes = 0;

    await walkFiles(root, async (filePath, statObj) => {
      const metadata = await buildFileMetadata(filePath, statObj, hashCache, Boolean(options.fullHash));
      totalBytes += statObj.size;
      files.push({
        path: metadata.path,
        sizeBytes: metadata.sizeBytes,
        modifiedAtFile: metadata.modifiedAtFile,
        quickHash: metadata.quickHash,
        fullHash: metadata.fullHash,
        classification: metadata.classification,
        riskLevel: metadata.riskLevel,
      });
    });

    const manifest = {
      ...buildProjectManifest(project, options.projectId, root),
      generatedAt: new Date().toISOString(),
      rootPath: root,
      fileCount: files.length,
      totalBytes,
      files,
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    const checksum = crypto.createHash("sha256").update(manifestJson).digest("hex");
    const manifestPath = path.join(root, "09_ARCHIVE_MANIFEST", "archive_manifest.json");

    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, manifestJson, "utf-8");
    saveHashCache(hashCache);

    await syncToConvex("createManifest", {
      projectId: options.projectId,
      createdBy: project.ownerId || config.ownerId,
      fileCount: files.length,
      totalBytes,
      manifestPath,
      checksum,
    });

    console.log(`[Manifest Success] ${manifestPath}`);
    console.log(`[Manifest Success] ${files.length} file(s), checksum ${checksum}`);
  });

program.parse(process.argv);
