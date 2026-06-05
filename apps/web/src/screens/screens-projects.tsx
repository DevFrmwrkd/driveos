import React from "react";
import { DB } from "@/data";
import { ArchiveChecklistModal } from "./screens-archive";
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



/* ============================================================
   DriveOS — Projects Overview + Project Detail
   ============================================================ */


  

  function structKind(s) { return s >= 85 ? "ok" : s >= 65 ? "warn" : "risk"; }

  // ---- Project card ----
  function ProjectCard({ p, go }) {
    const st = PROJ_STATUS[p.status], tier = TIER_META[p.tier];
    return h("div", { className: "card fade-up", onClick: () => go("project", { id: p.id }),
      style: { cursor: "pointer", transition: "border-color .14s" },
      onMouseEnter: (e) => (e.currentTarget.style.borderColor = "var(--line-strong)"),
      onMouseLeave: (e) => (e.currentTarget.style.borderColor = "var(--line)") },
      h("div", { className: "card-pad", style: { paddingBottom: 14 } },
        h("div", { className: "spread", style: { marginBottom: 13, alignItems: "flex-start" } },
          h("div", { style: { minWidth: 0 } },
            h("div", { className: "hi", style: { fontWeight: 600, fontSize: 14.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, p.name),
            h("div", { className: "muted", style: { fontSize: 11.5, marginTop: 2 } }, p.client, " · ", p.show)),
          h("span", { className: "badge " + st.cls, style: { flexShrink: 0 } }, st.label)),
        h("div", { className: "row", style: { gap: 7, marginBottom: 15 } },
          h("span", { className: "tag" }, h("span", { style: { width: 7, height: 7, borderRadius: 2, background: getVar(tier.color) } }), tier.label, " storage"),
          h(Avatar, { id: p.owner, size: 20 }),
          h("span", { className: "muted", style: { fontSize: 11.5 } }, DB.teamById[p.owner].name.split(" ")[0])),
        h("div", { className: "spread", style: { alignItems: "flex-end", marginBottom: 14 } },
          h("div", null, h("div", { className: "stat-num", style: { fontSize: 26 } }, fmtTB(p.sizeTB)),
            h("div", { className: "eyebrow", style: { fontSize: 9, marginTop: 1 } }, "Total Size")),
          h("div", { style: { textAlign: "right", fontSize: 11.5 } },
            h("div", { className: "row", style: { gap: 6, justifyContent: "flex-end" } }, h("span", { className: "muted" }, "Duplicates"), h("span", { className: "mono", style: { color: "var(--warn)" } }, fmtTB(p.dupTB))),
            h("div", { className: "row", style: { gap: 6, justifyContent: "flex-end", marginTop: 3 } }, h("span", { className: "muted" }, "Cleanup"), h("span", { className: "mono", style: { color: "var(--ok)" } }, fmtTB(p.cleanTB)))))),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", borderTop: "1px solid var(--line)" } },
        healthCell("Structure", p.structure, structKind(p.structure)),
        healthCell("Archive Ready", p.archiveReady, p.archiveReady >= 80 ? "ok" : p.archiveReady >= 40 ? "warn" : "risk", true)));
  }
  function healthCell(label, val, kind, right) {
    return h("div", { style: { padding: "12px 16px", borderRight: right ? "none" : "1px solid var(--line)" } },
      h("div", { className: "spread", style: { marginBottom: 6 } },
        h("span", { className: "eyebrow", style: { fontSize: 9 } }, label),
        h("span", { className: "mono", style: { fontSize: 11, color: "var(--" + kind + ")" } }, val + "%")),
      h(Bar, { value: val, max: 100, kind, height: 5 }));
  }

  // ---- Overview ----
  function ProjectsScreen({ go }) {
    const [status, setStatus] = React.useState("all");
    const [tier, setTier] = React.useState("all");
    const [owner, setOwner] = React.useState("all");

    let list = DB.projects.filter((p) =>
      (status === "all" || p.status === status) &&
      (tier === "all" || p.tier === tier) &&
      (owner === "all" || p.owner === owner));

    const totSize = DB.projects.reduce((s, p) => s + p.sizeTB, 0);
    const totDup = DB.projects.reduce((s, p) => s + p.dupTB, 0);

    return h("div", { className: "page-inner" },
      h(PageHead, { eyebrow: "Storage", title: "Projects", desc: "Every show, campaign, and episode the studio is tracking — with storage, duplicate, and archive health at a glance.",
        actions: [h("button", { key: 1, className: "btn primary", onClick: () => go("wizard") }, h(Icon, { name: "plus", size: 16 }), "Create Project")] }),

      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: "var(--gap)", marginBottom: "var(--gap)" } },
        pkpi("Active", DB.projects.filter((p) => p.status === "active").length, "accent"),
        pkpi("In Review", DB.projects.filter((p) => p.status === "review").length, "warn"),
        pkpi("Ready to Archive", DB.projects.filter((p) => p.status === "ready").length, "auto"),
        pkpi("Total Size", fmtTB(totSize), ""),
        pkpi("Duplicate Size", fmtTB(totDup), "warn")),

      h("div", { className: "filter-bar" },
        h(Icon, { name: "filter", size: 15, style: { color: "var(--tx-dim)" } }),
        h(Seg, { value: status, onChange: setStatus, options: [
          { value: "all", label: "All" }, { value: "active", label: "Active" }, { value: "review", label: "Review" },
          { value: "delivered", label: "Delivered" }, { value: "ready", label: "Ready" }, { value: "archived", label: "Archived" }] }),
        h("select", { className: "select", value: tier, onChange: (e) => setTier(e.target.value) },
          h("option", { value: "all" }, "All tiers"), ["hot", "warm", "cloud", "cold"].map((t) => h("option", { key: t, value: t }, TIER_META[t].label))),
        h("select", { className: "select", value: owner, onChange: (e) => setOwner(e.target.value) },
          h("option", { value: "all" }, "All editors"), DB.team.map((m) => h("option", { key: m.id, value: m.id }, m.name)))),

      list.length === 0
        ? h("div", { className: "card" }, h("div", { className: "empty" }, h("div", { className: "empty-ico" }, h(Icon, { name: "folder", size: 24 })), h("h3", null, "No projects match"), h("div", { className: "muted" }, "Adjust filters or create a new project.")))
        : h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: "var(--gap)" } },
            list.map((p) => h(ProjectCard, { key: p.id, p, go }))));
  }
  function pkpi(label, value, kind) {
    const color = kind ? "var(--" + (kind === "accent" ? "accent-hi" : kind) + ")" : "var(--tx-hi)";
    return h("div", { className: "card card-pad fade-up" },
      h("div", { className: "stat-num", style: { fontSize: 24, color } }, value),
      h("div", { className: "eyebrow", style: { fontSize: 9.5, marginTop: 3 } }, label));
  }

  // ============================================================
  //  PROJECT DETAIL
  // ============================================================
  function projectTree(p) {
    const base = DB.projectFolders[p.id];
    if (base) return base;
    // synthesize: mark some missing based on structure score
    return DB.folderTemplate.filter((f) => f.lvl === 0).map((f, i) => ({
      name: f.name, status: (p.structure < 70 && (i === 0 || i === 9)) ? "missing" : (f.name.includes("PROX") || f.name.includes("CACHE")) ? "warn" : "ok",
      sizeGB: Math.round(p.sizeTB * 1000 * [0.002,0.001,0.55,0.03,0.06,0.12,0.09,0.05,0.02,0][i] || 1),
    }));
  }

  function ProjectDetail({ params, go, toast }) {
    const p = DB.projectById[params.id];
    const [modal, setModal] = React.useState(null);
    if (!p) return h("div", { className: "page-inner" }, h("div", { className: "muted" }, "Project not found."));
    const st = PROJ_STATUS[p.status], tier = TIER_META[p.tier];
    const tree = projectTree(p);
    const missing = tree.filter((f) => f.status === "missing");

    const head = h(PageHead, {
      eyebrow: p.client + " · " + p.show,
      title: p.name,
      desc: null,
      actions: [
        h("button", { key: 1, className: "btn", onClick: () => toast("Opening file location…", "external", "accent") }, h(Icon, { name: "external", size: 15 }), "Open Location"),
        h("button", { key: 2, className: "btn", onClick: () => go("cleanup") }, h(Icon, { name: "broom", size: 15 }), "Clean Project"),
        h("button", { key: 3, className: "btn primary", onClick: () => setModal("archive") }, h(Icon, { name: "archive", size: 15 }), "Archive Project"),
      ],
    });

    const metaRow = h("div", { className: "row", style: { gap: 9, marginBottom: 18, marginTop: -10, flexWrap: "wrap" } },
      h("span", { className: "badge " + st.cls }, st.label),
      h("span", { className: "tag" }, h("span", { style: { width: 7, height: 7, borderRadius: 2, background: getVar(tier.color) } }), tier.label, " storage"),
      h("span", { className: "row", style: { gap: 6 } }, h(Avatar, { id: p.owner, size: 22 }), h("span", { className: "muted", style: { fontSize: 12.5 } }, DB.teamById[p.owner].name)),
      h("span", { className: "tag" }, h(Icon, { name: "clock", size: 12 }), "Modified " + p.modified),
      h("span", { className: "tag" }, h(Icon, { name: "layers", size: 12 }), p.template + " template"));

    // summary strip
    const summary = h("div", { className: "card card-pad fade-up", style: { display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 20, marginBottom: "var(--gap)" } },
      sumCell("Total Size", fmtTB(p.sizeTB), "database", ""),
      sumCell("Duplicates", fmtTB(p.dupTB), "copy", "var(--warn)"),
      sumCell("Cache / Proxy Waste", fmtTB(p.cleanTB), "cpu", "var(--ft-cache)"),
      sumCell("Structure Health", p.structure + "%", "target", "var(--" + structKind(p.structure) + ")"),
      sumCell("Archive Ready", p.archiveReady + "%", "archive", p.archiveReady >= 80 ? "var(--ok)" : "var(--warn)"));

    // copies
    const copies = cardShell("Copies & Redundancy", "layers", "var(--tx-mut)", null,
      h("div", { className: "card-pad", style: { display: "flex", flexDirection: "column", gap: 11 } },
        copyRow("Local working copy", p.locations.some((l) => ["hot", "warm"].includes((DB.driveById[l] || {}).tier)), "hdd"),
        copyRow("Cloud copy", p.locations.includes("gdrive"), "cloud"),
        copyRow("Archive copy", p.locations.some((l) => (DB.driveById[l] || {}).tier === "cold"), "archive"),
        h("div", { className: "divider", style: { margin: "4px 0" } }),
        h("div", { style: { fontSize: 11.5, color: "var(--tx-mut)" } }, "Stored on ", h("b", { className: "hi" }, p.locations.length + " volumes"), ": ",
          p.locations.map((l, i) => h("span", { key: l, className: "mono", style: { color: "var(--tx)" } }, (DB.driveById[l] || { name: l }).name, i < p.locations.length - 1 ? " · " : "")))));

    // folder tree
    const treeCard = cardShell("Folder Structure", "folder", "var(--tx-mut)",
      h("span", { className: "badge " + structKind(p.structure) }, p.structure + "% healthy"),
      h("div", { className: "card-pad" },
        h("div", { className: "tree" }, h("div", { className: "tree-row" }, h(Icon, { name: "folder", size: 13, style: { color: "var(--accent-hi)" } }),
          h("span", { className: "hi" }, "/" + p.client.replace(/\s+/g, "_") + "_" + p.name.split(" ")[0] + "/")),
          h("div", { className: "tree-indent" }, tree.map((f, i) => h("div", { key: i, className: "tree-row" },
            h(Icon, { name: f.status === "missing" ? "x" : "folder", size: 13, style: { color: f.status === "missing" ? "var(--risk)" : f.status === "warn" ? "var(--warn)" : "var(--tx-mut)" } }),
            h("span", { className: f.status === "missing" ? "tree-missing" : "" }, f.name),
            f.status !== "missing" && h("span", { className: "mono dim", style: { marginLeft: "auto", fontSize: 11 } }, f.sizeGB >= 1000 ? (f.sizeGB / 1000).toFixed(1) + " TB" : f.sizeGB + " GB"),
            f.status === "missing" && h("span", { className: "badge risk", style: { marginLeft: "auto", height: 18 } }, "missing"),
            f.status === "warn" && h("span", { className: "badge warn", style: { marginLeft: "auto", height: 18 } }, "cleanable")))))));

    // asset checklist
    const assets = [
      { label: "Raw footage", ok: true, note: fmtTB(p.sizeTB * 0.55) + " · verified" },
      { label: "Project files (Premiere/AE)", ok: p.structure > 60, note: p.structure > 60 ? "Present" : "03_PROJECT_FILES missing" },
      { label: "Final export", ok: p.archiveReady > 50, note: p.archiveReady > 50 ? "EP_FINAL_v7.mov" : "No final export yet" },
      { label: "Music / SFX licenses", ok: true, note: "4 license docs in 00_ADMIN" },
      { label: "Fonts & graphics", ok: true, note: "Bundled in 04_ASSETS" },
      { label: "Archive manifest", ok: missing.length === 0, note: missing.length ? "09_ARCHIVE_MANIFEST missing" : "Generated" },
    ];
    const assetCard = cardShell("Deliverable Status", "checkCircle", "var(--ok)", null,
      h("div", { style: { padding: "6px 0" } }, assets.map((a, i) => h("div", { key: i, className: "spread", style: { padding: "10px 18px", borderBottom: i < assets.length - 1 ? "1px solid var(--line-faint)" : "none" } },
        h("div", { className: "row", style: { gap: 10 } },
          h("span", { style: { width: 20, height: 20, borderRadius: 6, display: "grid", placeItems: "center", flexShrink: 0, background: a.ok ? "var(--ok-soft)" : "var(--risk-soft)", color: a.ok ? "var(--ok)" : "var(--risk)" } }, h(Icon, { name: a.ok ? "check" : "x", size: 13, stroke: 3 })),
          h("span", { className: "hi", style: { fontWeight: 600, fontSize: 13 } }, a.label)),
        h("span", { className: "muted", style: { fontSize: 11.5 } }, a.note)))));

    // duplicates
    const inProj = DB.duplicates.filter((d) => d.project === p.id);
    const dupCard = cardShell("Duplicates", "copy", "var(--warn)", h("button", { className: "btn sm ghost", onClick: () => go("duplicates") }, "Review"),
      h("div", { className: "card-pad", style: { display: "flex", flexDirection: "column", gap: 12 } },
        h("div", { className: "row", style: { gap: 12 } },
          dupStat("Inside project", fmtTB(p.dupTB), "var(--warn)"),
          dupStat("Shared w/ others", fmtTB(p.dupTB * 0.6), "var(--auto)")),
        inProj.length ? inProj.map((d) => h("div", { key: d.id, className: "spread", style: { padding: "10px 12px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
          h("div", { className: "row", style: { gap: 9, minWidth: 0 } }, h(FileTypePill, { type: d.type }), h("span", { className: "mono hi", style: { fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, d.name)),
          h("div", { className: "row", style: { gap: 8, flexShrink: 0 } }, h(Badge, { kind: RISK_META[d.risk].cls }, d.copies + "×"), h("span", { className: "mono", style: { fontSize: 12, color: "var(--tx-hi)" } }, d.sizeGB + " GB"))))
          : h("div", { className: "muted", style: { fontSize: 12.5, padding: "4px 2px" } }, "No internal duplicates detected.")));

    // recommended actions
    const recs = [
      { t: "Create missing folders", d: missing.length ? missing.map((m) => m.name).join(", ") : "Structure complete", risk: "safe", icon: "plus", disabled: !missing.length },
      { t: "Delete generated proxies", d: "After delivery approval · " + fmtTB(p.cleanTB * 0.5), risk: "review", icon: "trash" },
      { t: "Quarantine old review exports", d: "v1–v6 superseded · 1.5 TB studio-wide", risk: "review", icon: "shield" },
      { t: "Copy final exports to cloud", d: "Ensure off-site delivery copy", risk: "safe", icon: "cloud" },
      { t: "Generate archive manifest", d: "Checksums + file inventory", risk: "safe", icon: "fingerprint" },
    ];
    const recCard = cardShell("Recommended Actions", "sparkle", "var(--accent-hi)", null,
      h("div", { style: { padding: 14, display: "flex", flexDirection: "column", gap: 9 } }, recs.map((r, i) =>
        h("div", { key: i, className: "spread", style: { padding: "11px 13px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)", opacity: r.disabled ? 0.5 : 1 } },
          h("div", { className: "row", style: { gap: 11, minWidth: 0 } },
            h("span", { style: { width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", flexShrink: 0, background: "var(--" + r.risk + "-soft)", color: "var(--" + r.risk + ")", border: "1px solid var(--" + r.risk + "-line)" } }, h(Icon, { name: r.icon, size: 15 })),
            h("div", { style: { minWidth: 0 } }, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 12.5 } }, r.t), h("div", { className: "muted", style: { fontSize: 11.5 } }, r.d))),
          h("button", { className: "btn sm", disabled: r.disabled, onClick: () => toast(r.t + " queued", r.icon, r.risk === "safe" ? "ok" : "accent") }, r.disabled ? "Done" : "Run")))));

    return h("div", { className: "page-inner" },
      h("button", { className: "btn ghost sm", style: { marginBottom: 12 }, onClick: () => go("projects") }, h(Icon, { name: "chevL", size: 15 }), "All projects"),
      head, metaRow, summary,
      h("div", { style: { display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: "var(--gap)", marginBottom: "var(--gap)" } }, treeCard, h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--gap)" } }, copies, dupCard)),
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--gap)", marginBottom: "var(--gap)" } }, assetCard, recCard),
      modal === "archive" && h(ArchiveChecklistModal, { p, onClose: () => setModal(null), toast, go }));
  }

  function sumCell(label, value, icon, color) {
    return h("div", null,
      h("div", { className: "row", style: { gap: 7, marginBottom: 6 } }, h(Icon, { name: icon, size: 14, style: { color: color || "var(--tx-dim)" } }), h("span", { className: "eyebrow", style: { fontSize: 9.5 } }, label)),
      h("div", { className: "stat-num", style: { fontSize: 22, color: color || "var(--tx-hi)" } }, value));
  }
  function copyRow(label, present, icon) {
    return h("div", { className: "spread", style: { padding: "11px 13px", borderRadius: "var(--r)", background: present ? "var(--ok-soft)" : "var(--risk-soft)", border: "1px solid var(--" + (present ? "ok" : "risk") + "-line)" } },
      h("div", { className: "row", style: { gap: 10 } }, h(Icon, { name: icon, size: 16, style: { color: present ? "var(--ok)" : "var(--risk)" } }), h("span", { className: "hi", style: { fontWeight: 600, fontSize: 13 } }, label)),
      h("span", { className: "badge " + (present ? "ok" : "risk") }, present ? "Verified" : "Missing"));
  }
  function dupStat(label, value, color) {
    return h("div", { style: { flex: 1, padding: "11px 13px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
      h("div", { className: "eyebrow", style: { fontSize: 9, marginBottom: 4 } }, label),
      h("div", { className: "stat-num", style: { fontSize: 18, color } }, value));
  }

  
  


export { ProjectsScreen, ProjectDetail };
