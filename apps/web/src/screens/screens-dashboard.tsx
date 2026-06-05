import React from "react";
import { DB } from "@/data";
import {
  Icon,
  fmtTB,
  fmtGB,
  pct,
  fmtNum,
  STATUS_META,
  RISK_META,
  PROJ_STATUS,
  TIER_META,
  tierKind,
  Avatar,
  Badge,
  StatusBadge,
  RiskBadge,
  Bar,
  MultiBar,
  Donut,
  HealthRing,
  Sparkline,
  MiniBars,
  Treemap,
  StatCard,
  Check,
  Seg,
  FileTypePill,
  FT_ICON,
  Modal,
  SectionTitle,
  Legend,
  PageHead,
  cardShell,
  getVar
} from "@/components";
const h = React.createElement;



/* ============================================================
   DriveOS — Dashboard (Storage Command Center)
   ============================================================ */


function miniStat(label, value, color) {
  return h("div", { style: { background: "var(--bg-surface)", border: "1px solid var(--line)", borderRadius: "var(--r-sm)", padding: "9px 11px" } },
    h("div", { className: "row", style: { gap: 6, marginBottom: 3 } },
      h("span", { style: { width: 7, height: 7, borderRadius: 2, background: color, flexShrink: 0 } }),
      h("span", { style: { fontSize: 10.5, color: "var(--tx-dim)", fontFamily: "var(--font-mono)", letterSpacing: ".02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, label)),
    h("div", { className: "stat-num", style: { fontSize: 16 } }, value));
}
function recoverTile(label, value, icon, color, onClick) {
  return h("div", { onClick, style: { flex: 1, background: "var(--bg-surface)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "12px 13px", cursor: "pointer", transition: "border-color .12s" },
    onMouseEnter: (e) => (e.currentTarget.style.borderColor = "var(--line-strong)"), onMouseLeave: (e) => (e.currentTarget.style.borderColor = "var(--line)") },
    h("div", { className: "row", style: { gap: 7, marginBottom: 7 } },
      h(Icon, { name: icon, size: 14, style: { color } }),
      h("span", { style: { fontSize: 11, color: "var(--tx-mut)" } }, label)),
    h("div", { className: "stat-num", style: { fontSize: 19 } }, value));
}
function drivePips(drives) {
  return drives.slice(0, 10).map((d, i) => h("span", { key: i, title: d.name,
    style: { width: 7, height: 14, borderRadius: 2, background: d.status === "online" ? "var(--ok)" : d.status === "cloud" ? "var(--cloud)" : d.status === "uninit" ? "var(--warn)" : "var(--tx-faint)" } }));
}

// ---- KPI strip ----
function KpiStrip() {
  
  return h("div", { style: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "var(--gap)" } },
    h(StatCard, { label: "Total Tracked", value: "74.8", unit: "TB", icon: "database", accent: "var(--accent-hi)",
      spark: h(Sparkline, { data: [68, 70, 69, 72, 73, 74, 74.8], width: 999, height: 30, color: "var(--accent-hi)" }), sub: "Across hot · warm · cloud · cold" }),
    h(StatCard, { label: "Safe Cleanup", value: "8.6", unit: "TB", icon: "broom", accent: "var(--ok)",
      spark: h(Bar, { value: 8.6, max: 74.8, kind: "ok", height: 7 }), sub: "Recoverable across 8 categories" }),
    h(StatCard, { label: "Exact Duplicates", value: "4.2", unit: "TB", icon: "copy", accent: "var(--warn)",
      spark: h(Bar, { value: 4.2, max: 74.8, kind: "warn", height: 7 }), sub: "1,240 clusters · 5 risk-flagged" }),
    h(StatCard, { label: "Drives", value: "6", unit: "online", icon: "hdd", accent: "var(--cloud)",
      spark: h("div", { className: "row", style: { gap: 6 } }, drivePips(DB.drives)), sub: "9 offline · 1 not initialized" }));
}

// ---- Health card ----
function HealthCard() {
  const k = DB.kpi;
  return h("div", { className: "card card-pad fade-up", style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 14 } },
    h("div", { className: "spread", style: { width: "100%" } },
      h("div", { className: "eyebrow" }, "Storage Health"),
      h(Badge, { kind: "warn", icon: "activity" }, "+4 this week")),
    h(HealthRing, { score: k.health, size: 156 }),
    h("div", { style: { fontSize: 12.5, color: "var(--tx-mut)", textAlign: "center", maxWidth: 220 } },
      "Pulled down by ", h("b", { style: { color: "var(--risk)" } }, "1 full drive"), " and ", h("b", { style: { color: "var(--warn)" } }, "4.2 TB duplicates"), "."),
    h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, width: "100%" } },
      miniStat("Proxies / Cache", "2.9 TB", "var(--ft-proxy)"),
      miniStat("Old Review Exports", "1.5 TB", "var(--ft-export)")));
}

