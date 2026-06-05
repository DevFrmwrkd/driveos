# DriveOS — Storage Command Center for Video Production

DriveOS is a highly optimized, production-grade **Storage Command Center** designed for high-throughput video production and creative content studios. It allows editors, producers, and assistant editors to monitor massive local hard drives, RAID units, camera RAW storage pools, proxies, render caches, deliverables, and Google Drive cloud storage in real time.

---

## 🚀 Key Features

*   **🖥️ Command Center Dashboard**: A premium, dense, high-contrast, near-black "mission control" interface showing studio-wide storage, online drives, waste, and automated warnings.
*   **🛠️ Local Agent CLI**: A Node.js TypeScript daemon that runs on editors' computers to crawl mounted volumes, index metadata, watch active projects, structure folders, and relocate files.
*   **🧠 Intelligent File Classification**: Automatic file detection (RAW, Proxy, Cache, Export-Final, stock footage, documents, fonts, etc.) based on advanced extension mapping, filename structures, and relative paths.
*   **⚖️ Automatic Risk Leveling**: Categorization of files into risk tiers (Green = Safe to purge, Yellow = Review needed, Red = High risk / protected).
*   **🛡️ Non-Destructive Quarantine**: All cleanup actions move files to a secure, reversible quarantine buffer (`.driveos_quarantine/YYYY-MM-DD/`) rather than deleting them immediately, providing a 14-day rollback safeguard.
*   **🪄 Create Project Wizard**: Instantly scaffold standardized project folders (ADMIN, RAW, DAVINCI/PREMIERE, SOCIAL_CUTDOWNS, MANIFESTS) with zero chaos.
*   **🔗 Real-Time Backend**: Built on Convex's real-time document engine for collaborative synchronization across all editing workstations.

---

## 🏛️ System Architecture

DriveOS is structured as a **Monorepo** to share types, business rules, and models across the terminal and web interfaces:

```
/
├── apps/
│   ├── web/            # Next.js App Router Web Dashboard
│   └── agent/          # Node.js CLI Agent (Scans drives & runs background jobs)
├── packages/
│   └── shared/         # Shared classification rules, health math, and types
├── convex/             # Real-time backend database schema and endpoints
└── package.json        # Workspace configuration
```

---

## 🛠️ Installation & Getting Started

### 📋 Prerequisites

Ensure you have **Node.js 18+** installed.

### 1️⃣ Install Dependencies
Run the package installation at the root workspace:
```bash
npm install
```

### 2️⃣ Build Shared Library
Compile the `@driveos/shared` rules engine first:
```bash
npm run build --workspace=packages/shared
```

### 3️⃣ Start Convex Backend
Convex runs a real-time reactive document store. Set up a Convex dev backend:
```bash
npx convex dev
```
*(Once Convex initializes, it will automatically overwrite our compile-time stubs at `/convex/_generated/` with the live client hooks).*

### 4️⃣ Seed the Database (Optional but Recommended)
To populate DriveOS with realistic studio drives, active/archived projects, duplicates, and warning feeds:
```bash
npx convex dev --run seed:seed
```

### 5️⃣ Run Web Dashboard (Next.js)
Start the Next.js development server:
```bash
npm run dev:web
```
The storage dashboard will be live at: **`http://localhost:3000`**

### 6️⃣ Run the Local Agent CLI
Compile the agent executable:
```bash
npm run build --workspace=apps/agent
```
The agent is now compiled and ready to execute. You can run commands locally inside `/apps/agent/dist/index.js` or link it:
```bash
node apps/agent/dist/index.js --help
```

To expose the CLI as `driveos-agent` on this machine:
```bash
npm link --workspace=apps/agent
```

To install lightweight scan/watch hooks directly into a mounted hard drive:
```bash
driveos-agent install-drive --path "/Volumes/CJ_Working" --name "CJ Working"
```
This writes a `.driveos/` folder on the drive with a drive manifest plus `scan.sh` and `watch.sh` helpers. It does not upload media; the agent only syncs metadata and hashes.

---

## 💻 CLI Agent Reference Commands

### 📁 `init` — Setup Local Workstation Configuration
Configure your agent machine name, owner ID, Convex endpoint, and quarantine directory:
```bash
node apps/agent/dist/index.js init \
  --machine "CJ-Workstation" \
  --owner "cj" \
  --convex "http://localhost:3001" \
  --quarantine "./.driveos_quarantine"
```

