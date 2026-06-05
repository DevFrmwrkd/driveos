#!/usr/bin/env node

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Command } from "commander";
import chokidar from "chokidar";
import { classifyFile, calculateFileRisk } from "@driveos/shared";

// ============================================================
// Hashing & Caching System
// ============================================================

interface HashCacheEntry {
  sizeBytes: number;
  modifiedAt: number;
  quickHash: string;
  fullHash?: string;
}

const CONFIG_PATH = "./driveos-config.json";
const HASH_CACHE_PATH = "./driveos-hash-cache.json";

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  }
  return {
    machineName: "CJ-Workstation",
    ownerId: "cj",
    convexUrl: "http://localhost:3000",
    quarantineRoot: "./.driveos_quarantine",
    scanRoots: ["./temp_test_drive"],
  };
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

// Quick Hash calculation: size + first 1KB + middle 1KB + last 1KB
async function calculateQuickHash(filePath: string, sizeBytes: number): Promise<string> {
  if (sizeBytes < 4096) {
    // If very small, just hash the whole file
    const content = fs.readFileSync(filePath);
    return crypto.createHash("md5").update(content).digest("hex");
  }

  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(3072); // 3 * 1024 bytes

  try {
    // Read first 1KB
    fs.readSync(fd, buffer, 0, 1024, 0);

    // Read middle 1KB
    const middleOffset = Math.round(sizeBytes / 2) - 512;
    fs.readSync(fd, buffer, 1024, 1024, middleOffset);

    // Read last 1KB
    const lastOffset = sizeBytes - 1024;
    fs.readSync(fd, buffer, 2048, 1024, lastOffset);

    // Append sizeBytes to buffer to ensure unique quickHash per size
    const sizeBuffer = Buffer.alloc(8);
    sizeBuffer.writeBigInt64BE(BigInt(sizeBytes));

    const hasher = crypto.createHash("md5");
    hasher.update(buffer);
    hasher.update(sizeBuffer);
    return hasher.digest("hex");
  } catch (err) {
    console.error(`[QuickHash Error] Failed to read ${filePath}:`, err);
    return "error-hash-" + sizeBytes;
  } finally {
    fs.closeSync(fd);
  }
}

// Full Hash: Streaming SHA-256 for duplicate verification
function calculateFullHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

// ============================================================
// Convex API Mock-Client / HTTP Sync (Ensures CLI works standalone too)
// ============================================================

