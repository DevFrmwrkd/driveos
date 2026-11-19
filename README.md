# DriveOS — Storage Command Center for Video Production

DriveOS is a **Storage Command Center** for video production and creative studios. Editors, producers, and assistant editors can catalog local drives, RAID units, camera RAW storage, proxies, render caches, and deliverables from a shared dashboard. Cloud account linking and synchronization are not yet available.

---

## 🚀 Key Features

*   **🖥️ Command Center Dashboard**: A premium, dense, high-contrast, near-black "mission control" interface showing studio-wide storage, online drives, waste, and automated warnings.
*   **🛠️ Local Agent CLI**: A Node.js TypeScript daemon that runs on editors' computers to crawl mounted volumes, index metadata, watch active projects, structure folders, and relocate files.
*   **🧠 Intelligent File Classification**: Automatic file detection (RAW, Proxy, Cache, Export-Final, stock footage, documents, fonts, etc.) based on advanced extension mapping, filename structures, and relative paths.
*   **⚖️ Automatic Risk Leveling**: Categorization of files into risk tiers (Green = Safe to purge, Yellow = Review needed, Red = High risk / protected).
*   **🛡️ Quarantine Before Purge**: Cleanup moves eligible files into `.driveos-quarantine/YYYY-MM-DD/` with their source hierarchy preserved. Restore is available until permanent purge; retention defaults to 14 days and can be configured from 1 to 90 days.
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

Use **Node.js 22+**, matching the supported desktop build workflow.

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

### 4️⃣ Demo Data (Disposable Local Backends Only)
The optional `seed:seed` reset is an internal function. It deletes existing application data and is disabled by default. It can run only on a disposable loopback Convex backend whose environment explicitly sets `DRIVEOS_ENABLE_DEMO_SEED=1`; hosted deployments are refused even with that flag. Clear the flag after loading a local demo. Normal workspaces do not need seeding.

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

## Workspace Accounts and Invitations

A new email/password signup creates an isolated workspace and its administrator. Joining an existing workspace requires a private invitation link from an administrator; entering a team member's email alone never grants access. Each account currently belongs to one workspace, and an account already linked elsewhere cannot be reassigned by an invitation.

In **Settings → Team Members**, an administrator adds the recipient's email, name, and role, then shares the returned link privately. The link authorizes that specific membership, expires after seven days, and is consumed once. Adding a pending member again replaces the previous link. Only a hash is stored; links are bearer authorization, not proof of email verification. Existing pending invitations created before this change need fresh links.

Existing linked accounts keep their workspace. A signed-in legacy account without a valid membership is shown an invitation form instead of the dashboard. Administrators can issue a new link to restore that account's intended membership. Viewers can read workspace data but cannot invite members or issue, rotate, or revoke machine credentials.

---

## 💻 CLI Agent Reference Commands

### 📁 `init` — Setup Local Workstation Configuration
Configure your agent machine name, owner ID, Convex endpoint, and quarantine directory:
```bash
node apps/agent/dist/index.js init \
  --machine "CJ-Workstation" \
  --owner "cj" \
  --convex "http://localhost:3001" \
  --quarantine "./.driveos-quarantine"
```

### 🔍 `scan` — Index Volume Metadata
Recursively index any folder or mounted hard drive. DriveOS filters files **larger than 1 MB** and ignores dotfiles, system logs, node packages, and Git histories:
```bash
node apps/agent/dist/index.js scan --path "./temp_test_drive"
```
*   **QuickHash Speed**: For massive video files, the agent computes a fast checksum hash combining the file size with the first, middle, and last 1 KB of the file.
*   **Local Cache**: Quick hashes are saved in `./driveos-hash-cache.json` so that subsequent scans re-index unchanged files in milliseconds.

### 🕒 `watch` — Live Folder Watcher
Run a persistent background watcher on a directory. It batches file additions, edits, and observed deletions into Convex updates:
```bash
node apps/agent/dist/index.js watch --path "./temp_test_drive"
```

