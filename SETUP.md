# DriveOS — Setup Guide

Everything needed to set up, run, and verify DriveOS locally, plus what each
subtask expects you to have in place. Start at the top and work down.

> **Status legend:** ✅ done · ⏳ pending (your call / future subtask) · ⚠️ heads-up

---

## 1. Prerequisites (one time)

| Need | Why | Status |
|------|-----|--------|
| **Node.js 18+ and npm** | Builds the agent, web app, and Convex codegen. Check with `node -v`. | ⏳ verify |
| **A Convex account (Google login)** | Hosts the real-time metadata backend. Already logged in on this machine. | ✅ |
| **Git** | Repo is already a git repo. | ✅ |
| **Vercel account** | Only needed when you deploy the web dashboard to the cloud. Not needed for local dev. | ⏳ later |

---

## 2. The single source-of-truth deployment

**Deployment: `determined-anaconda-827` (yours).** All three consumers point at it.

| Consumer | File | Key |
|----------|------|-----|
| Web dashboard | `apps/web/.env.local` | `NEXT_PUBLIC_CONVEX_URL=https://determined-anaconda-827.convex.cloud` |
| Root / agent | `.env.local` | `CONVEX_DEPLOYMENT`, `NEXT_PUBLIC_CONVEX_URL`, `CONVEX_SITE_URL` |
| Agent fallback | `apps/agent/src/index.ts` | hardcoded default matches the above |

⚠️ **`.env.local` files are gitignored** (machine-specific). They will NOT travel
with the repo — anyone cloning fresh must recreate them. The exact contents are
documented in §6 below so they can be regenerated.

⚠️ **Never point these at someone else's deployment.** `determined-anaconda-827`
is the one tied to the Google account on this machine. If you ever switch
deployments, update **all three** places above + re-seed.

---

## 3. First-time install & build

Run from the repo root (`c:\Users\Steven\my-projects\driveos`):

```powershell
npm install                              # installs web, agent, shared, convex
npm run build --workspace=packages/shared
npm run build --workspace=apps/agent     # compiles the CLI to apps/agent/dist
```

✅ Both packages currently build clean.

---

## 4. Running the stack locally

Open separate terminals (or use the root scripts):

```powershell
# 1. Convex (schema push + codegen + live backend). Interactive the first time.
npx convex dev

# 2. Web dashboard  -> http://localhost:3000
npm run dev:web

# 3. Agent (already built). Configure once, then scan.
node apps/agent/dist/index.js init --machine "Steven-Win-Test" --owner "steven" --roots "./temp_test_drive"
node apps/agent/dist/index.js scan --path "./temp_test_drive"
```

After a scan, the metadata appears in the dashboard (same deployment).

---

## 5. Agent CLI commands (reference)

| Command | What it does |
|---------|--------------|
| `init` | Write agent config to the OS app-data dir (not a cloud folder). |
| `install-drive --path <dir>` | Drop `.driveos/` scan+watch hooks into a mounted drive. |
| `scan --path <dir>` | One-shot recursive scan of files >1MB → upload metadata. |
| `watch --path <dir>` | Queue folder changes, upload in safe batches. |
| `create-project` | Build the standard folder tree + write `project_manifest.json`. |
| `run-jobs` | Poll Convex for approved cleanup/folder jobs and execute them. |
| `quarantine` / `restore` | Move-not-delete a file to the reversible buffer / restore it. |
| `manifest` | Generate an archive manifest for a project root. |

Agent state lives in `%APPDATA%\DriveOS Agent\` (config, hash cache, quarantine,
offline log). ✅ Confirmed outside iCloud/Dropbox/Drive.

---

## 6. Recreating the env files (if they go missing)

`apps/web/.env.local`:
```
NEXT_PUBLIC_CONVEX_URL=https://determined-anaconda-827.convex.cloud
```

`.env.local` (root):
```
CONVEX_DEPLOYMENT=determined-anaconda-827
NEXT_PUBLIC_CONVEX_URL=https://determined-anaconda-827.convex.cloud
CONVEX_SITE_URL=https://determined-anaconda-827.convex.site
```

---

## 7. Seeding (optional)

The deployment already holds prior precheck/seed data. To load the full demo
dataset (⚠️ may overwrite existing rows):

```powershell
npx convex run seed:seed
```

Decide before running — skip if you want to keep current data.

---

## 8. What each subtask expects to be set up

### ✅ Subtask 1 — Unify Convex deployment (DONE)
- Single deployment chosen: `determined-anaconda-827`.
- Web + agent + root env all point at it (§2).
- Local state files already in `.gitignore`.
- Smoke test passed: `agent scan` → 3 files + drive verified in Convex.

### ⏳ Subtask 2 — Wire dashboard write actions to Convex
**Needs:** running Convex + web (§4). The mutations already exist in `convex/`
(`cleanup:*`, `duplicates:*`, `projects:*`). Work is in `apps/web/` — replace
`toast()`-only handlers with `useMutation` calls; add `useQuery` for the files
list + scan history.

### ⏳ Subtask 3 — Hourly / scheduled sync
**Needs:** the agent built (§3). Add an hourly batch loop + manual "Scan Now" +
pause/resume on top of the existing one-shot `scan` / live `watch`. No new
accounts. Goal: don't spam Convex.

### ⏳ Subtask 4 — Cloud-sync safety
**Needs:** nothing external. Add iCloud/Dropbox/Google Drive folder
detection + warning, and a "file still being written" stability check. App data
already lives in `%APPDATA%` (good).

### ⏳ Subtask 5 — Auto-trigger analysis after scan
**Needs:** Convex running. After `completeScan`, automatically run
`runDuplicateDetection` + `generateRecommendations` (currently manual mutations).

### ⏳ Subtask 6 — Non-technical installer
**Needs:** a packaging choice (e.g. pkg/electron/MSI). Goal: editors install
without Node + npm + build steps.

### ⏳ Subtask 7 — Auth
**Needs:** an auth decision. Dashboard is open; HTTP endpoints accept an
`authToken` but never validate it. Pick an approach (Convex Auth / Clerk /
shared secret) before wiring.

### ⏳ Known small bugs
- TB unit bug in recommendation text.
- `uploadBatch` `by_drive` edge case.

---

## 9. Local end-to-end test checklist (run before marking MVP done)

1. ✅ Run the Next.js dashboard.
2. ✅ Run Convex.
3. ✅ Build/run the agent.
4. ✅ Connect agent → backend.
5. ✅ Scan a test drive/folder.
6. ✅ Confirm metadata appears in the dashboard.
7. ⏳ Add files, confirm they appear after the scheduled/manual update. *(needs Subtask 3)*
8. ⏳ Confirm Convex isn't spammed with constant updates. *(needs Subtask 3)*
9. ✅ Confirm app data is NOT inside iCloud/Drive/Dropbox.
10. ⏳ Confirm folder creation works for a new YouTube show. *(test `create-project`)*
11. ⏳ Confirm disconnected drives handled safely (last-known catalog shown).