### 🔍 `scan` — Index Volume Metadata
Recursively index any folder or mounted hard drive. DriveOS filters files **larger than 1 MB** and ignores dotfiles, system logs, node packages, and Git histories:
```bash
node apps/agent/dist/index.js scan --path "./temp_test_drive"
```
*   **QuickHash Speed**: For massive video files, the agent computes a fast checksum hash combining the file size with the first, middle, and last 1 KB of the file.
*   **Local Cache**: Quick hashes are saved in `./driveos-hash-cache.json` so that subsequent scans re-index unchanged files in milliseconds.

### 🕒 `watch` — Live Folder Watcher
Run a persistent background watcher on a directory. It debounces file additions and edits and updates Convex:
```bash
node apps/agent/dist/index.js watch --path "./temp_test_drive"
```

### 🧷 `install-drive` — Add Drive-Level Hooks
Install reusable scan/watch launch scripts on a mounted disk:
```bash
node apps/agent/dist/index.js install-drive --path "/Volumes/CJ_Working"
```

### 🧙 `create-project` — Create Standardized Studio Structure
Instantly build the approved directory tree for an active edit workspace:
```bash
node apps/agent/dist/index.js create-project \
  --projectId "your-project-id" \
  --root "./temp_test_drive/Show_X_Ep214"
```
This scaffolds:
*   `00_ADMIN/` (Contracts, licenses, release notes)
*   `02_RAW/` (A_CAM, B_CAM, audio, drones)
*   `03_PROJECT_FILES/` (Premiere, AE, DaVinci)
*   `04_ASSETS/` (Music, sound effects, fonts, LUTs)
*   `05_PROXIES/`
*   `06_RENDERS_CACHE/`
*   `07_EXPORTS/REVIEW/`
*   `08_DELIVERY/`
*   `09_ARCHIVE_MANIFEST/project_manifest.json` (scaffolds metadata)

### 📬 `run-jobs` — Execute Approved Remote Actions
Assistant editors can queue cleanup requests from the Web UI. The agent polls Convex, executing approved actions locally (creating project trees, moving duplicate files to quarantine, or restoring them):
```bash
node apps/agent/dist/index.js run-jobs
```

### 🧾 `manifest` — Generate Archive Manifest
Create a project archive manifest without deleting or moving files:
```bash
node apps/agent/dist/index.js manifest \
  --projectId "your-project-id" \
  --root "./temp_test_drive/Show_X_Ep214"
```

### ♻️ `quarantine` / `restore` — Execute Approved Safety Jobs
Run an approved quarantine job or restore a quarantined file:
```bash
node apps/agent/dist/index.js quarantine --jobId "cleanup-job-id"
node apps/agent/dist/index.js restore --quarantineId "quarantine-item-id"
```

---

## 🛡️ Safe Deletion & Quarantine Protocol

To prevent any permanent loss of raw files, DriveOS uses a highly structured relocation pipeline:

1.  **Metadata Evaluation**: The agent categorizes files by classification. Final exports, camera RAW streams, project files, and release documents are tagged **RED RISK** and blocked from auto-cleanup. Cache files are marked **GREEN RISK**.
2.  **Quarantine Job Queue**: When a user approves a cleanup recommendation in the Web UI, Convex writes a `cleanupJob` and targets it to the mounted computer.
3.  **Physical Move**: The local agent polls the queue, relocates target files to `.driveos_quarantine/YYYY-MM-DD/` preserving their parent directory hierarchy, and updates Convex with the new quarantine paths.
4.  **Rollback Buffer**: Files remain in quarantine for a configurable buffer period (default: 14 days) and can be restored to their original location with a single click.

---

## 🧪 Manual QA Checklist

Use this checklist to verify full operational readiness:

- [x] **Monorepo setup**: `npm install` runs and successfully links workspaces.
- [x] **Types & compilation**: `@driveos/shared` and `driveos-agent` compile successfully.
- [x] **Next.js compilation**: `npm run build --workspace=apps/web` compiles successfully for SSR production.
- [x] **Unit tests**: `npm test` runs with 100% success inside `@driveos/shared`.
- [x] **Agent initialization**: Running `init` command successfully scaffolds the `driveos-config.json` configuration block.
- [x] **Recursive scanning**: Running `scan` successfully walks deep trees, filters > 1 MB, skips ignored directories, and calculates quick hashes.
- [x] **Mock data compatibility**: Next.js dashboard compiles and launches in standalone local mode with high-fidelity seed data if Convex is offline.