Deleted files leave active catalog views after the next successful batch (`--interval-minutes`, default 60; use `--interval-minutes 1` for one-minute batches). The agent confirms physical absence and sends the server's last observation receipt; a changed observation or active quarantine/restore job prevents a stale deletion. Pause holds pending events, and an inaccessible or replaced drive root defers reconciliation. Catalog changes invalidate cached duplicate and cleanup results until analysis runs again, including when automatic analysis is disabled.

Deletion reconciliation requires the matching backend and updated agent. It covers events observed by a running watcher; pending events are held in memory, and deletions while the watcher is stopped or before a crash are not inferred from a later scan.

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

DriveOS checks file protection before cleanup and uses a relocation pipeline for eligible files:

1.  **Metadata Evaluation**: The agent categorizes files by classification. Final exports, camera RAW streams, project files, and release documents are tagged **RED RISK** and blocked from auto-cleanup. Cache files are marked **GREEN RISK**.
2.  **Quarantine Job Queue**: When a user approves a cleanup recommendation in the Web UI, Convex writes a `cleanupJob` and targets it to the mounted computer.
3.  **Physical Move**: The local agent polls the queue, relocates target files to `.driveos-quarantine/YYYY-MM-DD/` preserving their parent directory hierarchy, and updates Convex with the new quarantine paths.
4.  **Rollback Buffer**: Files remain in quarantine for a configurable period (default: 14 days). Restore queues an agent job, and only a confirmed physical move marks the file restored. An existing destination is never overwritten.
5.  **Permanent Purge**: Eligible quarantined files can be permanently deleted by a purge job. Purged files cannot be restored through DriveOS; retention is not a backup.

Non-generated duplicate cleanup requires a separate copy on the same machine. Agent 1.2.1 re-reads both files' SHA-256 checksums before quarantine and again before permanent purge; stale catalog metadata alone cannot authorize either action. Missing, edited, remote-machine, same-path, and hard-linked keep copies are rejected. Keep copies are reserved against other queued cleanup while their dependent jobs are active. Older agents cannot receive or claim these protected jobs. Existing non-generated quarantine items without a keep-copy proof require manual review before purge; generated cache/proxy cleanup is unchanged.

Catalog entries for files deleted outside DriveOS can remain stale until deletion reconciliation is added. The physical keep-copy checks above therefore remain necessary even after a recent scan.

### Interrupted agent jobs

Updated agents claim jobs with a two-minute lease and renew it at most once per twenty seconds while working. File checks share the same renewal, and throttled requests respect the server's retry delay. After an agent stops, an expired leased job can be reclaimed by an updated agent for the same machine. Claim tokens prevent a previous attempt from reporting completion after losing ownership. Scan and job execution locks are held by the operating system, so a live operation is not taken over merely because it runs for a long time.

File operations record durable journals under the original agent home before reporting their results. Restart with that same agent home and configuration so the agent can reconcile completed moves, restores, or purges and finish reporting them without repeating destructive work. Preserve this directory when upgrading or troubleshooting; changing or deleting it removes the recovery evidence.

Purge recovery verifies the original readable quarantine directory's identity before treating a missing file as deleted. Reconnect an unavailable drive/share before retrying. Older purge journals without directory evidence require manual reconciliation when their source is already missing.

Bulk purges split into jobs of at most 4,000 files. Polling safely splits older oversized purges that have never started, cancels their parent job, and records replacement jobs. Already-started oversized jobs require manual recovery so their original disk journals stay associated with the same job ID; they do not block normal queue work.

---

## 🧪 Manual QA Checklist

Use this checklist to verify full operational readiness:

- [x] **Monorepo setup**: `npm install` runs and successfully links workspaces.
- [x] **Types & compilation**: `@driveos/shared` and `driveos-agent` compile successfully.
- [x] **Next.js compilation**: `npm run build --workspace=apps/web` compiles successfully for SSR production.
- [x] **Regression tests**: `npm test` covers shared rules, agent file operations, locks, and backend authorization/lease policies.
- [x] **Agent initialization**: Running `init` command successfully scaffolds the `driveos-config.json` configuration block.
- [x] **Recursive scanning**: Running `scan` successfully walks deep trees, filters > 1 MB, skips ignored directories, and calculates quick hashes.
- [x] **Live data states**: Dashboard lists use the connected workspace's data, including real empty states while no drives or projects are tracked.

