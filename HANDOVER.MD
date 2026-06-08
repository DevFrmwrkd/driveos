DriveOS — Developer Handoff (Steven)

You're taking over DriveOS. An agent-built prototype already exists in the studio-files repo. Your job: finish it into a safe, installable MVP. Read this whole task, then work the subtasks in order — the first one is a blocker for end-to-end testing.

In a nutshell

DriveOS is a storage command center for our video team. A local app on each editor's computer scans connected hard drives, tracks big files, detects duplicates, and helps create clean project folders. It sends only metadata to a web dashboard — never the actual footage.

The dashboard shows: which drives are full, which projects use the most space, where duplicates are, what's safe to clean, which files are risky (exist only once), which projects are ready to archive, and which editors/drives need cleanup.

The goal is NOT instant file syncing. It's a reliable overview that updates carefully — about once per hour — so we understand storage without overloading Convex or breaking local/cloud sync.

Architecture (monorepo)

apps/agent/ — Node.js/TypeScript CLI agent on editors' machines (scans drives, uploads metadata, runs jobs).
apps/web/ — Next.js (App Router) dashboard, deployed on Vercel.
packages/shared/ — shared classification rules, risk leveling, health math, types.
convex/ — real-time metadata backend (schema + queries/mutations + HTTP API).
Repo: /Volumes/SSD/New Coding Projects/studio-files · Vercel project driveos · Convex project driveos.

Current state (audited 2026-06-05)

What's solid:

✅ Convex backend ~95% — full schema (15 tables, indexed); queries/mutations for drives, files (uploadBatch), duplicate detection, projects, scans, cleanup + quarantine state machine, recommendations (6 categories), archive, cloud (metadata), audit; HTTP API router; full seed.
✅ Shared package ~100% — classification engine (17 file categories), risk engine (RED/YELLOW/GREEN), project-health score, passing unit tests.
✅ Agent CLI ~80% — all commands exist and work: init, install-drive, scan (recursive walk, >1MB filter, quick-hash + optional full-hash, batch upload in chunks of 100, hash cache), watch, create-project, run-jobs, quarantine, restore, manifest. Quarantine is move-not-delete (fs.renameSync) and blocks protected classes (RAW, EXPORT_FINAL, PROJECT_FILE, ADMIN, manifests).
✅ Web dashboard ~70% — all 13 screens render with polished UI (Dashboard, Drives, Projects, Duplicates, Cleanup, Quarantine, Cloud, Archive, Search, Settings, Create-Project wizard). Read-wired to Convex via useQuery.

What's missing / broken — this is your work (see subtasks):

⛔ Two different Convex deployments in config. apps/web/.env.local → determined-anaconda-827; root .env.local → nautical-giraffe-891; driveos-config.json → determined-anaconda-827. Nothing works end-to-end until unified. (Subtask 1 — blocker.)
Dashboard is read-only. Approve cleanup, quarantine duplicate, create project, restore — all wired to toast() only, not Convex mutations. Files list + scan history aren't queried. (Subtask 2.)
No hourly/scheduled sync. scan is one-shot, watch is a live event watcher. No hourly batch, no manual "Scan Now" loop, no pause/resume. (Subtask 3.)
No cloud-sync safety. No iCloud/Dropbox/Google Drive folder detection/warning; agent stores config/hash-cache/offline-log in the current working directory (can land inside a cloud folder); no "file still being written" stability check. (Subtask 4.)
Analysis not auto-triggered. runDuplicateDetection + generateRecommendations are manual mutations; nothing runs them after a scan completes. (Subtask 5.)
No non-technical installer. Editors currently need Node + npm + build steps. (Subtask 6.)
No auth. Dashboard is open; HTTP endpoints accept an authToken but never validate it. (Subtask 7.)
Known small bugs filed in the Bugs list (TB unit bug in recommendation text; uploadBatch by_drive edge case).

MVP acceptance criteria (definition of done)

Non-technical editor can install the local app.
Local app connects to the Vercel/Convex backend (login / connect).
Existing hard drive can be initialized; new hard drive can be initialized (owner, location, tier, capacity, used, last-seen).
Files > 1 MB are scanned; metadata appears in the dashboard.
Updates happen hourly or manually, not constantly. Convex is not spammed.
Duplicates visible. Large files visible.
Projects can be created with our standard folder structure (e.g. a new YouTube show).
Cleanup recommendations shown safely. No permanent delete by default (quarantine only).
No cloud-sync-loop behavior. App data is never stored in iCloud/Dropbox/Google Drive.
Local app can be paused. Disconnected drives handled safely (last-known catalog shown).

Non-negotiable safety behavior

Scanner is read-only by default. Never move/rename/delete/rewrite files except on an explicit project-creation or approved cleanup/quarantine action.
No cloud-sync disasters. Never store the local DB/config/cache inside iCloud/Dropbox/Google Drive — use the OS app-data dir. Warn the user if they select a cloud-synced folder. Don't generate thousands of tiny sync files. No constant filesystem-event uploads — local queue + hourly batch.
Skip unstable files. If a file is still being written/changing, skip it until stable.
Quarantine, not delete. Reversible buffer (.driveos_quarantine/YYYY-MM-DD/), 14-day rollback.

Local end-to-end test (run before marking done)

Run the Next.js dashboard. 2. Run Convex. 3. Build/run the agent. 4. Connect agent → backend. 5. Scan a test drive/folder. 6. Confirm metadata appears in the dashboard. 7. Add files, confirm they appear after the scheduled/manual update. 8. Confirm Convex isn't spammed with constant updates. 9. Confirm app data is NOT inside iCloud/Drive/Dropbox. 10. Confirm folder creation works for a new YouTube show. 11. Confirm disconnected drives are handled safely.