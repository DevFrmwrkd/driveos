#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Command } from "commander";
import chokidar from "chokidar";
import { classifyFile, calculateFileRisk } from "@driveos/shared";

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

const CONFIG_PATH = "./driveos-config.json";
const HASH_CACHE_PATH = "./driveos-hash-cache.json";
const OFFLINE_LOG_PATH = "./driveos-agent-offline-log.txt";
const AGENT_VERSION = "1.0.0";
const ONE_MB = 1024 * 1024;

const DEFAULT_CONFIG: DriveOSConfig = {
  machineName: "CJ-Workstation",
  ownerId: "cj",
  convexUrl: "http://localhost:3210",
  quarantineRoot: "./.driveos_quarantine",
  scanRoots: ["./temp_test_drive"],
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

function loadConfig(): DriveOSConfig {
  if (fs.existsSync(CONFIG_PATH)) {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) };
  }
  return DEFAULT_CONFIG;
}

function saveConfig(config: DriveOSConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

function loadHashCache(): Record<string, HashCacheEntry> {
  if (fs.existsSync(HASH_CACHE_PATH)) {
    return JSON.parse(fs.readFileSync(HASH_CACHE_PATH, "utf-8"));
  }
  return {};
}

function saveHashCache(cache: Record<string, HashCacheEntry>) {
  fs.writeFileSync(HASH_CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
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

function writeProjectStructure(root: string, project: any, projectId: string) {
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
  .action((options) => {
    const scanRoots = options.roots
      ? String(options.roots).split(",").map((root) => root.trim()).filter(Boolean)
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

    saveConfig(config);
    fs.mkdirSync(config.quarantineRoot, { recursive: true });
    for (const root of config.scanRoots) fs.mkdirSync(root, { recursive: true });

    console.log(`[Success] DriveOS Agent configured in ${CONFIG_PATH}`);
    console.log(config);
  });

program
  .command("install-drive")
  .description("Install DriveOS scan/watch hooks into a mounted drive root")
  .requiredOption("-p, --path <dir>", "Mounted drive or folder root")
  .option("-n, --name <label>", "Drive label")
  .action((options) => {
    const root = path.resolve(options.path);
    if (!fs.existsSync(root)) {
      console.error(`[Error] Target path does not exist: ${root}`);
      process.exit(1);
    }

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

    console.log(`[Success] Installed DriveOS hooks in ${hookDir}`);
  });

program
  .command("scan")
  .description("Recursively scan directory metadata and upload to Convex")
  .requiredOption("-p, --path <dir>", "Directory path to scan")
  .option("--full-hash", "Calculate streaming SHA-256 full hashes for this scan")
  .action(async (options) => {
    const scanDir = path.resolve(options.path);
    if (!fs.existsSync(scanDir)) {
      console.error(`[Error] Target path does not exist: ${scanDir}`);
      process.exit(1);
    }

    const config = loadConfig();
    const hashCache = loadHashCache();
    const calculateFull = Boolean(options.fullHash || config.fullHash);
    const driveMetrics = getDriveMetrics(scanDir);

    console.log(`[Scan Start] Crawling files larger than ${Math.round(config.minFileSizeBytes / ONE_MB)} MB in ${scanDir}`);

    const machineRes = await syncToConvex("registerMachine", {
      name: config.machineName,
      ownerId: config.ownerId,
      agentVersion: AGENT_VERSION,
      platform: process.platform,
    });
    const machineId = machineRes.machineId || config.machineName;

    const driveRes = await syncToConvex("registerDrive", {
      label: path.basename(scanDir),
      volumeId: `${process.platform}:${scanDir}`,
      machineId,
      ownerId: config.ownerId,
      ...driveMetrics,
      mountPath: scanDir,
      tier: "hot",
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
    let fileCount = 0;
    let byteCount = 0;
    let errorsCount = 0;

    async function flushBatch(final = false) {
      if (fileBatch.length === 0) return;
      console.log(`[${final ? "Final " : ""}Batch Upload] Syncing ${fileBatch.length} file(s) to Convex`);
      await syncToConvex("uploadBatch", {
        scanSessionId: sessionId,
        machineId,
        driveId,
        files: fileBatch,
      });
      fileBatch.length = 0;
      saveHashCache(hashCache);
    }

    await walkFiles(
      scanDir,
      async (filePath, statObj) => {
        try {
          fileBatch.push(await buildFileMetadata(filePath, statObj, hashCache, calculateFull));
          fileCount++;
          byteCount += statObj.size;
          if (fileBatch.length >= 100) await flushBatch();
        } catch (err: any) {
          errorsCount++;
          console.warn(`[Scan Error] ${filePath}: ${err.message}`);
        }
      },
      config.minFileSizeBytes
    );

    await flushBatch(true);
    saveHashCache(hashCache);
    await syncToConvex("completeScan", {
      sessionId,
      status: errorsCount > 0 ? "partial" : "completed",
      errorsCount,
    });

    console.log(`[Scan Complete] Scanned ${fileCount} file(s), ${(byteCount / 1024 ** 4).toFixed(2)} TB, errors: ${errorsCount}`);
  });

program
  .command("watch")
  .description("Live watch a folder or drive for additions, edits, or removals")
  .requiredOption("-p, --path <dir>", "Directory path to watch")
  .action((options) => {
    const watchDir = path.resolve(options.path);
    const config = loadConfig();
    const hashCache = loadHashCache();
    let queue: FileMetadata[] = [];
    let timeout: NodeJS.Timeout | null = null;

    if (!fs.existsSync(watchDir)) {
      console.error(`[Error] Target path does not exist: ${watchDir}`);
      process.exit(1);
    }

    async function processQueue() {
      if (queue.length === 0) return;
      const batch = queue;
      queue = [];
      console.log(`[Watcher Debounce] Flushing ${batch.length} file change(s) to Convex`);
      await syncToConvex("uploadBatch", {
        scanSessionId: `watch-${config.machineName}`,
        machineId: config.machineName,
        files: batch,
      });
      saveHashCache(hashCache);
    }

    async function enqueue(filePath: string) {
      try {
        const statObj = fs.statSync(filePath);
        if (!statObj.isFile() || statObj.size < config.minFileSizeBytes) return;
        queue.push(await buildFileMetadata(filePath, statObj, hashCache, config.fullHash));
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(processQueue, 3000);
      } catch (err: any) {
        console.warn(`[Watcher Skip] ${filePath}: ${err.message}`);
      }
    }

    console.log(`[Watcher Started] Live watching ${watchDir}`);
    chokidar
      .watch(watchDir, {
        ignored: (candidate) => shouldIgnoreDirectory(path.basename(candidate)),
        persistent: true,
        ignoreInitial: true,
      })
      .on("add", enqueue)
      .on("change", enqueue)
      .on("unlink", (filePath) => {
        console.log(`[Watcher File Removed] ${filePath}`);
      });
  });

program
  .command("create-project")
  .description("Create automated folder tree structure and write project_manifest.json")
  .requiredOption("-i, --projectId <id>", "Project ID from backend")
  .requiredOption("-r, --root <dir>", "Root directory to build project")
  .action(async (options) => {
    const root = path.resolve(options.root);
    const config = loadConfig();
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
  .action(async (options) => {
    const config = loadConfig();
    const projectRes = await syncToConvex("getProject", { projectId: options.projectId });
    const project = projectRes.project || {};
    const root = path.resolve(options.root || project.rootPath || "");

    if (!root || !fs.existsSync(root)) {
      console.error("[Error] Project root is required and must exist. Pass --root or set project.rootPath in Convex.");
      process.exit(1);
    }

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