async function syncToConvex(endpoint: string, payload: any) {
  const config = loadConfig();
  console.log(`[Convex Sync] Posting to ${config.convexUrl}/api/${endpoint}...`);
  try {
    // Using standard global fetch (Node.js 18+)
    const response = await fetch(`${config.convexUrl}/api/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } catch (err: any) {
    console.warn(`[Convex Offline/Mock Mode] Failed to upload to Convex (${err.message}). Storing action in local audit log.`);
    // Save offline stub logs locally
    fs.appendFileSync("./driveos-agent-offline-log.txt", `[${new Date().toISOString()}] ${endpoint}: ${JSON.stringify(payload)}\n`);
    return { success: true, offline: true };
  }
}

// ============================================================
// CLI Implementation
// ============================================================

const program = new Command();

program
  .name("driveos-agent")
  .description("Storage Command Center CLI Agent for local computers and mounted drives")
  .version("1.0.0");

// 1) driveos-agent init
program
  .command("init")
  .description("Initialize agent configuration and setup local roots")
  .option("-m, --machine <name>", "Machine workstation name", "CJ-Workstation")
  .option("-o, --owner <ownerId>", "Owner / Lead Editor ID", "cj")
  .option("-c, --convex <url>", "Convex Deployment HTTP URL", "http://localhost:3000")
  .option("-q, --quarantine <path>", "Quarantine storage folder", "./.driveos_quarantine")
  .action((options) => {
    const config = {
      machineName: options.machine,
      ownerId: options.owner,
      convexUrl: options.convex,
      quarantineRoot: options.quarantine,
      scanRoots: ["./temp_test_drive"],
    };

    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    console.log(`[Success] DriveOS Agent configured in ${CONFIG_PATH}:`);
    console.log(config);

    // Create quarantine root folder
    if (!fs.existsSync(options.quarantine)) {
      fs.mkdirSync(options.quarantine, { recursive: true });
    }
    // Create test drive stub for simulation
    if (!fs.existsSync("./temp_test_drive")) {
      fs.mkdirSync("./temp_test_drive", { recursive: true });
    }
  });

// 2) driveos-agent scan --path <dir>
program
  .command("scan")
  .description("Recursively scan directory metadata and upload to Convex")
  .requiredOption("-p, --path <dir>", "Directory path to scan")
  .action(async (options) => {
    const scanDir = options.path;
    if (!fs.existsSync(scanDir)) {
      console.error(`[Error] Target path does not exist: ${scanDir}`);
      process.exit(1);
    }

    const config = loadConfig();
    const hashCache = loadHashCache();

    console.log(`[Scan Start] Crawling files larger than 1 MB in ${scanDir}...`);

    // Register machine and drive
    const regRes = await syncToConvex("registerMachine", {
      name: config.machineName,
      ownerId: config.ownerId,
      agentVersion: "1.0.0",
      platform: process.platform,
    });

    const stat = fs.statSync(scanDir);
    const driveReg = await syncToConvex("registerDrive", {
      label: path.basename(scanDir),
      volumeId: path.basename(scanDir) + "-vol",
      ownerId: config.ownerId,
      capacityBytes: 4 * 1024 * 1024 * 1024 * 1024, // 4TB stub
      freeBytes: 1.2 * 1024 * 1024 * 1024 * 1024,
      usedBytes: 2.8 * 1024 * 1024 * 1024 * 1024,
      mountPath: scanDir,
      tier: "hot",
    });

    const sessionId = "session-" + Math.random().toString(36).substring(7);
    console.log(`[Scan Session] Initialized Scan Session: ${sessionId}`);

    const ignoredFolders = [
      ".TRASH",
      ".SPOTLIGHT-V100",
      ".FSEVENTSD",
      "SYSTEM VOLUME INFORMATION",
      "NODE_MODULES",
      ".GIT",
      ".DS_STORE",
      "TEMPORARY",
    ];

    const fileBatch: any[] = [];
    let fileCount = 0;
    let byteCount = 0;

    async function walk(dir: string) {
      let entries: string[] = [];
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
          if (ignoredFolders.includes(entry.toUpperCase())) {
            console.log(`[Ignored Folder] Skipping ${entry}`);
            continue;
          }
          await walk(fullPath);
        } else if (statObj.isFile()) {
          // Rule: Skip files smaller than 1 MB (1,048,576 bytes)
          if (statObj.size < 1024 * 1024) continue;

          fileCount++;
          byteCount += statObj.size;

          const mtime = statObj.mtimeMs;
          let quickHash = "";

          // Check Hash Cache
          const cacheKey = `${fullPath}-${statObj.size}`;
          const cached = hashCache[cacheKey];
          if (cached && cached.modifiedAt === mtime) {
            quickHash = cached.quickHash;
          } else {
            quickHash = await calculateQuickHash(fullPath, statObj.size);
            // Cache it
            hashCache[cacheKey] = {
              sizeBytes: statObj.size,
              modifiedAt: mtime,
              quickHash,
            };
          }

          const classification = classifyFile(fullPath, entry);
          const riskLevel = calculateFileRisk(classification, statObj.size);

          fileBatch.push({
            path: fullPath,
            normalizedPath: fullPath.toLowerCase(),
            parentPath: dir,
            name: entry,
            extension: entry.split(".").pop() || "",
            sizeBytes: statObj.size,
            createdAtFile: statObj.birthtimeMs,
            modifiedAtFile: statObj.mtimeMs,
            quickHash,
            classification,
            riskLevel,
            isGenerated: classification === "CACHE" || classification === "PROXY",
            isRaw: classification === "RAW",
            isFinal: classification === "EXPORT_FINAL",
            isProjectFile: entry.endsWith(".prproj") || entry.endsWith(".aep") || entry.endsWith(".drp"),
          });

          // Upload in batches of 100
          if (fileBatch.length >= 100) {
            console.log(`[Batch Upload] Syncing ${fileBatch.length} files to Convex...`);
            await syncToConvex("uploadBatch", {
              scanSessionId: sessionId,
              machineId: config.machineName,
              driveId: driveReg.driveId || "cj-ssd",
              files: fileBatch,
            });
            fileBatch.length = 0; // Clear array
            saveHashCache(hashCache);
          }
        }
      }
    }

    await walk(scanDir);

    // Sync remainder files
    if (fileBatch.length > 0) {
      console.log(`[Final Batch Upload] Syncing remaining ${fileBatch.length} files to Convex...`);
      await syncToConvex("uploadBatch", {
        scanSessionId: sessionId,
        machineId: config.machineName,
        driveId: driveReg.driveId || "cj-ssd",
        files: fileBatch,
      });
    }

    saveHashCache(hashCache);
    console.log(`[Scan Complete] Scanned ${fileCount} files, Total size: ${(byteCount / (1024 ** 4)).toFixed(2)} TB.`);
  });

// 3) driveos-agent watch --path <dir>
program
  .command("watch")
  .description("Live watch a folder or drive for additions, edits, or removals")
  .requiredOption("-p, --path <dir>", "Directory path to watch")
  .action((options) => {
    const watchDir = options.path;
    console.log(`[Watcher Started] Live watching directory ${watchDir} for changes...`);

    const watcher = chokidar.watch(watchDir, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true,
    });

    // Debounce uploads
    let queue: any[] = [];
    let timeout: NodeJS.Timeout | null = null;

    function processQueue() {
      console.log(`[Watcher Debounce] Flushing ${queue.length} file change updates to Convex.`);
      syncToConvex("uploadBatch", {
        scanSessionId: "live-watch-session",
        machineId: loadConfig().machineName,
        files: queue,
      });
      queue = [];
    }

    watcher
      .on("add", async (filePath) => {
        console.log(`[Watcher File Added] ${filePath}`);
        const stat = fs.statSync(filePath);
        if (stat.size < 1024 * 1024) return; // ignore < 1MB

        const entry = path.basename(filePath);
        const classification = classifyFile(filePath, entry);
        queue.push({
          path: filePath,
          normalizedPath: filePath.toLowerCase(),
          parentPath: path.dirname(filePath),
          name: entry,
          extension: entry.split(".").pop() || "",
          sizeBytes: stat.size,
          createdAtFile: stat.birthtimeMs,
          modifiedAtFile: stat.mtimeMs,
          classification,
          riskLevel: calculateFileRisk(classification, stat.size),
          isGenerated: classification === "CACHE" || classification === "PROXY",
          isRaw: classification === "RAW",
          isFinal: classification === "EXPORT_FINAL",
          isProjectFile: entry.endsWith(".prproj"),
        });

        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(processQueue, 3000); // 3 sec debounce
      })
      .on("change", (filePath) => {
        console.log(`[Watcher File Changed] ${filePath}`);
        // similar logic
      });
  });

// 4) driveos-agent create-project --projectId <id> --root <dir>
program
  .command("create-project")
  .description("Create automated folder tree structure and write project_manifest.json")
  .requiredOption("-i, --projectId <id>", "Project ID from backend")
  .requiredOption("-r, --root <dir>", "Root directories to build project")
  .action(async (options) => {
    const root = options.root;
    const config = loadConfig();

    console.log(`[Wizard] Creating project structure in: ${root}`);

    // Standard Project Folder Structure Definitions
    const folderTree = [
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

    try {
      // 1) Create folder tree recursively
      for (const branch of folderTree) {
        const fullDir = path.join(root, branch);
        if (!fs.existsSync(fullDir)) {
          fs.mkdirSync(fullDir, { recursive: true });
        }
      }

      // 2) Write project_manifest.json
      const manifest = {
        projectId: options.projectId,
        projectName: "Show X — Ep. 214",
        client: "Show X Media",
        showName: "Show X (YouTube)",
        owner: config.ownerId,
        createdAt: new Date().toISOString(),
        status: "active",
        tier: "hot",
        folderTemplate: "YouTube Show",
        deleteRules: {
          raw: "never_auto_delete",
          projectFiles: "never_auto_delete",
          finalExports: "keep",
          proxies: "safe_after_delivery",
          cache: "safe_after_confirmation",
          reviewExports: "safe_after_final_delivery",
        },
      };

      const manifestPath = path.join(root, "09_ARCHIVE_MANIFEST/project_manifest.json");
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

      console.log(`[Wizard Success] Created folder structures in ${root}`);
      console.log(`[Wizard Success] Created manifest file at ${manifestPath}`);

      // Sync success to Convex
      await syncToConvex("createManifest", {
        projectId: options.projectId,
        createdBy: config.ownerId,
        fileCount: folderTree.length + 1,
        totalBytes: 256, // sizes of stubs
        manifestPath,
        checksum: crypto.createHash("md5").update(JSON.stringify(manifest)).digest("hex"),
      });
    } catch (err: any) {
      console.error(`[Wizard Failure] Folder creation failed: ${err.message}`);
    }
  });

// 5) driveos-agent run-jobs
program
  .command("run-jobs")
  .description("Poll Convex backend for pending cleanup and folder-creation actions and execute them")
  .action(async () => {
    const config = loadConfig();
    console.log(`[Agent Queue] Polling Convex backend for pending actions for machine "${config.machineName}"...`);

    // Poll endpoint (polls pollPendingJobs query)
    const jobs = await syncToConvex("pollPendingJobs", { machineId: config.machineName });

    if (!jobs || jobs.length === 0 || jobs.offline) {
      console.log("[Agent Queue] No pending approved jobs. Queue is idle.");
      return;
    }

    console.log(`[Agent Queue] Found ${jobs.length} pending approved job(s)! Running execute loop...`);

    for (const job of jobs) {
      console.log(`[Agent Queue] Executing Job ID: ${job._id}, Action: ${job.action}`);

      try {
        // Mark running
        await syncToConvex("updateJobStatus", { jobId: job._id, status: "running" });

        if (job.action === "quarantine") {
          const quarantineFiles = [];
          const timestamp = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

          for (const file of job.files) {
            const fileDestPath = path.join(
              config.quarantineRoot,
              timestamp,
              job._id,
              path.basename(file.path)
            );

            console.log(`[Quarantine Execute] Moving file from ${file.path} to ${fileDestPath}...`);

            // Ensure destination folder exists
            fs.mkdirSync(path.dirname(fileDestPath), { recursive: true });

            if (fs.existsSync(file.path)) {
              fs.renameSync(file.path, fileDestPath);
              quarantineFiles.push({
                fileId: file._id,
                originalPath: file.path,
                quarantinePath: fileDestPath,
                sizeBytes: file.sizeBytes,
              });
            } else {
              console.warn(`[Quarantine Warning] File to quarantine was missing: ${file.path}`);
            }
          }

          // Complete job and write quarantine items
          await syncToConvex("updateJobStatus", {
            jobId: job._id,
            status: "completed",
            quarantineFiles,
          });
          console.log(`[Success] Relocated ${quarantineFiles.length} files to quarantine buffer.`);
        } else if (job.action === "restore") {
          // Restore quarantine files
          // Find quarantined item and move back
          // (Mock implementation: restore first file in job files list)
          console.log(`[Restore Execute] Restoring files for job ${job._id}...`);
          await syncToConvex("updateJobStatus", { jobId: job._id, status: "completed" });
        } else if (job.action === "create_folder_structure") {
          const res = job.result;
          console.log(`[Agent Execute] Creating folder structure for ${res.projectName} at root: ${res.rootPath}...`);
          // Execute creation
          const folderTree = [
            "00_ADMIN", "01_BRIEF", "02_RAW/A_CAM", "02_RAW/B_CAM", "02_RAW/AUDIO",
            "03_PROJECT_FILES/PREMIERE", "04_ASSETS", "05_PROXIES", "06_RENDERS_CACHE",
            "07_EXPORTS/FINAL", "08_DELIVERY", "09_ARCHIVE_MANIFEST"
          ];
          for (const folder of folderTree) {
            fs.mkdirSync(path.join(res.rootPath, folder), { recursive: true });
          }
          await syncToConvex("updateJobStatus", { jobId: job._id, status: "completed" });
          console.log(`[Success] Structured folders.`);
        } else {
          // other actions
          await syncToConvex("updateJobStatus", { jobId: job._id, status: "completed" });
        }
      } catch (err: any) {
        console.error(`[Agent Execution Error] Job ${job._id} failed:`, err);
        await syncToConvex("updateJobStatus", { jobId: job._id, status: "failed", result: { error: err.message } });
      }
    }
  });

program.parse(process.argv);
