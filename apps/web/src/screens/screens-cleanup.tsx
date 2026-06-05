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
   DriveOS — Cleanup, Cleanup Preview Modal, Quarantine
   ============================================================ */


  

  const GROUPS = [
    { risk: "safe", label: "Safe to recover", desc: "Regenerable or fully redundant. Auto-eligible.", icon: "shieldCheck" },
    { risk: "review", label: "Needs review", desc: "Requires producer or editor approval before quarantine.", icon: "info" },
    { risk: "danger", label: "Do not delete", desc: "Protected. Flagged for manual review only.", icon: "lock" },
  ];

  function RecCard({ r, go, toast, onPreview }) {
    const [state, setState] = React.useState(null);
    if (state === "quarantined")
      return h("div", { className: "card", style: { borderColor: "var(--ok-line)", background: "var(--ok-soft)" } },
        h("div", { className: "card-pad row", style: { gap: 11 } }, h(Icon, { name: "checkCircle", size: 18, style: { color: "var(--ok)" } }),
          h("span", { className: "hi", style: { fontWeight: 600, flex: 1 } }, r.title + " — quarantined (" + fmtTB(r.recoverTB) + ")"),
          h("button", { className: "btn sm ghost", onClick: () => setState(null) }, "Undo")));
    if (state === "ignored")
      return h("div", { className: "card", style: { opacity: 0.55 } }, h("div", { className: "card-pad row", style: { gap: 11 } }, h(Icon, { name: "x", size: 16, style: { color: "var(--tx-dim)" } }),
        h("span", { className: "muted", style: { flex: 1 } }, r.title + " — ignored"), h("button", { className: "btn sm ghost", onClick: () => setState(null) }, "Restore")));

    return h("div", { className: "card fade-up" },
      h("div", { className: "card-pad", style: { display: "flex", gap: 14 } },
        h("div", { style: { width: 42, height: 42, borderRadius: 11, flexShrink: 0, display: "grid", placeItems: "center", background: "var(--" + r.risk + "-soft)", color: "var(--" + r.risk + ")", border: "1px solid var(--" + r.risk + "-line)" } },
          h(Icon, { name: catIcon(r.cat), size: 19 })),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { className: "spread" },
            h("div", { className: "row", style: { gap: 9, minWidth: 0 } }, h("span", { className: "hi", style: { fontWeight: 600, fontSize: 14 } }, r.title),
              r.approval && h(Badge, { kind: "warn", icon: "user" }, "Approval required")),
            h("div", { className: "row", style: { gap: 6, flexShrink: 0 } }, h("span", { className: "stat-num", style: { fontSize: 20, color: "var(--" + r.risk + ")" } }, fmtTB(r.recoverTB)))),
          h("div", { className: "muted", style: { fontSize: 12.5, marginTop: 5, lineHeight: 1.5, maxWidth: "70ch" } }, r.why),
          h("div", { className: "row", style: { gap: 14, marginTop: 10, flexWrap: "wrap", fontSize: 11.5 } },
            h("span", { className: "tag" }, h(Icon, { name: "copy", size: 12 }), fmtNum(r.files) + " files"),
            h("span", { className: "tag" }, h(Icon, { name: "folder", size: 12 }), r.projects[0] === "—" ? "Studio-wide" : r.projects.length + " projects"),
            h("span", { className: "muted" }, h("b", { className: "hi" }, "Next: "), r.action)),
          h("div", { className: "row", style: { gap: 8, marginTop: 14 } },
            h("button", { className: "btn sm", onClick: () => onPreview(r) }, h(Icon, { name: "eye", size: 13 }), "Preview"),
            r.risk !== "danger" && h("button", { className: "btn sm primary", onClick: () => setState("quarantined") }, h(Icon, { name: "shield", size: 13 }), "Quarantine"),
            h("button", { className: "btn sm ghost", onClick: () => setState("ignored") }, "Ignore")))));
  }
  function catIcon(cat) {
    return ({ "Cache": "cpu", "Proxies": "layers", "Duplicate stock": "globe", "Review exports": "download", "Abandoned copies": "box", "Duplicate downloads": "copy", "Unknown": "alert" })[cat] || "broom";
  }

  function CleanupScreen({ go, toast }) {
    const [preview, setPreview] = React.useState(null);
    const [cat, setCat] = React.useState("all");
    const cats = [...new Set(DB.cleanup.map((c) => c.cat))];
    const filtered = cat === "all" ? DB.cleanup : DB.cleanup.filter((c) => c.cat === cat);
    const byRisk = (rk) => filtered.filter((c) => c.risk === rk);
    const safeT = DB.cleanup.filter((c) => c.risk === "safe").reduce((s, c) => s + c.recoverTB, 0);
    const revT = DB.cleanup.filter((c) => c.risk === "review").reduce((s, c) => s + c.recoverTB, 0);

    return h("div", { className: "page-inner" },
      h(PageHead, { eyebrow: "Maintenance", title: "Cleanup Recommendations", desc: "Every recommendation explains what was found, why it's safe, and exactly what happens next. Nothing is deleted — files move to quarantine first.",
        actions: [h("button", { key: 1, className: "btn", onClick: () => go("quarantine") }, h(Icon, { name: "shield", size: 15 }), "View Quarantine")] }),

      // hero
      h("div", { className: "card fade-up", style: { marginBottom: "var(--gap)", overflow: "hidden", background: "linear-gradient(135deg, var(--bg-panel), var(--bg-panel-2))" } },
        h("div", { style: { display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 0 } },
          h("div", { className: "card-pad", style: { padding: 28 } },
            h("div", { className: "eyebrow", style: { marginBottom: 8 } }, "Potential recovery"),
            h("div", { className: "row", style: { alignItems: "baseline", gap: 10 } },
              h("span", { className: "stat-num", style: { fontSize: 52, color: "var(--ok)" } }, "8.6"), h("span", { style: { fontSize: 22, color: "var(--tx-mut)", fontWeight: 600 } }, "TB")),
            h("div", { style: { fontSize: 13.5, color: "var(--tx-mut)", marginTop: 8, maxWidth: "44ch" } }, "Reclaimable across 8 categories without touching any RAW footage, final exports, or single-copy files."),
            h("div", { className: "row", style: { gap: 10, marginTop: 20 } },
              h("button", { className: "btn primary lg", onClick: () => setPreview({ title: "All safe cleanup", recoverTB: safeT, files: 36242, projects: ["studio"], risk: "safe", why: "Combined safe-to-recover categories.", action: "Move to quarantine" }) },
                h(Icon, { name: "broom", size: 16 }), "Quarantine all safe (" + fmtTB(safeT) + ")"),
              h("button", { className: "btn lg", onClick: () => go("quarantine") }, "Review queue"))),
          h("div", { style: { borderLeft: "1px solid var(--line)", padding: 28, display: "flex", flexDirection: "column", justifyContent: "center", gap: 16 } },
            recoverBar("Safe to recover", safeT, 8.6, "ok"),
            recoverBar("Needs review", revT, 8.6, "warn"),
            recoverBar("Protected (kept)", 0.4, 8.6, "risk"),
            h("div", { className: "mono dim", style: { fontSize: 11, marginTop: 2 } }, "Quarantine retention: 30 days · full rollback")))),

      // category chips
      h("div", { className: "chip-row", style: { marginBottom: "var(--gap)" } },
        h("button", { className: "badge " + (cat === "all" ? "accent" : ""), style: { cursor: "pointer", height: 28, padding: "0 12px" }, onClick: () => setCat("all") }, "All categories"),
        cats.map((c) => h("button", { key: c, className: "badge " + (cat === c ? "accent" : ""), style: { cursor: "pointer", height: 28, padding: "0 12px" }, onClick: () => setCat(c) },
          h(Icon, { name: catIcon(c), size: 12 }), c))),

      // grouped recommendations
      GROUPS.map((g) => {
        const items = byRisk(g.risk);
        if (!items.length) return null;
        return h("div", { key: g.risk, style: { marginBottom: 26 } },
          h("div", { className: "row", style: { gap: 10, marginBottom: 13 } },
            h("span", { style: { width: 28, height: 28, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--" + g.risk + "-soft)", color: "var(--" + g.risk + ")" } }, h(Icon, { name: g.icon, size: 15 })),
            h("h3", { style: { fontSize: 15 } }, g.label),
            h(Badge, { kind: RISK_META[g.risk] ? RISK_META[g.risk].cls : "" }, items.length),
            h("span", { className: "muted", style: { fontSize: 12 } }, g.desc)),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 11 } }, items.map((r) => h(RecCard, { key: r.id, r, go, toast, onPreview: setPreview }))));
      }),

      preview && h(CleanupPreviewModal, { r: preview, onClose: () => setPreview(null), toast, go }));
  }

  function recoverBar(label, val, max, kind) {
    return h("div", null,
      h("div", { className: "spread", style: { fontSize: 12, marginBottom: 5 } }, h("span", { className: "hi", style: { fontWeight: 600 } }, label), h("span", { className: "mono", style: { color: "var(--" + kind + ")" } }, fmtTB(val))),
      h(Bar, { value: val, max, kind, height: 7 }));
  }

  // ---- Cleanup Preview Modal ----
  function CleanupPreviewModal({ r, onClose, toast, go }) {
    const [approved, setApproved] = React.useState(false);
    const sampleFiles = [
      { path: "/Show_X/06_RENDERS_CACHE/Premiere Pro Video Previews/", size: "182 GB", type: "cache" },
      { path: "/Show_X/05_PROXIES/A_CAM/A001_C004_proxy.mov", size: "4.2 GB", type: "proxy" },
      { path: "/Brand_Films/06_RENDERS_CACHE/peakfiles/", size: "96 GB", type: "cache" },
      { path: "/Japan_Ep03/05_PROXIES/DRONE/", size: "38 GB", type: "proxy" },
      { path: "/Social_Q3/06_RENDERS_CACHE/auto-save/", size: "12 GB", type: "cache" },
    ];
    const footer = [
      h("div", { key: "a", className: "row", style: { gap: 10, marginRight: "auto" } },
        h(Check, { on: approved, onChange: setApproved }),
        h("span", { style: { fontSize: 12.5, color: "var(--tx)" } }, "I understand these files move to quarantine and can be restored for 30 days.")),
      h("button", { key: "c", className: "btn", onClick: onClose }, "Cancel"),
      h("button", { key: "r", className: "btn", onClick: () => toast("Report exported", "download", "accent") }, h(Icon, { name: "download", size: 14 }), "Export Report"),
      h("button", { key: "q", className: "btn primary", disabled: !approved, onClick: () => { toast("Moved " + fmtNum(r.files) + " files to quarantine", "shield", "ok"); onClose(); } },
        h(Icon, { name: "shield", size: 14 }), "Move to Quarantine"),
    ];
    return h(Modal, { title: r.title, subtitle: "Preview before anything moves", icon: "broom", iconKind: "ok", onClose, footer, width: 760 },
      h("div", { style: { padding: "13px 15px", borderRadius: "var(--r)", background: "var(--ok-soft)", border: "1px solid var(--ok-line)", marginBottom: 18, display: "flex", gap: 10 } },
        h(Icon, { name: "shieldCheck", size: 18, style: { color: "var(--ok)", flexShrink: 0 } }),
        h("div", { style: { fontSize: 12.5, color: "var(--tx)", lineHeight: 1.5 } }, h("b", { className: "hi" }, "Nothing is permanently deleted. "), "Files move to a protected quarantine folder with a 30-day rollback window. You can restore everything until then.")),

      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 18 } },
        previewStat("Files affected", fmtNum(r.files), "copy"),
        previewStat("Total size", fmtTB(r.recoverTB), "database"),
        previewStat("Risk level", RISK_META[r.risk].label, r.risk === "safe" ? "shieldCheck" : "info", "var(--" + r.risk + ")"),
        previewStat("Rollback", "30 days", "rotate")),

      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 } },
        verifyBox("Archive copy verified", true, "Originals checksum-matched on Brandon Archive 01"),
        verifyBox("Cloud copy verified", true, "Delivery copies present in Google Drive")),

      h("div", { className: "eyebrow", style: { marginBottom: 8 } }, "Affected files (sample)"),
      h("div", { style: { border: "1px solid var(--line)", borderRadius: "var(--r)", overflow: "hidden" } },
        sampleFiles.map((f, i) => h("div", { key: i, className: "spread", style: { padding: "9px 13px", borderBottom: i < sampleFiles.length - 1 ? "1px solid var(--line-faint)" : "none", background: "var(--bg-input)" } },
          h("div", { className: "row", style: { gap: 9, minWidth: 0 } }, h("span", { style: { width: 7, height: 7, borderRadius: 2, background: "var(--ft-" + f.type + ")", flexShrink: 0 } }),
            h("span", { className: "mono", style: { fontSize: 11.5, color: "var(--tx)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, f.path)),
          h("span", { className: "mono", style: { fontSize: 11.5, color: "var(--tx-mut)", flexShrink: 0, marginLeft: 10 } }, f.size)))));
  }
  function previewStat(label, value, icon, color) {
    return h("div", { style: { padding: "12px 13px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
      h("div", { className: "row", style: { gap: 6, marginBottom: 5 } }, h(Icon, { name: icon, size: 13, style: { color: color || "var(--tx-dim)" } }), h("span", { className: "eyebrow", style: { fontSize: 9 } }, label)),
      h("div", { className: "stat-num", style: { fontSize: 17, color: color || "var(--tx-hi)" } }, value));
  }
  function verifyBox(label, ok, note) {
    return h("div", { style: { padding: "11px 13px", borderRadius: "var(--r)", background: "var(--ok-soft)", border: "1px solid var(--ok-line)", display: "flex", gap: 10 } },
      h(Icon, { name: "checkCircle", size: 16, style: { color: "var(--ok)", flexShrink: 0, marginTop: 1 } }),
      h("div", null, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 12.5 } }, label), h("div", { className: "muted", style: { fontSize: 11 } }, note)));
  }

  // ============================================================
  //  QUARANTINE
  // ============================================================
  function QuarantineScreen({ go, toast }) {
    const [items, setItems] = React.useState(DB.quarantine);
    const totalGB = items.reduce((s, q) => s + q.sizeGB, 0);
    const restore = (id) => { setItems((x) => x.filter((q) => q.id !== id)); toast("File restored to original location", "rotate", "accent"); };
    const purge = (id) => { setItems((x) => x.filter((q) => q.id !== id)); toast("Permanently deleted", "trash", "risk"); };

    return h("div", { className: "page-inner" },
      h(PageHead, { eyebrow: "Maintenance", title: "Quarantine", desc: "A safe deletion buffer. Files stay restorable for 30 days before they can be permanently removed.",
        actions: [h("button", { key: 1, className: "btn", onClick: () => go("cleanup") }, h(Icon, { name: "chevL", size: 15 }), "Back to Cleanup")] }),

      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: "var(--gap)", marginBottom: "var(--gap)" } },
        qkpi("In Quarantine", fmtGB(totalGB), "shield", "var(--warn)"),
        qkpi("Items", items.length, "copy", "var(--tx-hi)"),
        qkpi("Restorable", items.filter((q) => q.verified).length + " / " + items.length, "rotate", "var(--ok)"),
        qkpi("Next purge", "Jun 16", "clock", "var(--tx-mut)")),

      items.length === 0
        ? h("div", { className: "card" }, h("div", { className: "empty" }, h("div", { className: "empty-ico" }, h(Icon, { name: "shieldCheck", size: 24 })), h("h3", null, "Quarantine is empty"), h("div", { className: "muted" }, "Cleared files appear here with a 30-day restore window.")))
        : h("div", { className: "card", style: { overflow: "hidden", marginBottom: "var(--gap)" } },
            h("table", { className: "tbl" },
              h("thead", null, h("tr", null, ["File", "Reason", "Moved by", "Date", "Restore by", "Size", ""].map((c, i) => h("th", { key: i, className: i === 5 ? "num" : "" }, c)))),
              h("tbody", null, items.map((q) => h("tr", { key: q.id, style: { cursor: "default" } },
                h("td", null, h("div", { style: { minWidth: 0 } },
                  h("div", { className: "mono hi", style: { fontSize: 12, fontWeight: 600 } }, q.name),
                  h("div", { className: "mono dim", style: { fontSize: 10.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 280 } }, q.origin))),
                h("td", { className: "muted", style: { fontSize: 12, maxWidth: 200 } }, q.reason),
                h("td", null, h("div", { className: "row", style: { gap: 7 } }, q.by.includes("Agent") ? h(Icon, { name: "cpu", size: 15, style: { color: "var(--auto)" } }) : h(Avatar, { id: byName(q.by), size: 20 }), h("span", { style: { fontSize: 12 } }, q.by.replace("DriveOS ", "")))),
                h("td", { className: "mono muted", style: { fontSize: 11.5 } }, q.date),
                h("td", null, h("span", { className: "mono", style: { fontSize: 11.5, color: "var(--warn)" } }, q.deadline)),
                h("td", { className: "num mono hi" }, fmtGB(q.sizeGB)),
                h("td", null, h("div", { className: "row", style: { gap: 6, justifyContent: "flex-end" } },
                  h("button", { className: "btn sm", onClick: () => restore(q.id) }, h(Icon, { name: "rotate", size: 13 }), "Restore"),
                  h("button", { className: "btn sm danger icon", title: "Permanently delete", onClick: () => purge(q.id) }, h(Icon, { name: "trash", size: 14 })))))))) ),

      // audit log
      cardShell("Audit Log", "list", "var(--tx-mut)", null,
        h("div", { style: { padding: "6px 0" } }, DB.audit.map((a, i) => h("div", { key: i, className: "row", style: { gap: 13, padding: "11px 18px", borderBottom: i < DB.audit.length - 1 ? "1px solid var(--line-faint)" : "none" } },
          h("span", { style: { width: 28, height: 28, borderRadius: 7, display: "grid", placeItems: "center", flexShrink: 0, background: auditColor(a.kind) + "20", color: auditColor(a.kind) } }, h(Icon, { name: auditIcon(a.kind), size: 14 })),
          h("div", { style: { flex: 1, minWidth: 0 } }, h("div", { style: { fontSize: 12.5, color: "var(--tx)" } }, h("b", { className: "hi" }, a.who), " — ", a.action)),
          h("span", { className: "mono dim", style: { fontSize: 11, flexShrink: 0 } }, a.date + " · " + a.time))))));
  }
  function byName(name) { const m = DB.team.find((t) => t.name === name); return m ? m.id : "founder"; }
  function auditColor(k) { return ({ quarantine: "var(--warn)", scan: "var(--accent)", auto: "var(--auto)", approve: "var(--ok)", create: "var(--cloud)", restore: "var(--ok)" })[k] || "var(--tx-mut)"; }
  function auditIcon(k) { return ({ quarantine: "shield", scan: "refresh", auto: "cpu", approve: "check", create: "plus", restore: "rotate" })[k] || "activity"; }
  function qkpi(label, value, icon, color) {
    return h("div", { className: "card card-pad fade-up", style: { display: "flex", alignItems: "center", gap: 13 } },
      h("div", { style: { width: 38, height: 38, borderRadius: 10, display: "grid", placeItems: "center", flexShrink: 0, background: "var(--bg-surface)", color, border: "1px solid var(--line)" } }, h(Icon, { name: icon, size: 18 })),
      h("div", null, h("div", { className: "stat-num", style: { fontSize: 21, color } }, value), h("div", { className: "eyebrow", style: { fontSize: 9.5, marginTop: 1 } }, label)));
  }

  
  


export { CleanupScreen, QuarantineScreen };
