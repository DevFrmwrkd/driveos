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
   DriveOS — Drives Overview + Drive Detail
   ============================================================ */


  

  const TIER_LABEL: Record<string, string> = { hot: "Hot", warm: "Warm", cloud: "Cloud", cold: "Cold" };
  const driveIcon = (d: any) => d.status === "cloud" ? "cloud" : "hdd";

  // ---- Capacity meter ----
  function CapMeter({ d, height = 8 }: ScreenProps) {
    const p = pct(d.usedTB, d.capTB);
    return h("div", null,
      h("div", { className: "spread", style: { fontSize: 11.5, marginBottom: 5 } },
        h("span", { className: "mono", style: { color: "var(--tx-hi)" } }, fmtTB(d.usedTB), h("span", { className: "dim" }, " / " + fmtTB(d.capTB))),
        h("span", { className: "mono", style: { color: p >= 90 ? "var(--risk)" : p >= 75 ? "var(--warn)" : "var(--tx-mut)" } }, p + "%")),
      h(Bar, { value: d.usedTB, max: d.capTB, kind: d.status === "cloud" ? "cloud" : tierKind(p), height }),
      h("div", { className: "spread", style: { fontSize: 10.5, marginTop: 5, color: "var(--tx-dim)" } },
        h("span", null, fmtTB(Math.max(d.capTB - d.usedTB, 0)) + " free"),
        d.status !== "uninit" && h("span", { className: "mono" }, d.scans + " scans")));
  }

  // ---- Drive card ----
  function DriveCard({ d, go }: ScreenProps) {
    const owner = DB.teamById[d.owner] || DB.teamById.founder || { name: "Studio" };
    return h("div", { className: "card fade-up", onClick: () => go("drive", { id: d.id }),
      style: { cursor: "pointer", display: "flex", flexDirection: "column", transition: "border-color .14s, transform .1s" },
      onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.borderColor = "var(--line-strong)"),
      onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.borderColor = "var(--line)") },
      h("div", { className: "card-pad", style: { paddingBottom: 14 } },
        h("div", { className: "spread", style: { marginBottom: 14 } },
          h("div", { className: "row", style: { gap: 11, minWidth: 0 } },
            h("div", { style: { width: 40, height: 40, borderRadius: 10, flexShrink: 0, display: "grid", placeItems: "center",
              background: d.status === "online" ? "var(--ok-soft)" : d.status === "cloud" ? "var(--cloud-soft)" : d.status === "uninit" ? "var(--warn-soft)" : "var(--bg-surface)",
              color: d.status === "online" ? "var(--ok)" : d.status === "cloud" ? "var(--cloud)" : d.status === "uninit" ? "var(--warn)" : "var(--tx-dim)",
              border: "1px solid var(--line)" } }, h(Icon, { name: driveIcon(d), size: 20 })),
            h("div", { style: { minWidth: 0 } },
              h("div", { className: "hi", style: { fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, d.name),
              h("div", { className: "muted mono", style: { fontSize: 11, marginTop: 1 } }, d.model))),
          h(StatusBadge, { status: d.status })),
        d.status === "uninit"
          ? h("div", { style: { padding: "16px 0", textAlign: "center" } },
              h("div", { className: "muted", style: { fontSize: 12.5, marginBottom: 12 } }, "New " + fmtTB(d.capTB) + " drive detected. Not yet tracked."),
              h("button", { className: "btn primary sm", onClick: (e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); go("drive", { id: d.id }); } }, h(Icon, { name: "zap", size: 14 }), "Initialize Drive"))
          : h(CapMeter, { d })),
      d.status !== "uninit" && h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderTop: "1px solid var(--line)" } },
        miniCell("Projects", d.projects.length, "var(--tx-hi)"),
        miniCell("Duplicates", d.dupTB > 0 ? fmtTB(d.dupTB) : "—", d.dupTB > 0 ? "var(--warn)" : "var(--tx-dim)"),
        miniCell("Cleanup", d.cleanTB > 0 ? fmtTB(d.cleanTB) : "—", d.cleanTB > 0 ? "var(--ok)" : "var(--tx-dim)")),
      h("div", { className: "spread", style: { padding: "11px 16px", borderTop: "1px solid var(--line)", background: "var(--bg-surface)", borderRadius: "0 0 var(--r-lg) var(--r-lg)" } },
        h("div", { className: "row", style: { gap: 8 } }, h(Avatar, { id: d.owner, size: 22 }),
          h("span", { style: { fontSize: 12, color: "var(--tx-mut)" } }, owner.name.split(" ")[0]),
          h("span", { className: "dim", style: { fontSize: 11.5 } }, "· " + d.location)),
        h(RiskBadge, { risk: d.risk })));
  }
  function miniCell(label: React.ReactNode, value: React.ReactNode, color: string) {
    return h("div", { style: { padding: "11px 14px", borderRight: "1px solid var(--line)", textAlign: "center" } },
      h("div", { className: "eyebrow", style: { fontSize: 9, marginBottom: 3 } }, label),
      h("div", { className: "stat-num", style: { fontSize: 15, color } }, value));
  }

  // ---- Overview ----
  function DrivesScreen({ go }: ScreenProps) {
    const [owner, setOwner] = React.useState("all");
    const [loc, setLoc] = React.useState("all");
    const [status, setStatus] = React.useState("all");
    const [view, setView] = React.useState("grid");

    const locations = [...new Set(DB.drives.map((d) => d.location))];
    let list = DB.drives.filter((d) =>
      (owner === "all" || d.owner === owner) &&
      (loc === "all" || d.location === loc) &&
      (status === "all" || d.status === status));

    const online = DB.drives.filter((d) => d.status === "online").length;
    const totalCap = DB.drives.reduce((s, d) => s + d.capTB, 0);
    const totalUsed = DB.drives.reduce((s, d) => s + d.usedTB, 0);

    return h("div", { className: "page-inner" },
      h(PageHead, { eyebrow: "Storage", title: "Drives", desc: "Every tracked hard drive, RAID, and cloud volume across the studio and remote agents.",
        actions: [h("button", { key: 1, className: "btn" }, h(Icon, { name: "refresh", size: 15 }), "Scan All"),
          h("button", { key: 2, className: "btn primary" }, h(Icon, { name: "plus", size: 16 }), "Add Drive")] }),

      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: "var(--gap)", marginBottom: "var(--gap)" } },
        kpiMini("Online", online, "ok", "hdd"),
        kpiMini("Offline", DB.drives.filter((d) => d.status === "offline").length, "", "hdd"),
        kpiMini("Cloud", DB.drives.filter((d) => d.status === "cloud").length, "cloud", "cloud"),
        kpiMini("Total Capacity", fmtTB(totalCap), "", "database"),
        kpiMini("Total Used", fmtTB(totalUsed), "warn", "server")),

      h("div", { className: "filter-bar" },
        h(Icon, { name: "filter", size: 15, style: { color: "var(--tx-dim)" } }),
        h("select", { className: "select", value: owner, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setOwner(e.target.value) },
          h("option", { value: "all" }, "All owners"), DB.team.map((m) => h("option", { key: m.id, value: m.id }, m.name))),
        h("select", { className: "select", value: loc, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setLoc(e.target.value) },
          h("option", { value: "all" }, "All locations"), locations.map((l) => h("option", { key: l, value: l }, l))),
        h(Seg, { value: status, onChange: setStatus, options: [
          { value: "all", label: "All" }, { value: "online", label: "Online" }, { value: "offline", label: "Offline" }, { value: "cloud", label: "Cloud" }, { value: "uninit", label: "New" }] }),
        h("div", { style: { marginLeft: "auto" } },
          h(Seg, { value: view, onChange: setView, options: [{ value: "grid", label: "Cards" }, { value: "table", label: "Table" }] }))),

      list.length === 0 ? emptyState() :
        view === "grid"
          ? h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "var(--gap)" } },
              list.map((d) => h(DriveCard, { key: d.id, d, go })))
          : h(DriveTable, { list, go }));
  }

  function DriveTable({ list, go }: ScreenProps) {
    return h("div", { className: "card", style: { overflow: "hidden" } },
      h("table", { className: "tbl" },
        h("thead", null, h("tr", null,
          ["Drive", "Owner", "Location", "Status", "Capacity", "Used", "Risk", "Dupes", "Cleanup"].map((c, i) =>
            h("th", { key: i, className: i >= 4 && i !== 6 ? "num" : "" }, c)))),
        h("tbody", null, list.map((d: any) => {
          const p = pct(d.usedTB, d.capTB);
          const owner = DB.teamById[d.owner] || DB.teamById.founder || { name: "Studio" };
          return h("tr", { key: d.id, onClick: () => go("drive", { id: d.id }) },
            h("td", null, h("div", { className: "row", style: { gap: 9 } },
              h(Icon, { name: driveIcon(d), size: 16, style: { color: "var(--tx-mut)" } }),
              h("span", { className: "hi", style: { fontWeight: 600 } }, d.name))),
            h("td", null, h("div", { className: "row", style: { gap: 7 } }, h(Avatar, { id: d.owner, size: 20 }), owner.name.split(" ")[0])),
            h("td", { className: "muted" }, d.location),
            h("td", null, h(StatusBadge, { status: d.status })),
            h("td", { className: "num" }, fmtTB(d.capTB)),
            h("td", { className: "num" }, h("div", { className: "row", style: { gap: 8, justifyContent: "flex-end" } },
              h("span", { style: { width: 46 } }, h(Bar, { value: d.usedTB, max: d.capTB, kind: d.status === "cloud" ? "cloud" : tierKind(p), height: 5 })),
              h("span", { style: { color: p >= 90 ? "var(--risk)" : "var(--tx)" } }, p + "%"))),
            h("td", null, h(RiskBadge, { risk: d.risk })),
            h("td", { className: "num", style: { color: d.dupTB > 0 ? "var(--warn)" : "var(--tx-dim)" } }, d.dupTB > 0 ? fmtTB(d.dupTB) : "—"),
            h("td", { className: "num", style: { color: d.cleanTB > 0 ? "var(--ok)" : "var(--tx-dim)" } }, d.cleanTB > 0 ? fmtTB(d.cleanTB) : "—"));
        }))));
  }

  function kpiMini(label: React.ReactNode, value: React.ReactNode, kind: string, icon: string) {
    const color = kind ? "var(--" + (kind === "warn" ? "warn" : kind === "ok" ? "ok" : kind === "cloud" ? "cloud" : kind) + ")" : "var(--tx-hi)";
    return h("div", { className: "card card-pad fade-up", style: { display: "flex", alignItems: "center", gap: 13 } },
      h("div", { style: { width: 38, height: 38, borderRadius: 10, display: "grid", placeItems: "center", flexShrink: 0,
        background: kind ? "var(--" + kind + "-soft)" : "var(--bg-surface)", color, border: "1px solid var(--line)" } }, h(Icon, { name: icon, size: 18 })),
      h("div", null, h("div", { className: "stat-num", style: { fontSize: 22 } }, value),
        h("div", { className: "eyebrow", style: { fontSize: 9.5, marginTop: 1 } }, label)));
  }

  function emptyState() {
    return h("div", { className: "card" }, h("div", { className: "empty" },
      h("div", { className: "empty-ico" }, h(Icon, { name: "hdd", size: 24 })),
      h("h3", null, "No drives match these filters"),
      h("div", { className: "muted" }, "Try clearing a filter, or connect a new drive to start tracking.")));
  }

  // ============================================================
  //  DRIVE DETAIL
  // ============================================================
  function driveFileTypes(d: any) {
    // synthesize per-drive distribution scaled to usedTB
    const weights: Record<string, number> = { raw: 0.5, proxy: 0.12, cache: 0.1, export: 0.09, stock: 0.08, audio: 0.05, gfx: 0.04, unknown: 0.02 };
    return DB.fileTypes.map((f) => ({ label: f.label, value: +(d.usedTB * (weights[f.key] || 0.03)).toFixed(2), color: getVar(f.color), key: f.key }));
  }
  const FOLDERS = [
    { name: "02_RAW/A_CAM", type: "raw", w: 0.34 }, { name: "02_RAW/B_CAM", type: "raw", w: 0.18 },
    { name: "05_PROXIES", type: "proxy", w: 0.12 }, { name: "06_RENDERS_CACHE", type: "cache", w: 0.1 },
    { name: "04_ASSETS/STOCK_FOOTAGE", type: "stock", w: 0.08 }, { name: "07_EXPORTS/FINAL", type: "export", w: 0.07 },
  ];

  function DriveDetail({ params, go, toast }: ScreenProps) {
    const d = (DB.driveById as AnyRecord)[params.id];
    if (!d) return h("div", { className: "page-inner" }, h("div", { className: "muted" }, "Drive not found."));
    const owner = DB.teamById[d.owner] || DB.teamById.founder || { name: "Studio" };
    const ft = driveFileTypes(d);
    const p = pct(d.usedTB, d.capTB);

    if (d.status === "uninit") return h(UninitDrive, { d, go, toast });

    const head = h(PageHead, {
      eyebrow: owner.name + " · " + d.location,
      title: d.name,
      desc: d.model + " · " + d.bus,
      actions: [
        h("button", { key: 1, className: "btn", onClick: () => toast("Watching " + d.name, "eye", "accent") }, h(Icon, { name: "eye", size: 15 }), "Watch Drive"),
        h("button", { key: 2, className: "btn", onClick: () => toast("Scan started on " + d.name, "refresh", "accent") }, h(Icon, { name: "refresh", size: 15 }), "Start Scan"),
        h("button", { key: 3, className: "btn primary", onClick: () => go("cleanup") }, h(Icon, { name: "broom", size: 15 }), "Generate Cleanup Plan"),
      ],
    });

    // status strip
    const strip = h("div", { className: "card card-pad fade-up", style: { display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1fr", gap: 22, marginBottom: "var(--gap)", alignItems: "center" } },
      h("div", null,
        h("div", { className: "row", style: { gap: 9, marginBottom: 9 } }, h(StatusBadge, { status: d.status }), h(RiskBadge, { risk: d.risk })),
        h(CapMeter, { d, height: 9 })),
      stripCell("Last Seen", d.lastSeen, "clock"),
      stripCell("Projects", d.projects.length, "folder"),
      stripCell("Duplicates", fmtTB(d.dupTB), "copy", "var(--warn)"),
      stripCell("Safe Cleanup", fmtTB(d.cleanTB), "broom", "var(--ok)"));

    const projBreakdown = cardShell("Storage by Project", "folder", "var(--tx-mut)", null,
      h("div", { style: { padding: "8px 0" } }, d.projects.map((pid: string) => {
        const pr = (DB.projectById as AnyRecord)[pid] || { name: pid, sizeTB: d.usedTB / d.projects.length, client: "—" };
        const share = pr.sizeTB;
        return h("div", { key: pid, className: "offender-row", onClick: () => (DB.projectById as AnyRecord)[pid] && go("project", { id: pid }), style: { padding: "10px 18px", cursor: (DB.projectById as AnyRecord)[pid] ? "pointer" : "default" } },
          h("div", { className: "spread", style: { marginBottom: 5 } },
            h("span", { className: "hi", style: { fontWeight: 600, fontSize: 13 } }, pr.name),
            h("span", { className: "mono", style: { fontSize: 12, color: "var(--tx)" } }, fmtTB(share))),
          h(Bar, { value: share, max: Math.max(...d.projects.map((x: string) => ((DB.projectById as AnyRecord)[x] || { sizeTB: 1 }).sizeTB)), height: 5 }));
      })));

    const typeCard = cardShell("File-Type Breakdown", "pieChart", "var(--tx-mut)", h(Badge, { square: true }, fmtTB(d.usedTB)),
      h("div", { className: "card-pad", style: { display: "flex", gap: 18, alignItems: "center" } },
        h(Donut, { data: ft, size: 140, thickness: 19 },
          h("div", { className: "stat-num", style: { fontSize: 17 } }, ft[0].value > 0 ? Math.round(ft[0].value / d.usedTB * 100) + "%" : "—"),
          h("div", { style: { fontSize: 9, color: "var(--tx-dim)", fontFamily: "var(--font-mono)" } }, "RAW")),
        h("div", { style: { flex: 1 } }, h(Legend, { data: ft.filter((x) => x.value > 0.05) }))));

    const folders = cardShell("Biggest Folders", "folder", "var(--tx-mut)", null,
      h("div", { style: { padding: "6px 0" } }, FOLDERS.map((fo, i) => {
        const size = d.usedTB * fo.w;
        return h("div", { key: i, className: "row", style: { padding: "9px 18px", gap: 12 } },
          h("span", { style: { width: 9, height: 9, borderRadius: 2, background: getVar("var(--ft-" + fo.type + ")"), flexShrink: 0 } }),
          h("span", { className: "mono", style: { fontSize: 12, color: "var(--tx)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, "/" + fo.name),
          h("span", { className: "mono", style: { fontSize: 12, color: "var(--tx-hi)", flexShrink: 0 } }, fmtTB(size)));
      })));

    const dupes = DB.duplicates.filter((du) => du.locations.some((l) => l.drive === d.id)).slice(0, 4);
    const dupCard = cardShell("Duplicate Clusters", "copy", "var(--warn)", h("button", { className: "btn sm ghost", onClick: () => go("duplicates") }, "Review all"),
      h("div", { style: { padding: "6px 0" } }, dupes.length ? dupes.map((du) =>
        h("div", { key: du.id, className: "offender-row spread", onClick: () => go("duplicates"), style: { padding: "10px 18px", cursor: "pointer" } },
          h("div", { className: "row", style: { gap: 9, minWidth: 0 } }, h(FileTypePill, { type: du.type }),
            h("span", { className: "mono hi", style: { fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, du.name)),
          h("div", { className: "row", style: { gap: 8, flexShrink: 0 } }, h(Badge, { kind: RISK_META[du.risk].cls }, du.copies + " copies"),
            h("span", { className: "mono", style: { fontSize: 12, color: "var(--tx-hi)" } }, du.sizeGB + " GB")))) :
        h("div", { className: "muted", style: { padding: "14px 18px", fontSize: 12.5 } }, "No duplicate clusters detected on this drive.")));

    const cleanupActions = [
      { title: "Quarantine Premiere cache", size: "0.3 TB", risk: "safe", why: "Regenerable peak + media cache." },
      { title: "Remove delivered proxies", size: "0.18 TB", risk: "safe", why: "Originals verified on archive." },
      { title: "Review old exports (v1–v4)", size: "0.13 TB", risk: "review", why: "Superseded review cuts." },
    ];
    const cleanCard = cardShell("Suggested Cleanup Actions", "broom", "var(--ok)", null,
      h("div", { style: { padding: 14, display: "flex", flexDirection: "column", gap: 10 } }, cleanupActions.map((a, i) =>
        h("div", { key: i, className: "spread", style: { padding: "11px 13px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
          h("div", { style: { minWidth: 0 } },
            h("div", { className: "row", style: { gap: 8, marginBottom: 3 } }, h(Badge, { kind: RISK_META[a.risk].cls }, RISK_META[a.risk].label),
              h("span", { className: "hi", style: { fontWeight: 600, fontSize: 12.5 } }, a.title)),
            h("div", { className: "muted", style: { fontSize: 11.5 } }, a.why)),
          h("div", { className: "row", style: { gap: 10, flexShrink: 0 } }, h("span", { className: "stat-num", style: { fontSize: 14, color: "var(--ok)" } }, a.size),
            h("button", { className: "btn sm", onClick: () => toast("Added to cleanup plan", "broom", "ok") }, "Plan"))))));

    const risky = cardShell("Single-Copy Files (at risk)", "shield", "var(--risk)", h(Badge, { kind: "risk" }, "147 files"),
      h("div", { className: "card-pad" },
        h("div", { style: { padding: "14px 16px", borderRadius: "var(--r)", background: "var(--risk-soft)", border: "1px solid var(--risk-line)" } },
          h("div", { className: "row", style: { gap: 9 } }, h(Icon, { name: "alert", size: 16, style: { color: "var(--risk)" } }),
            h("div", null, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 13 } }, "0.9 TB exists only on this drive"),
              h("div", { className: "muted", style: { fontSize: 12, marginTop: 3 } }, "147 RAW clips have no archive or cloud copy. Back up before any cleanup."))),
          h("button", { className: "btn sm primary", style: { marginTop: 11 }, onClick: () => go("archive") }, h(Icon, { name: "archive", size: 14 }), "Send to Archive Queue"))));

    const scans = cardShell("Scan Timeline", "activity", "var(--tx-mut)", null,
      h("div", { style: { padding: "10px 18px" } }, [
        { t: "2 min ago", e: "Full scan complete", n: "142,308 files · 3.6 TB indexed", k: "ok" },
        { t: "Yesterday", e: "Incremental scan", n: "+1,204 files · +42 GB", k: "accent" },
        { t: "Jun 1", e: "Duplicate detection run", n: "0.42 TB duplicates flagged", k: "warn" },
        { t: "May 28", e: "Drive connected", n: "Thunderbolt 4 · auto-watch enabled", k: "" },
      ].map((s, i, arr) => h("div", { key: i, className: "row", style: { gap: 13, alignItems: "flex-start", paddingBottom: i < arr.length - 1 ? 16 : 0, position: "relative" } },
        h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 } },
          h("span", { style: { width: 10, height: 10, borderRadius: 99, background: s.k ? "var(--" + s.k + ")" : "var(--tx-faint)", boxShadow: s.k ? "0 0 8px var(--" + s.k + ")" : "none", zIndex: 1 } }),
          i < arr.length - 1 && h("span", { style: { width: 1, flex: 1, background: "var(--line)", marginTop: 4, position: "absolute", top: 14, bottom: 0 } })),
        h("div", { style: { flex: 1 } },
          h("div", { className: "spread" }, h("span", { className: "hi", style: { fontWeight: 600, fontSize: 12.5 } }, s.e),
            h("span", { className: "mono dim", style: { fontSize: 11 } }, s.t)),
          h("div", { className: "muted", style: { fontSize: 11.5, marginTop: 2 } }, s.n))))));

    return h("div", { className: "page-inner" },
      h("button", { className: "btn ghost sm", style: { marginBottom: 12 }, onClick: () => go("drives") }, h(Icon, { name: "chevL", size: 15 }), "All drives"),
      head, strip,
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--gap)", marginBottom: "var(--gap)" } }, typeCard, projBreakdown),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--gap)", marginBottom: "var(--gap)" } }, folders, dupCard),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--gap)", marginBottom: "var(--gap)" } }, cleanCard, risky),
      scans);
  }

  function stripCell(label: React.ReactNode, value: React.ReactNode, icon: string, color = "") {
    return h("div", null,
      h("div", { className: "row", style: { gap: 6, marginBottom: 5 } }, h(Icon, { name: icon, size: 13, style: { color: color || "var(--tx-dim)" } }),
        h("span", { className: "eyebrow", style: { fontSize: 9.5 } }, label)),
      h("div", { className: "stat-num", style: { fontSize: 19, color: color || "var(--tx-hi)" } }, value));
  }

  function UninitDrive({ d, go, toast }: ScreenProps) {
    const [step, setStep] = React.useState(0);
    const owner = DB.teamById[d.owner] || DB.teamById.founder || { name: "Studio" };
    return h("div", { className: "page-inner" },
      h("button", { className: "btn ghost sm", style: { marginBottom: 12 }, onClick: () => go("drives") }, h(Icon, { name: "chevL", size: 15 }), "All drives"),
      h(PageHead, { eyebrow: owner.name + " · " + d.location, title: d.name, desc: d.model + " · " + d.bus }),
      h("div", { className: "card", style: { maxWidth: 640, margin: "0 auto" } },
        h("div", { className: "card-pad", style: { textAlign: "center", padding: 36 } },
          h("div", { style: { width: 64, height: 64, borderRadius: 16, margin: "0 auto 18px", display: "grid", placeItems: "center", background: "var(--warn-soft)", color: "var(--warn)", border: "1px solid var(--warn-line)" } }, h(Icon, { name: "hdd", size: 28 })),
          h("h3", { style: { fontSize: 19, marginBottom: 8 } }, "Drive not initialized"),
          h("div", { className: "muted", style: { fontSize: 13.5, maxWidth: 380, margin: "0 auto 22px" } }, "This new " + fmtTB(d.capTB) + " volume was detected by the Tokyo agent but isn't tracked yet. Initialize it to enable scanning, watching, and cleanup."),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 10, maxWidth: 360, margin: "0 auto", textAlign: "left" } },
            ["Index existing files and compute hashes", "Apply studio storage tier and watch rules", "Enable duplicate + single-copy detection"].map((t, i) =>
              h("div", { key: i, className: "row", style: { gap: 10 } }, h("span", { className: "chk " + (step > i ? "on" : ""), style: { width: 18, height: 18 } }, h(Icon, { name: "check", size: 12, stroke: 3, style: { color: "#fff" } })), h("span", { style: { fontSize: 13 } }, t)))),
          h("button", { className: "btn primary lg", style: { marginTop: 24 }, onClick: () => { setStep(3); toast("Initializing " + d.name + "…", "zap", "accent"); } },
            h(Icon, { name: "zap", size: 16 }), step >= 3 ? "Initializing…" : "Initialize Drive"))));
  }

  
  


export { DrivesScreen, DriveDetail };