// ---- Storage map ----
function StorageMapCard({ go }) {
  
  const ftData = DB.fileTypes.map((f) => ({ label: f.label, value: f.tb, color: getVar(f.color) }));
  const legend = h("div", { style: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "8px 18px" } },
    ftData.map((d, i) => h("div", { key: i, className: "row", style: { gap: 7, fontSize: 11.5, minWidth: 0 } },
      h("span", { style: { width: 8, height: 8, borderRadius: 2, background: d.color, flexShrink: 0 } }),
      h("span", { style: { color: "var(--tx-mut)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, d.label),
      h("span", { className: "mono", style: { marginLeft: "auto", color: "var(--tx)", flexShrink: 0 } }, fmtTB(d.value)))));
  const body = h("div", { className: "card-pad", style: { flex: 1, display: "flex", flexDirection: "column", gap: 16 } },
    h(Treemap, { data: ftData, height: 168, onClick: () => go("drives") }), legend);
  return cardShell("Storage Map — by file type", "map", "var(--tx-mut)", h(Badge, { square: true }, "74.8 TB total"), body);
}

// ---- Tiers ----
function TiersCard() {
  
  const tierData = DB.tiers.map((t) => ({ label: t.label, value: t.usedTB, color: getVar(t.color) }));
  const rows = DB.tiers.map((t) => h("div", { key: t.key },
    h("div", { className: "spread", style: { fontSize: 12, marginBottom: 4 } },
      h("span", { className: "row", style: { gap: 7 } }, h("span", { style: { width: 8, height: 8, borderRadius: 2, background: getVar(t.color) } }), h("span", { className: "hi", style: { fontWeight: 600 } }, TIER_META[t.key].label)),
      h("span", { className: "mono dim", style: { fontSize: 11 } }, fmtTB(t.usedTB) + " / " + t.capTB + " TB")),
    h(Bar, { value: t.usedTB, max: t.capTB, kind: tierKind(pct(t.usedTB, t.capTB)), height: 5 })));
  const body = h("div", { className: "card-pad", style: { display: "flex", gap: 18, alignItems: "center" } },
    h(Donut, { data: tierData, size: 132, thickness: 18 },
      h("div", { className: "stat-num", style: { fontSize: 19 } }, "74.8"),
      h("div", { style: { fontSize: 9.5, color: "var(--tx-dim)", fontFamily: "var(--font-mono)" } }, "TB USED")),
    h("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 11 } }, rows));
  return cardShell("Storage Tiers", "layers", "var(--tx-mut)", null, body);
}

// ---- Cloud mini ----
function CloudMiniCard({ go }) {
  const right = h("button", { className: "btn sm ghost", onClick: () => go("cloud") }, "Open", h(Icon, { name: "chevR", size: 13 }));
  const body = h("div", { className: "card-pad", style: { display: "flex", flexDirection: "column", gap: 14 } },
    h("div", { className: "spread", style: { alignItems: "flex-end" } },
      h("div", null, h("div", { className: "stat-num", style: { fontSize: 28 } }, "13.4", h("span", { style: { fontSize: 14, color: "var(--tx-mut)", fontWeight: 600 } }, " / 20 TB")),
        h("div", { style: { fontSize: 12, color: "var(--tx-mut)", marginTop: 2 } }, "Google Workspace · studio@driveos.media")),
      h(Badge, { kind: "cloud" }, "67% used")),
    h(Bar, { value: 13.4, max: 20, kind: "cloud", height: 9 }),
    h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 } },
      miniStat("Cloud projects", "4", "var(--cloud)"),
      miniStat("Local only", "956 GB", "var(--warn)"),
      miniStat("Cloud dupes", "1.1 TB", "var(--auto)")));
  return cardShell("Cloud Storage", "cloud", "var(--cloud)", right, body);
}

// ---- Offenders ----
function OffendersCard({ go }) {
  const offenders = [...DB.projects].sort((a, b) => b.sizeTB - a.sizeTB).slice(0, 5);
  const rows = offenders.map((p) => h("div", { key: p.id, onClick: () => go("project", { id: p.id }), className: "offender-row", style: { padding: "9px 18px", cursor: "pointer" } },
    h("div", { style: { flex: 1, minWidth: 0 } },
      h("div", { className: "spread", style: { marginBottom: 5 } },
        h("span", { className: "hi", style: { fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, p.name),
        h("span", { className: "mono", style: { fontSize: 12, color: "var(--tx-hi)", flexShrink: 0, marginLeft: 8 } }, fmtTB(p.sizeTB))),
      h(Bar, { value: p.sizeTB, max: offenders[0].sizeTB, kind: "", height: 5 }))));
  const right = h("button", { className: "btn sm ghost", onClick: () => go("projects") }, "All projects");
  return cardShell("Biggest Storage Offenders", "barChart", "var(--tx-mut)", right, h("div", { style: { padding: "6px 0" } }, rows));
}

// ---- Duplicate & cleanup ----
function DupCleanupCard({ go }) {
  return h("div", { className: "card card-pad fade-up", style: { display: "flex", flexDirection: "column", gap: 14 } },
    h("div", { className: "spread" }, h("div", { className: "card-title" }, "Duplicate & Cleanup"),
      h(Badge, { kind: "ok", icon: "shieldCheck" }, "Safe to recover")),
    h("div", { className: "spread", style: { gap: 10 } },
      recoverTile("Exact duplicates", "4.2 TB", "copy", "var(--warn)", () => go("duplicates")),
      recoverTile("Proxies / cache", "2.9 TB", "cpu", "var(--ft-proxy)", () => go("cleanup"))),
    h("div", { className: "spread", style: { gap: 10 } },
      recoverTile("Old review exports", "1.5 TB", "download", "var(--ft-export)", () => go("cleanup")),
      recoverTile("Duplicate stock", "1.1 TB", "globe", "var(--ft-stock)", () => go("duplicates"))),
    h("button", { className: "btn primary", style: { width: "100%" }, onClick: () => go("cleanup") },
      h(Icon, { name: "broom", size: 15 }), "Recover 8.6 TB safely"));
}

// ---- Ready to archive ----
function ReadyArchiveCard({ go }) {
  const list = DB.projects.filter((p) => p.status === "ready" || p.archiveReady >= 80);
  const rows = list.map((p) => h("div", { key: p.id, className: "offender-row spread", onClick: () => go("project", { id: p.id }), style: { padding: "10px 18px", cursor: "pointer" } },
    h("div", { style: { minWidth: 0 } },
      h("div", { className: "hi", style: { fontWeight: 600, fontSize: 13 } }, p.name),
      h("div", { className: "muted", style: { fontSize: 11.5, marginTop: 1 } }, p.client + " · " + fmtTB(p.sizeTB))),
    h("div", { className: "row", style: { gap: 10, flexShrink: 0 } },
      h("div", { style: { width: 54 } }, h(Bar, { value: p.archiveReady, max: 100, kind: p.archiveReady >= 90 ? "ok" : "warn", height: 5 })),
      h("span", { className: "mono", style: { fontSize: 11, color: "var(--tx-mut)", width: 32, textAlign: "right" } }, p.archiveReady + "%"))));
  return cardShell("Ready to Archive", "archive", "var(--auto)", h(Badge, { kind: "auto" }, list.length + " projects"), h("div", { style: { padding: "6px 0" } }, rows));
}

// ---- Team storage ----
function TeamCard() {
  const team = DB.team.filter((m) => m.usedTB > 0).sort((a, b) => b.usedTB - a.usedTB);
  const rows = team.map((m) => h("div", { key: m.id, className: "row", style: { padding: "8px 18px", gap: 11 } },
    h(Avatar, { id: m.id, size: 30 }),
    h("div", { style: { flex: 1, minWidth: 0 } },
      h("div", { className: "spread", style: { marginBottom: 4 } },
        h("span", { className: "hi", style: { fontWeight: 600, fontSize: 12.5 } }, m.name),
        h("span", { className: "mono dim", style: { fontSize: 11 } }, fmtTB(m.usedTB) + " · " + m.drives + " drives")),
      h(Bar, { value: m.usedTB, max: 22, kind: "", height: 5 }))));
  return cardShell("Team Storage Usage", "users", "var(--tx-mut)", null, h("div", { style: { padding: "6px 0" } }, rows));
}

// ---- Right rail ----
function WarningCard({ w, go, toast }) {
  const handle = () => {
    const [type, id] = w.target.split(":");
    if (type === "drive") go("drive", { id });
    else if (type === "project") go("project", { id });
    else toast(w.action + " started", "zap", "accent");
  };
  return h("div", { style: { padding: 12, borderRadius: "var(--r)", background: "var(--" + w.risk + "-soft)", border: "1px solid var(--" + w.risk + "-line)" } },
    h("div", { className: "row", style: { gap: 8, alignItems: "flex-start" } },
      h(Icon, { name: w.risk === "risk" ? "alert" : "warn", size: 15, style: { color: "var(--" + w.risk + ")", marginTop: 1, flexShrink: 0 } }),
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { className: "hi", style: { fontWeight: 600, fontSize: 12.5, lineHeight: 1.3 } }, w.title),
        h("div", { style: { fontSize: 11.5, color: "var(--tx-mut)", marginTop: 4, lineHeight: 1.4 } }, w.detail),
        h("button", { className: "btn sm " + (w.risk === "risk" ? "danger" : ""), style: { marginTop: 9 }, onClick: handle },
          w.action, h(Icon, { name: "arrowR", size: 13 })))));
}

function WarningsRail({ go, toast }) {
  
  const body = h("div", { style: { padding: 12, display: "flex", flexDirection: "column", gap: 8, maxHeight: 440, overflowY: "auto" } },
    DB.warnings.map((w) => h(WarningCard, { key: w.id, w, go, toast })));
  return cardShell("Active Warnings", "alert", "var(--risk)", h(Badge, { kind: "risk" }, DB.warnings.length), body);
}

function ActivityRail({ go }) {
  
  const rows = DB.driveEvents.map((e, i) => {
    const d = DB.driveById[e.drive];
    const meta = ({ connected: ["ok", "checkCircle"], scan: ["accent", "refresh"], offline: ["", "x"], cloud: ["cloud", "cloud"] })[e.event] || ["", "hdd"];
    const bg = meta[0] ? "var(--" + (meta[0] === "accent" ? "accent" : meta[0]) + "-soft)" : "var(--bg-surface)";
    const fg = meta[0] ? "var(--" + (meta[0] === "accent" ? "accent-hi" : meta[0]) + ")" : "var(--tx-dim)";
    return h("div", { key: i, className: "row", onClick: () => go("drive", { id: e.drive }),
      style: { padding: "10px 16px", gap: 11, cursor: "pointer", borderBottom: i < DB.driveEvents.length - 1 ? "1px solid var(--line-faint)" : "none" } },
      h("div", { style: { width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", flexShrink: 0, background: bg, color: fg, border: "1px solid var(--line)" } },
        h(Icon, { name: meta[1], size: 15 })),
      h("div", { style: { flex: 1, minWidth: 0 } },
        h("div", { className: "hi", style: { fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, d.name),
        h("div", { className: "muted", style: { fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, e.detail)),
      h("span", { className: "mono dim", style: { fontSize: 10.5, flexShrink: 0 } }, e.time));
  });
  return cardShell("Recent Drive Activity", "activity", "var(--tx-mut)", null, h("div", { style: { padding: "6px 0" } }, rows));
}

// ============================================================
function Dashboard({ go, toast }) {
  const actions = [
    { label: "Scan Drive", icon: "refresh", onClick: () => toast("Scan started on CJ Working SSD", "refresh", "accent") },
    { label: "Create Project", icon: "plus", primary: true, onClick: () => go("wizard") },
    { label: "Review Duplicates", icon: "copy", onClick: () => go("duplicates") },
    { label: "Clean Up Safely", icon: "broom", onClick: () => go("cleanup") },
    { label: "Archive Project", icon: "archive", onClick: () => go("archive") },
  ];

  return h("div", { className: "page-inner" },
    h("div", { className: "page-head" },
      h("div", null,
        h("div", { className: "eyebrow", style: { marginBottom: 6 } }, "Mission Control"),
        h("div", { className: "page-title" }, "Storage Command Center"),
        h("div", { className: "page-desc" }, "Studio-wide storage health across ", h("b", { className: "hi" }, "15 drives"), ", ", h("b", { className: "hi" }, "7 projects"), " and ", h("b", { className: "hi" }, "Google Workspace"), ". Agents reporting live.")),
      h("div", { className: "page-head-actions" },
        h("button", { className: "btn", onClick: actions[0].onClick }, h(Icon, { name: "refresh", size: 15 }), "Scan Drive"),
        h("button", { className: "btn primary", onClick: () => go("wizard") }, h(Icon, { name: "plus", size: 16 }), "Create Project"))),

    h("div", { className: "card card-pad", style: { display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap", alignItems: "center" } },
      h("div", { className: "eyebrow", style: { marginRight: 4 } }, "Quick Actions"),
      actions.map((a) => h("button", { key: a.label, className: "btn " + (a.primary ? "primary" : ""), onClick: a.onClick },
        h(Icon, { name: a.icon, size: 15 }), a.label))),

    h("div", { style: { display: "grid", gridTemplateColumns: "1fr 332px", gap: "var(--gap)", alignItems: "start" } },
      h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--gap)", minWidth: 0 } },
        h(KpiStrip),
        h("div", { style: { display: "grid", gridTemplateColumns: "300px 1fr", gap: "var(--gap)" } }, h(HealthCard), h(StorageMapCard, { go })),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--gap)" } }, h(TiersCard), h(CloudMiniCard, { go })),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--gap)" } }, h(OffendersCard, { go }), h(DupCleanupCard, { go })),
        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--gap)" } }, h(ReadyArchiveCard, { go }), h(TeamCard))),
      h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--gap)" } }, h(WarningsRail, { go, toast }), h(ActivityRail, { go }))));
}

export { Dashboard };
