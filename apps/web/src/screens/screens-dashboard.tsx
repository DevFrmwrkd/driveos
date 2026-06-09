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
const h: any = React.createElement;

type ScreenProps = Record<string, any>;
type AnyRecord = Record<string, any>;



/* ============================================================
   DriveOS — Dashboard (Storage Command Center)
   ============================================================ */


function miniStat(label: React.ReactNode, value: React.ReactNode, color: string) {
  return h("div", { style: { background: "var(--bg-surface)", border: "1px solid var(--line)", borderRadius: "var(--r-sm)", padding: "9px 11px" } },
    h("div", { className: "row", style: { gap: 6, marginBottom: 3 } },
      h("span", { style: { width: 7, height: 7, borderRadius: 2, background: color, flexShrink: 0 } }),
      h("span", { style: { fontSize: 10.5, color: "var(--tx-dim)", fontFamily: "var(--font-mono)", letterSpacing: ".02em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, label)),
    h("div", { className: "stat-num", style: { fontSize: 16 } }, value));
}
function recoverTile(label: React.ReactNode, value: React.ReactNode, icon: string, color: string, onClick: () => void) {
  return h("div", { onClick, style: { flex: 1, background: "var(--bg-surface)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: "12px 13px", cursor: "pointer", transition: "border-color .12s" },
    onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.borderColor = "var(--line-strong)"), onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.borderColor = "var(--line)") },
    h("div", { className: "row", style: { gap: 7, marginBottom: 7 } },
      h(Icon, { name: icon, size: 14, style: { color } }),
      h("span", { style: { fontSize: 11, color: "var(--tx-mut)" } }, label)),
    h("div", { className: "stat-num", style: { fontSize: 19 } }, value));
}
function drivePips(drives: any[]) {
  return drives.slice(0, 10).map((d: any, i: number) => h("span", { key: i, title: d.name,
    style: { width: 7, height: 14, borderRadius: 2, background: d.status === "online" ? "var(--ok)" : d.status === "cloud" ? "var(--cloud)" : d.status === "uninit" ? "var(--warn)" : "var(--tx-faint)" } }));
}

// Compute all dashboard numbers from the live Convex-backed collections in DB.
function liveStats() {
  const drives = (DB.drives || []) as any[];
  const projects = (DB.projects || []) as any[];
  const duplicates = (DB.duplicates || []) as any[];
  const cleanup = (DB.cleanup || []) as any[];

  const totalTrackedTB = drives.reduce((s: number, d: any) => s + (d.usedTB || 0), 0);
  const safeCleanupTB = cleanup.reduce((s: number, c: any) => s + (c.recoverTB || 0), 0);
  const dupTB = duplicates.reduce((s: number, c: any) => s + ((c.sizeGB || 0) * (c.copies || 1)) / 1024, 0);
  const dupRecoverTB = duplicates.reduce((s: number, c: any) => s + (c.recoverGB || 0) / 1024, 0);

  const online = drives.filter((d: any) => d.status === "online");
  const offline = drives.filter((d: any) => d.status === "offline");
  const uninit = drives.filter((d: any) => d.status === "uninit");

  return {
    drives, projects, duplicates, cleanup,
    totalTrackedTB, safeCleanupTB, dupTB, dupRecoverTB,
    onlineCount: online.length, offlineCount: offline.length, uninitCount: uninit.length,
    clusterCount: duplicates.length,
  };
}

// ---- KPI strip ----
function KpiStrip() {
  const s = liveStats();
  const maxTB = s.totalTrackedTB > 0 ? s.totalTrackedTB : 1;
  return h("div", { style: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "var(--gap)" } },
    h(StatCard, { label: "Total Tracked", value: s.totalTrackedTB.toFixed(1), unit: "TB", icon: "database", accent: "var(--accent-hi)",
      spark: h(Bar, { value: s.totalTrackedTB, max: maxTB, kind: "", height: 7 }), sub: "Across all tracked drives" }),
    h(StatCard, { label: "Safe Cleanup", value: s.safeCleanupTB.toFixed(1), unit: "TB", icon: "broom", accent: "var(--ok)",
      spark: h(Bar, { value: s.safeCleanupTB, max: maxTB, kind: "ok", height: 7 }), sub: "Recoverable from cleanup" }),
    h(StatCard, { label: "Duplicates", value: s.dupTB.toFixed(1), unit: "TB", icon: "copy", accent: "var(--warn)",
      spark: h(Bar, { value: s.dupTB, max: maxTB, kind: "warn", height: 7 }), sub: s.clusterCount + " cluster" + (s.clusterCount === 1 ? "" : "s") }),
    h(StatCard, { label: "Drives", value: String(s.onlineCount), unit: "online", icon: "hdd", accent: "var(--cloud)",
      spark: h("div", { className: "row", style: { gap: 6 } }, drivePips(s.drives)), sub: s.offlineCount + " offline · " + s.uninitCount + " not initialized" }));
}

// ---- Health card ----
function HealthCard() {
  const s = liveStats();
  // Health = how much of capacity is free across tracked drives, lightly
  // penalized by duplicate waste. Falls back to 100 when nothing is tracked.
  const totalCap = s.drives.reduce((a: number, d: any) => a + (d.capTB || 0), 0);
  const totalUsed = s.drives.reduce((a: number, d: any) => a + (d.usedTB || 0), 0);
  const usedRatio = totalCap > 0 ? totalUsed / totalCap : 0;
  const dupPenalty = totalCap > 0 ? Math.min(20, (s.dupTB / totalCap) * 100) : 0;
  const health = s.drives.length === 0 ? 100 : Math.max(0, Math.round((1 - usedRatio) * 100 - dupPenalty));
  const fullDrives = s.drives.filter((d: any) => d.capTB > 0 && d.usedTB / d.capTB >= 0.9).length;

  return h("div", { className: "card card-pad fade-up", style: { display: "flex", flexDirection: "column", alignItems: "center", gap: 14 } },
    h("div", { className: "spread", style: { width: "100%" } },
      h("div", { className: "eyebrow" }, "Storage Health")),
    h(HealthRing, { score: health, size: 156 }),
    h("div", { style: { fontSize: 12.5, color: "var(--tx-mut)", textAlign: "center", maxWidth: 220 } },
      fullDrives > 0
        ? ["Pulled down by ", h("b", { key: 1, style: { color: "var(--risk)" } }, fullDrives + (fullDrives === 1 ? " full drive" : " full drives")), s.dupTB > 0 ? [" and ", h("b", { key: 2, style: { color: "var(--warn)" } }, s.dupTB.toFixed(1) + " TB duplicates")] : "", "."]
        : s.drives.length === 0 ? "No drives tracked yet." : "Storage looks healthy."),
    h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, width: "100%" } },
      miniStat("Duplicates", s.dupTB.toFixed(1) + " TB", "var(--ft-proxy)"),
      miniStat("Safe cleanup", s.safeCleanupTB.toFixed(1) + " TB", "var(--ft-export)")));
}

