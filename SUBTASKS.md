1. Do this first — blocks all end-to-end testing.

Three configs point at two different Convex deployments:

apps/web/.env.local → NEXT_PUBLIC_CONVEX_URL = determined-anaconda-827
root .env.local → nautical-giraffe-891
driveos-config.json → determined-anaconda-827

Do:

Decide the single source-of-truth Convex deployment for driveos.
Point web (NEXT_PUBLIC_CONVEX_URL), agent (convexUrl + CONVEX_SITE_URL for the HTTP API), and root env at that one deployment.
Add driveos-config.json + local state files to .gitignore (machine-specific; currently committed).
Re-seed if needed: npx convex dev --run seed:seed.
Smoke test: agent scan → metadata shows in the same dashboard the web app reads.


2. Make the dashboard read/write — wire actions to Convex


The UI renders but action buttons only fire toast() — no mutations run. The dashboard is currently read-only.

Do:

Wire Approve cleanup → cleanup.approveJob / cleanup.createJob.
Wire Quarantine duplicate → cleanup mutation.
Wire Create project wizard → projects.create.
Wire Restore (Quarantine screen) → cleanup.markQuarantineRestored flow.
Add useQuery(api.files.list) + useQuery(api.scans.list) so Files + Scan History show live data.
Remove hardcoded fallbacks masking missing data (e.g. dupTB || 0.42, cleanTB || 0.61).

Key file: apps/web/src/app/page.tsx.


3.  Today scan is one-shot and watch is a live event watcher. We want careful, batched updates — not constant streaming.

Do:

Add an hourly scheduled scan/sync with a local change-queue that batches metadata and uploads once per cycle.
Keep a manual "Scan Now" that flushes immediately.
Add pause / resume (confirm it survives restart).
Ensure no constant filesystem-event uploads (replace/guard the watch streaming path).

Key file: apps/agent/src/index.ts.

4. Agent: cloud-sync safety guardrails (iCloud/Dropbox/GDrive)


Do:

Move agent local state (config, hash cache, offline log) out of the current working directory into the OS app-data dir (~/Library/Application Support/DriveOS / ~/.config/driveos). Never inside a cloud-synced folder.
Detect known cloud-sync paths (iCloud ~/Library/Mobile Documents/com~apple~CloudDocs, ~/Dropbox, ~/Google Drive / ~/Library/CloudStorage) and warn before scanning/initializing them. Treat cloud folders as metadata-tracked, not normal drives, unless explicitly enabled.
Add a "file still being written" stability check (size stable across 2 stats N seconds apart) before hashing/uploading.
Don't generate thousands of tiny files inside cloud folders.

Key file: apps/agent/src/index.ts (local-state paths near top of file; walkFiles / scan path).


5. Auto-run analysis after a scan (duplicates + recommendations)


runDuplicateDetection and generateRecommendations exist but are manual — nothing triggers them after a scan, so the dashboard's Duplicates / Cleanup stay stale.

Do:

After scans.complete, trigger duplicates.runDuplicateDetection + recommendations.generateRecommendations — via a Convex scheduled action (ctx.scheduler) post-scan hook, or an extra agent call after completeScan.
Keep it batched / once-per-cycle — don't run on every file.

Files: convex/scans.ts, convex/duplicates.ts, convex/recommendations.ts.