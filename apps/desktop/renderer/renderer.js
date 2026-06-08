// Renderer logic. Talks to main via the `driveos` bridge exposed in preload.
const $ = (id) => document.getElementById(id);
const api = window.driveos;

function setMsg(el, text, kind) {
  el.textContent = text || "";
  el.className = "msg" + (kind ? " " + kind : "");
}

function showView(connected) {
  $("connect-view").classList.toggle("hidden", connected);
  $("status-view").classList.toggle("hidden", !connected);
  const pill = $("pill");
  pill.textContent = connected ? "Connected" : "Not connected";
  pill.className = "pill " + (connected ? "on" : "off");
}

function fmtTime(iso) {
  if (!iso) return "never";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

async function refresh() {
  let s;
  try { s = await api.status(); } catch { s = { connected: false, paused: false, scanRoots: [] }; }
  showView(s.connected);

  if (s.connected) {
    $("s-state").textContent = s.paused ? "Paused" : "Running";
    $("s-state").style.color = s.paused ? "var(--warn)" : "var(--ok)";
    $("s-last").textContent = fmtTime(s.lastSyncCompletedAt);
    $("s-files").textContent = s.lastSyncFiles != null ? String(s.lastSyncFiles) : "—";
    $("s-machine").textContent = s.machineName || "—";
    $("pause-btn").textContent = s.paused ? "Resume" : "Pause";

    const roots = $("roots");
    roots.innerHTML = "";
    (s.scanRoots && s.scanRoots.length ? s.scanRoots : ["No folders tracked yet"]).forEach((r) => {
      const li = document.createElement("li");
      li.textContent = r;
      roots.appendChild(li);
    });
  } else {
    // Prefill backend URL if the agent already knows it.
    if (s.convexUrl && !$("url").value) $("url").value = s.convexUrl;
  }
}

// ---- Connect ----
$("connect-btn").addEventListener("click", async () => {
  const token = $("token").value.trim();
  const machine = $("machine").value.trim();
  const convexUrl = $("url").value.trim();
  if (!token || !machine) { setMsg($("connect-msg"), "Enter both a machine name and a token.", "err"); return; }
  setMsg($("connect-msg"), "Connecting…");
  const r = await api.connect({ token, machine, convexUrl });
  setMsg($("connect-msg"), r.message, r.ok ? "ok" : "err");
  if (r.ok) setTimeout(refresh, 600);
});
$("open-dash").addEventListener("click", () => {
  const url = $("url").value.trim() || "https://dashboard.convex.dev";
  api.openDashboard(url);
});

// ---- Status actions ----
$("scan-btn").addEventListener("click", async () => {
  $("scan-btn").disabled = true; $("scan-btn").textContent = "Scanning…";
  await api.scanNow();
  $("scan-btn").disabled = false; $("scan-btn").textContent = "Scan Now";
  refresh();
});
$("pause-btn").addEventListener("click", async () => {
  const s = await api.status();
  if (s.paused) await api.resume(); else await api.pause();
  refresh();
});
$("adddrive-btn").addEventListener("click", async () => {
  await api.addDrive({});
  refresh();
});
$("autolaunch").addEventListener("change", async (e) => {
  await api.setAutoLaunch(e.target.checked);
});

// ---- Live logs ----
function renderLogs(lines) {
  const el = $("log");
  el.textContent = (lines || []).join("\n");
  el.scrollTop = el.scrollHeight;
}
api.onLog(renderLogs);

// ---- Init ----
(async () => {
  try { $("autolaunch").checked = await api.getAutoLaunch(); } catch {}
  await refresh();
  try { renderLogs(await api.logs()); } catch {}
  setInterval(refresh, 30_000);
})();