### Regression checks

Run `npm test` for classification, Windows file protection, non-overwriting moves, cross-volume copy verification, archive inventories, process locks, invitations, legacy workspace access, lease throttling, purge queue bounds, disconnected-drive recovery, and developer-only seed guards.

Run `npm run test:local` against a disposable, auth-configured local Convex backend on ports 3210/3211. It creates an isolated QA workspace and synthetic media, then exercises scans, settings, bulk cleanup, restore, duplicate keep-copy protection, project setup, and archive generation/verification. The test refuses hosted backend URLs and leaves its fixture and logs for inspection. Override `DRIVEOS_TEST_URL`, `DRIVEOS_TEST_SITE_URL`, or `DRIVEOS_TEST_DIRECTORY` when needed. A configured local email sender is unnecessary.

Additional checks use the same disposable, auth-configured loopback backend:

```bash
npm run test:local:auth
npm run test:local:recovery
npm run test:local:watch
npm run test:local:watch-review
```

`test:local:auth` runs `node scripts/test-local-auth.mjs`: it checks invitation recipient/workspace matching, token replacement and consumption, member validation, returning accounts, and viewer credential restrictions. `test:local:recovery` runs `node scripts/test-local-recovery.mjs`: it interrupts real agent operations and checks lease recovery against synthetic files. Build the shared library and agent before running the recovery script. Both scripts leave evidence outside the repository and refuse hosted backend URLs; the recovery suite waits for lease expiration unless an explicitly configured disposable local expiry fixture is provided.

`test:local:watch` checks a real watcher running alongside a manual scan. It waits for normal one-minute batches and verifies cache preservation, deletion and legacy receipt reconciliation, pause/resume, identical-file recreation, disconnected-root protection, active query limits, and duplicate/cleanup analysis invalidation and refresh. It requires the disposable local backend and leaves its synthetic files, logs, and result summary outside the repository.

`test:local:watch-review` checks two agent homes scanning the same folder path, receipts from overlapping scan roots, deletion of newly indexed files discovered through another scanner's cache, and machine-scoped drive removal. It also uses synthetic files and the disposable loopback backend.

`npm run test:local:analysis-race` checks a catalog deletion during automatic analysis and the real scheduled follow-up. It requires `DRIVEOS_AUTO_ANALYSIS=true` on the disposable backend, the guarded `scripts/fixtures/qaAnalysisRace.ts.template` copied into that backend's `convex/qaAnalysisRace.ts`, and `DRIVEOS_TEST_ANALYSIS_FIXTURE` set to that local app's directory. The helper advances only the isolated QA workspace's clock so the test can verify the daily scheduling interval and execute the follow-up without waiting a day. Never copy the helper into production Convex sources.

Dashboard file operations are queued for the connected machine. Run the local agent's `sync` or `run-jobs` command to process them. Manual duplicate/cleanup analysis has a five-minute cooldown and a default 250,000-file bound (`DRIVEOS_MANUAL_ANALYSIS_MAX_FILES`, maximum 1,000,000); automatic full-catalog analysis remains disabled unless explicitly configured. Cloud account linking, custom templates/classification, and notification delivery are shown as unavailable instead of simulating success.

### Coordinated rollout

Deploy the matching web dashboard, Convex backend, and updated agents together. Newly queued jobs require the lease protocol (`leaseRequired`); old agents cannot claim them. A web-only deployment does not provide the backend or agent changes.

Older jobs already marked running without a claim token require manual review. Stop the old agent and inspect the physical files and existing job state before deciding how to recover them; age alone does not prove the old process has stopped. Preserve the original agent home and journals during the upgrade. This change has been tested locally; no production backend or agent deployment was performed as part of the fixes.

Legacy accounts with an existing matching `teamMemberId` keep workspace access even when their user row lacks `tenantId`. The optional internal `tenants:backfillLinkedUserTenants` migration persists that tenant from the stored member ID. An explicit tenant or email conflict remains denied; email lookup never grants membership.