// ---- Storage map (by drive, from live data) ----
const MAP_COLORS = ["var(--accent-hi)", "var(--cloud)", "var(--ok)", "var(--warn)", "var(--ft-proxy)", "var(--ft-stock)", "var(--auto)", "var(--ft-export)"];
function StorageMapCard({ go }: ScreenProps) {
  const s = liveStats();
  const mapData = [...s.drives]
    .filter((d: any) => (d.usedTB || 0) > 0)
    .sort((a: any, b: any) => (b.usedTB || 0) - (a.usedTB || 0))
    .map((d: any, i: number) => ({ label: d.name || d.label, value: d.usedTB || 0, color: getVar(MAP_COLORS[i % MAP_COLORS.length]) }));

  const legend = h("div", { style: { display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: "8px 18px" } },
    mapData.map((d, i) => h("div", { key: i, className: "row", style: { gap: 7, fontSize: 11.5, minWidth: 0 } },
      h("span", { style: { width: 8, height: 8, borderRadius: 2, background: d.color, flexShrink: 0 } }),
      h("span", { style: { color: "var(--tx-mut)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, d.label),
      h("span", { className: "mono", style: { marginLeft: "auto", color: "var(--tx)", flexShrink: 0 } }, fmtTB(d.value)))));
  const body = mapData.length === 0
    ? h("div", { className: "card-pad empty", style: { padding: "40px 0" } }, h("div", { className: "muted" }, "No drive data yet — run a scan to populate."))
    : h("div", { className: "card-pad", style: { flex: 1, display: "flex", flexDirection: "column", gap: 16 } },
        h(Treemap, { data: mapData, height: 168, onClick: () => go("drives") }), legend);
  return cardShell("Storage Map — by drive", "map", "var(--tx-mut)", h(Badge, { square: true }, s.totalTrackedTB.toFixed(1) + " TB total"), body);
}

// ---- Tiers (grouped from live drives) ----
const TIER_COLORS: Record<string, string> = { hot: "var(--risk)", warm: "var(--warn)", cloud: "var(--cloud)", cold: "var(--auto)" };
function TiersCard() {
  const s = liveStats();
  const tiers = ["hot", "warm", "cloud", "cold"];
  const grouped = tiers.map((key) => {
    const ds = s.drives.filter((d: any) => (d.tier || "hot") === key);
    return {
      key,
      used: ds.reduce((a: number, d: any) => a + (d.usedTB || 0), 0),
      cap: ds.reduce((a: number, d: any) => a + (d.capTB || 0), 0),
      color: TIER_COLORS[key],
    };
  }).filter((t) => t.used > 0 || t.cap > 0);

  const tierData = grouped.map((t) => ({ label: t.key, value: t.used, color: getVar(t.color) }));
  const rows = grouped.map((t) => h("div", { key: t.key },
    h("div", { className: "spread", style: { fontSize: 12, marginBottom: 4 } },
      h("span", { className: "row", style: { gap: 7 } }, h("span", { style: { width: 8, height: 8, borderRadius: 2, background: getVar(t.color) } }), h("span", { className: "hi", style: { fontWeight: 600 } }, (TIER_META[t.key] && TIER_META[t.key].label) || t.key)),
      h("span", { className: "mono dim", style: { fontSize: 11 } }, fmtTB(t.used) + (t.cap > 0 ? " / " + t.cap.toFixed(0) + " TB" : ""))),
    h(Bar, { value: t.used, max: t.cap > 0 ? t.cap : Math.max(t.used, 1), kind: tierKind(pct(t.used, t.cap > 0 ? t.cap : t.used)), height: 5 })));
  const body = grouped.length === 0
    ? h("div", { className: "card-pad empty", style: { padding: "30px 0" } }, h("div", { className: "muted" }, "No tiered drives yet."))
    : h("div", { className: "card-pad", style: { display: "flex", gap: 18, alignItems: "center" } },
        h(Donut, { data: tierData, size: 132, thickness: 18 },
          h("div", { className: "stat-num", style: { fontSize: 19 } }, s.totalTrackedTB.toFixed(1)),
          h("div", { style: { fontSize: 9.5, color: "var(--tx-dim)", fontFamily: "var(--font-mono)" } }, "TB USED")),
        h("div", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 11 } }, rows));
  return cardShell("Storage Tiers", "layers", "var(--tx-mut)", null, body);
}

// ---- Cloud mini (live; empty state when no provider connected) ----
function CloudMiniCard({ go }: ScreenProps) {
  const cloud: any[] = (DB as any).cloudConnections || [];
  const right = h("button", { className: "btn sm ghost", onClick: () => go("cloud") }, "Open", h(Icon, { name: "chevR", size: 13 }));

  if (!cloud.length) {
    const body = h("div", { className: "card-pad empty", style: { padding: "30px 16px", textAlign: "center" } },
      h(Icon, { name: "cloud", size: 22, style: { color: "var(--tx-dim)" } }),
      h("div", { className: "muted", style: { fontSize: 12.5, marginTop: 8 } }, "No cloud provider connected yet."),
      h("button", { className: "btn sm", style: { marginTop: 10 }, onClick: () => go("cloud") }, "Connect a provider"));
    return cardShell("Cloud Storage", "cloud", "var(--cloud)", right, body);
  }

  const c = cloud[0];
  const used = (c.usedBytes || 0) / (1024 ** 4);
  const cap = (c.capacityBytes || 0) / (1024 ** 4);
  const body = h("div", { className: "card-pad", style: { display: "flex", flexDirection: "column", gap: 14 } },
    h("div", { className: "spread", style: { alignItems: "flex-end" } },
      h("div", null, h("div", { className: "stat-num", style: { fontSize: 28 } }, used.toFixed(1), h("span", { style: { fontSize: 14, color: "var(--tx-mut)", fontWeight: 600 } }, " / " + cap.toFixed(0) + " TB")),
        h("div", { style: { fontSize: 12, color: "var(--tx-mut)", marginTop: 2 } }, (c.provider || "Cloud") + (c.account ? " · " + c.account : ""))),
      cap > 0 && h(Badge, { kind: "cloud" }, Math.round((used / cap) * 100) + "% used")),
    h(Bar, { value: used, max: cap > 0 ? cap : Math.max(used, 1), kind: "cloud", height: 9 }));
  return cardShell("Cloud Storage", "cloud", "var(--cloud)", right, body);
}

// ---- Offenders ----
function OffendersCard({ go }: ScreenProps) {
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

// ---- Duplicate & cleanup (live) ----
function DupCleanupCard({ go }: ScreenProps) {
  const s = liveStats();
  // Group cleanup recommendations by category for the tiles.
  const byCat = (cat: string) => s.cleanup.filter((c: any) => c.cat === cat).reduce((a: number, c: any) => a + (c.recoverTB || 0), 0);
  const cacheTB = byCat("Cache");
  const proxyTB = byCat("Proxies");
  const reviewTB = byCat("Review exports");
  const totalSafe = s.safeCleanupTB;

  return h("div", { className: "card card-pad fade-up", style: { display: "flex", flexDirection: "column", gap: 14 } },
    h("div", { className: "spread" }, h("div", { className: "card-title" }, "Duplicate & Cleanup"),
      h(Badge, { kind: "ok", icon: "shieldCheck" }, "Safe to recover")),
    h("div", { className: "spread", style: { gap: 10 } },
      recoverTile("Exact duplicates", s.dupRecoverTB.toFixed(1) + " TB", "copy", "var(--warn)", () => go("duplicates")),
      recoverTile("Proxies / cache", (proxyTB + cacheTB).toFixed(1) + " TB", "cpu", "var(--ft-proxy)", () => go("cleanup"))),
    h("div", { className: "spread", style: { gap: 10 } },
      recoverTile("Review exports", reviewTB.toFixed(1) + " TB", "download", "var(--ft-export)", () => go("cleanup")),
      recoverTile("Clusters", String(s.clusterCount), "globe", "var(--ft-stock)", () => go("duplicates"))),
    h("button", { className: "btn primary", style: { width: "100%" }, onClick: () => go("cleanup") },
      h(Icon, { name: "broom", size: 15 }), "Recover " + totalSafe.toFixed(1) + " TB safely"));
}

// ---- Ready to archive ----
function ReadyArchiveCard({ go }: ScreenProps) {
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

// ---- Team storage (computed from live drives, grouped by owner) ----
function TeamCard() {
  const drives = (DB.drives || []) as any[];
  const byOwner: Record<string, { used: number; count: number }> = {};
  for (const d of drives) {
    const owner = d.owner || d.ownerId || "unknown";
    if (!byOwner[owner]) byOwner[owner] = { used: 0, count: 0 };
    byOwner[owner].used += d.usedTB || 0;
    byOwner[owner].count += 1;
  }
  const team = Object.entries(byOwner)
    .map(([owner, v]) => ({ owner, used: v.used, count: v.count }))
    .filter((m) => m.used > 0)
    .sort((a, b) => b.used - a.used);
  const maxUsed = team.length ? team[0].used : 1;

  const body = team.length === 0
    ? h("div", { className: "empty", style: { padding: "24px 0" } }, h("div", { className: "muted" }, "No drive owners yet."))
    : h("div", { style: { padding: "6px 0" } }, team.map((m) => h("div", { key: m.owner, className: "row", style: { padding: "8px 18px", gap: 11 } },
        h(Avatar, { id: m.owner, size: 30 }),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { className: "spread", style: { marginBottom: 4 } },
            h("span", { className: "hi", style: { fontWeight: 600, fontSize: 12.5 } }, m.owner),
            h("span", { className: "mono dim", style: { fontSize: 11 } }, fmtTB(m.used) + " · " + m.count + (m.count === 1 ? " drive" : " drives"))),
          h(Bar, { value: m.used, max: maxUsed, kind: "", height: 5 })))));
  return cardShell("Team Storage Usage", "users", "var(--tx-mut)", null, body);
}

// ---- Right rail ----
function WarningCard({ w, go, toast }: ScreenProps) {
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

// Derive warnings from real drive state instead of mock data.
function liveWarnings() {
  const drives = (DB.drives || []) as any[];
  const warnings: any[] = [];
  for (const d of drives) {
    if (d.capTB > 0 && d.usedTB / d.capTB >= 0.9) {
      warnings.push({ id: "full-" + d.id, risk: "risk", title: (d.name || d.label) + " is " + Math.round((d.usedTB / d.capTB) * 100) + "% full",
        detail: "Only " + fmtTB(Math.max(0, d.capTB - d.usedTB)) + " free on this drive.", action: "Open drive", target: "drive:" + d.id });
    }
    if (d.status === "uninit") {
      warnings.push({ id: "uninit-" + d.id, risk: "warn", title: (d.name || d.label) + " not initialized",
        detail: "Detected but not set up for tracking yet.", action: "Open drive", target: "drive:" + d.id });
    }
  }
  return warnings;
}
function WarningsRail({ go, toast }: ScreenProps) {
  const warnings = liveWarnings();
  const body = warnings.length === 0
    ? h("div", { className: "empty", style: { padding: "30px 12px", textAlign: "center" } }, h(Icon, { name: "shieldCheck", size: 20, style: { color: "var(--ok)" } }), h("div", { className: "muted", style: { fontSize: 12.5, marginTop: 8 } }, "No active warnings."))
    : h("div", { style: { padding: 12, display: "flex", flexDirection: "column", gap: 8, maxHeight: 440, overflowY: "auto" } },
        warnings.map((w) => h(WarningCard, { key: w.id, w, go, toast })));
  return cardShell("Active Warnings", "alert", warnings.length ? "var(--risk)" : "var(--ok)", h(Badge, { kind: warnings.length ? "risk" : "ok" }, warnings.length), body);
}

// Real activity from the audit log (wired from Convex in page.tsx).
function ActivityRail({ go }: ScreenProps) {
  const audit = (DB.audit || []).slice(0, 8);
  const iconFor = (kind: string) => {
    const m: Record<string, string[]> = {
      scan_complete: ["ok", "checkCircle"], scan_start: ["accent", "refresh"],
      analysis_complete: ["accent", "cpu"], job_create: ["warn", "broom"],
      job_approve: ["ok", "check"], quarantine_restore: ["ok", "rotate"],
      project_create: ["cloud", "plus"], drive_remove: ["", "trash"],
      machine_token_issued: ["accent", "shield"],
    };
    return m[kind] || ["", "activity"];
  };
  const body = audit.length === 0
    ? h("div", { className: "empty", style: { padding: "24px 0" } }, h("div", { className: "muted" }, "No recent activity yet."))
    : h("div", { style: { padding: "6px 0" } }, audit.map((a: any, i: number) => {
        const meta = iconFor(a.kind);
        const bg = meta[0] ? "var(--" + (meta[0] === "accent" ? "accent" : meta[0]) + "-soft)" : "var(--bg-surface)";
        const fg = meta[0] ? "var(--" + (meta[0] === "accent" ? "accent-hi" : meta[0]) + ")" : "var(--tx-dim)";
        return h("div", { key: i, className: "row", style: { padding: "10px 16px", gap: 11, borderBottom: i < audit.length - 1 ? "1px solid var(--line-faint)" : "none" } },
          h("div", { style: { width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", flexShrink: 0, background: bg, color: fg, border: "1px solid var(--line)" } },
            h(Icon, { name: meta[1], size: 15 })),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { className: "hi", style: { fontWeight: 600, fontSize: 12, lineHeight: 1.35 } }, a.action),
            h("div", { className: "muted", style: { fontSize: 11 } }, a.who)),
          h("span", { className: "mono dim", style: { fontSize: 10.5, flexShrink: 0 } }, a.time));
      }));
  return cardShell("Recent Activity", "activity", "var(--tx-mut)", null, body);
}

// ============================================================
function Dashboard({ go, toast }: ScreenProps) {
  const actions = [
    { label: "Scan Drive", icon: "refresh", onClick: () => toast("Scans run from the desktop agent — use Scan Now there.", "refresh", "accent") },
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
        h("div", { className: "page-desc" }, "Studio-wide storage health across ",
          h("b", { className: "hi" }, (DB.drives || []).length + (DB.drives && DB.drives.length === 1 ? " drive" : " drives")), " and ",
          h("b", { className: "hi" }, (DB.projects || []).length + (DB.projects && DB.projects.length === 1 ? " project" : " projects")), ".")),
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
