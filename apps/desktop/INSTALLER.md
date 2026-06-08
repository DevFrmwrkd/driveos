# DriveOS Agent — Desktop App & Installer

A small **system-tray app** (Electron) that wraps the DriveOS agent so
non-technical editors never touch Node, npm, or a terminal. It bundles the agent
as a single self-contained file and runs all scan/sync/safety logic through the
same well-tested CLI.

## What the editor gets
- A tray icon (menu-bar on macOS, system tray on Windows).
- A window with a plain-language **Connect** screen, then a status dashboard:
  - **Status** (Running / Paused), **Last sync**, **Files last sync**, **Machine**
  - **Scan Now**, **Pause/Resume**, **Add drive…** (folder picker)
  - **Start automatically at login** toggle (auto-launch)
  - Tracked folders list + a live **Recent activity** log (errors in plain text)
- Hourly background sync starts automatically once connected.

## Architecture
- `src/main.ts` — Electron main: tray, window, IPC, runs the hourly `sync` daemon.
- `src/preload.ts` — locked-down IPC bridge (`window.driveos`).
- `src/agentBridge.ts` — runs the agent as a child process and parses its output.
- `renderer/` — the UI (HTML/CSS/JS, no framework).
- The agent is bundled by esbuild into one file (`apps/agent/dist/agent-bundle.cjs`,
  all deps inlined) and shipped under `resources/agent/agent-bundle.cjs`.

## Build (developers)

From the repo root, deps are already installed via npm workspaces. Then:

```bash
# Build the agent bundle + the Electron main/preload
npm run build --workspace=apps/desktop

# Run it locally (dev)
npm run start --workspace=apps/desktop
```

### Package installers

```bash
# Windows (.exe / NSIS)
npm run dist:win --workspace=apps/desktop

# macOS (.dmg + .zip)   <-- run on a Mac
npm run dist:mac --workspace=apps/desktop
```

Output lands in `apps/desktop/release/`.

> **Build each OS on that OS.** electron-builder does not cross-compile reliably.
> Build the Windows installer on Windows and the macOS `.dmg` on a Mac.

### Windows gotcha (symlink privilege)
The first Windows package may fail extracting electron-builder's code-sign cache
with *"Cannot create symbolic link: A required privilege is not held."* Fix once:
- Enable **Settings → Privacy & security → For developers → Developer Mode**, **or**
- Run the `dist:win` command from an **Administrator** terminal once (it caches the tool).

The app itself (`release/win-unpacked/DriveOS Agent.exe`) builds fine regardless;
this only affects wrapping it into the NSIS `.exe` installer.

## Code signing & notarization (before wide distribution)
Unsigned builds trigger Gatekeeper (macOS) and SmartScreen (Windows) warnings.
For an internal team this may be acceptable; for polish:

- **macOS:** set `CSC_LINK` (Developer ID cert .p12) + `CSC_KEY_PASSWORD`, and add
  notarization env (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
- **Windows:** set `CSC_LINK` + `CSC_KEY_PASSWORD` to an Authenticode cert.

See electron-builder docs for the exact env-var contract.

## Editor install + first run
1. Download and install **DriveOS Agent** (`.dmg` on Mac, `.exe` on Windows).
2. Launch it — the window opens on the **Connect** screen.
3. In the DriveOS dashboard, add this machine and copy its **connect token**
   (the dashboard "issue token" UI is the small follow-up noted below).
4. Paste the token + a machine name, click **Connect**.
5. Done — it scans hourly in the background. Use **Scan Now** anytime; **Pause**
   to stop temporarily. Turn on **Start automatically at login**.

## Known follow-ups
- **Dashboard "Add machine / issue token" button** — the backend mutation
  (`agentAuth.issueMachineToken`) exists; a Settings → Machines UI button to call
  it and show the one-time token would complete the loop. (Small.)
- **App icons** — currently a generated placeholder tray icon; drop real
  `build/icon.icns` + `build/icon.ico` for branded installers.
- **Signing/notarization** — see above; required only for friction-free installs.
