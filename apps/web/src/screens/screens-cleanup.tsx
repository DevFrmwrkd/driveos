import React from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convexApi";
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
type CleanupPreviewState = any | null;
type RecState = "quarantined" | "ignored" | null;
type QuarantineItem = any;



/* ============================================================
   DriveOS — Cleanup, Cleanup Preview Modal, Quarantine
   ============================================================ */


  

  const GROUPS = [
    { risk: "safe", label: "Safe to recover", desc: "Regenerable or fully redundant. Auto-eligible.", icon: "shieldCheck" },
    { risk: "review", label: "Needs review", desc: "Requires producer or editor approval before quarantine.", icon: "info" },
    { risk: "danger", label: "Do not delete", desc: "Protected. Flagged for manual review only.", icon: "lock" },
  ];

  const CLEANUP_REQUESTER = "founder";

  // Create + approve a quarantine job from a recommendation. The local agent's
  // `run-jobs` command picks up the approved job and performs the actual move.
  function useQuarantineRecommendation() {
    const createJob = useMutation(api.cleanup.createJob);
    const approveJob = useMutation(api.cleanup.approveJob);
    return React.useCallback(async (r: any) => {
      const jobId = await createJob({
        recommendationId: typeof r.id === "string" ? r.id : undefined,
        requestedBy: CLEANUP_REQUESTER,
        action: "quarantine",
        affectedFileIds: r.affectedFileIds || [],
        affectedBytes: r.affectedBytes || 0,
      });
      if (jobId) await approveJob({ jobId, approvedBy: CLEANUP_REQUESTER });
      return jobId;
    }, [createJob, approveJob]);
  }

  function RecCard({ r, go, toast, onPreview }: ScreenProps) {
    const [state, setState] = React.useState<RecState>(null);
    const [busy, setBusy] = React.useState(false);
    const quarantine = useQuarantineRecommendation();
    const onQuarantine = async () => {
      if (busy) return;
      setBusy(true);
      try {
        await quarantine(r);
        setState("quarantined");
      } catch (err: any) {
        toast(err?.message || "Could not queue quarantine", "alert", "risk");
      } finally {
        setBusy(false);
      }
    };
    if (state === "quarantined")
      return h("div", { className: "card", style: { borderColor: "var(--ok-line)", background: "var(--ok-soft)" } },
        h("div", { className: "card-pad row", style: { gap: 11 } }, h(Icon, { name: "clock", size: 18, style: { color: "var(--ok)" } }),
          h("div", { style: { flex: 1 } },
            h("span", { className: "hi", style: { fontWeight: 600, display: "block" } }, r.title + " — queued for quarantine (" + fmtTB(r.recoverTB) + ")"),
            h("span", { className: "muted", style: { fontSize: 11.5 } }, "The agent moves these files on its next poll, then this recommendation clears.")),
          h("button", { className: "btn sm ghost", onClick: () => setState(null) }, "Dismiss")));
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
            r.risk !== "danger" && h("button", { className: "btn sm primary", disabled: busy, onClick: onQuarantine }, h(Icon, { name: "shield", size: 13 }), busy ? "Queuing…" : "Quarantine"),
            h("button", { className: "btn sm ghost", onClick: () => setState("ignored") }, "Ignore")))));
  }
  function catIcon(cat: string) {
    const icons: Record<string, string> = { "Cache": "cpu", "Proxies": "layers", "Duplicate stock": "globe", "Review exports": "download", "Abandoned copies": "box", "Duplicate downloads": "copy", "Unknown": "alert" };
    return icons[cat] || "broom";
  }

  function CleanupScreen({ go, toast }: ScreenProps) {
    const [preview, setPreview] = React.useState<CleanupPreviewState>(null);
    const [cat, setCat] = React.useState("all");
    const cats = [...new Set(DB.cleanup.map((c) => c.cat))];
    const filtered = cat === "all" ? DB.cleanup : DB.cleanup.filter((c) => c.cat === cat);
    const byRisk = (rk: string) => filtered.filter((c) => c.risk === rk);
    const safeT = DB.cleanup.filter((c) => c.risk === "safe").reduce((s, c) => s + c.recoverTB, 0);
    const revT = DB.cleanup.filter((c) => c.risk === "review").reduce((s, c) => s + c.recoverTB, 0);
    const protT = DB.cleanup.filter((c) => c.risk === "danger").reduce((s, c) => s + c.recoverTB, 0);
    const totalT = DB.cleanup.reduce((s, c) => s + c.recoverTB, 0);
    const heroMax = totalT > 0 ? totalT : 1;

    return h("div", { className: "page-inner" },
      h(PageHead, { eyebrow: "Maintenance", title: "Cleanup Recommendations", desc: "Every recommendation explains what was found, why it's safe, and exactly what happens next. Nothing is deleted — files move to quarantine first.",
        actions: [h("button", { key: 1, className: "btn", onClick: () => go("quarantine") }, h(Icon, { name: "shield", size: 15 }), "View Quarantine")] }),

      // hero
      h("div", { className: "card fade-up", style: { marginBottom: "var(--gap)", overflow: "hidden", background: "linear-gradient(135deg, var(--bg-panel), var(--bg-panel-2))" } },
        h("div", { style: { display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 0 } },
          h("div", { className: "card-pad", style: { padding: 28 } },
            h("div", { className: "eyebrow", style: { marginBottom: 8 } }, "Potential recovery"),
            h("div", { className: "row", style: { alignItems: "baseline", gap: 10 } },
              h("span", { className: "stat-num", style: { fontSize: 52, color: "var(--ok)" } }, totalT.toFixed(1)), h("span", { style: { fontSize: 22, color: "var(--tx-mut)", fontWeight: 600 } }, "TB")),
            h("div", { style: { fontSize: 13.5, color: "var(--tx-mut)", marginTop: 8, maxWidth: "44ch" } }, "Reclaimable across 8 categories without touching any RAW footage, final exports, or single-copy files."),
            h("div", { className: "row", style: { gap: 10, marginTop: 20 } },
              h("button", { className: "btn primary lg", onClick: () => setPreview({ title: "All safe cleanup", recoverTB: safeT, files: 36242, projects: ["studio"], risk: "safe", why: "Combined safe-to-recover categories.", action: "Move to quarantine" }) },
                h(Icon, { name: "broom", size: 16 }), "Quarantine all safe (" + fmtTB(safeT) + ")"),
              h("button", { className: "btn lg", onClick: () => go("quarantine") }, "Review queue"))),
          h("div", { style: { borderLeft: "1px solid var(--line)", padding: 28, display: "flex", flexDirection: "column", justifyContent: "center", gap: 16 } },
            recoverBar("Safe to recover", safeT, heroMax, "ok"),
            recoverBar("Needs review", revT, heroMax, "warn"),
            recoverBar("Protected (kept)", protT, heroMax, "risk"),
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

  function recoverBar(label: React.ReactNode, val: number, max: number, kind: string) {
    return h("div", null,
      h("div", { className: "spread", style: { fontSize: 12, marginBottom: 5 } }, h("span", { className: "hi", style: { fontWeight: 600 } }, label), h("span", { className: "mono", style: { color: "var(--" + kind + ")" } }, fmtTB(val))),
      h(Bar, { value: val, max, kind, height: 7 }));
  }

  // ---- Cleanup Preview Modal ----
  function CleanupPreviewModal({ r, onClose, toast, go }: ScreenProps) {
    const [approved, setApproved] = React.useState(false);
    const [busy, setBusy] = React.useState(false);
    const quarantine = useQuarantineRecommendation();
    const onMove = async () => {
      if (busy) return;
      setBusy(true);
      try {
        await quarantine(r);
        toast("Queued " + fmtNum(r.files) + " files for quarantine", "shield", "ok");
        onClose();
      } catch (err: any) {
        toast(err?.message || "Could not queue quarantine", "alert", "risk");
      } finally {
        setBusy(false);
      }
    };
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
      h("button", { key: "q", className: "btn primary", disabled: !approved || busy, onClick: onMove },
        h(Icon, { name: "shield", size: 14 }), busy ? "Queuing…" : "Move to Quarantine"),
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
  function previewStat(label: React.ReactNode, value: React.ReactNode, icon: string, color = "") {
    return h("div", { style: { padding: "12px 13px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
      h("div", { className: "row", style: { gap: 6, marginBottom: 5 } }, h(Icon, { name: icon, size: 13, style: { color: color || "var(--tx-dim)" } }), h("span", { className: "eyebrow", style: { fontSize: 9 } }, label)),
      h("div", { className: "stat-num", style: { fontSize: 17, color: color || "var(--tx-hi)" } }, value));
  }
  function verifyBox(label: React.ReactNode, ok: boolean, note: React.ReactNode) {
    return h("div", { style: { padding: "11px 13px", borderRadius: "var(--r)", background: "var(--ok-soft)", border: "1px solid var(--ok-line)", display: "flex", gap: 10 } },
      h(Icon, { name: "checkCircle", size: 16, style: { color: "var(--ok)", flexShrink: 0, marginTop: 1 } }),
      h("div", null, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 12.5 } }, label), h("div", { className: "muted", style: { fontSize: 11 } }, note)));
  }

  // ============================================================
  //  QUARANTINE
  // ============================================================
  const PURGE_REQUESTER = "founder";

  function QuarantineScreen({ go, toast }: ScreenProps) {
    const [items, setItems] = React.useState<QuarantineItem[]>(DB.quarantine);
    const [busyId, setBusyId] = React.useState<any>(null);
    const [purging, setPurging] = React.useState(false);
    const markRestored = useMutation(api.cleanup.markQuarantineRestored);
    const purgeExpired = useMutation(api.cleanup.purgeExpired);
    const purgeItem = useMutation(api.cleanup.purgeItem);
    // Live count of items past their rollback window, safe to permanently delete.
    const purgeable = useQuery(api.cleanup.purgeableCount) || { count: 0, bytes: 0 };
    // Keep local list in sync when the live Convex query updates DB.quarantine.
    React.useEffect(() => { setItems(DB.quarantine); }, [DB.quarantine]);
    const totalGB = items.reduce((s, q) => s + q.sizeGB, 0);
    const restore = async (id: any) => {
      if (busyId) return;
      setBusyId(id);
      try {
        if (typeof id === "string" && id.length > 12) await markRestored({ quarantineId: id });
        setItems((x) => x.filter((q) => q.id !== id));
        toast("File restored to original location", "rotate", "accent");
      } catch (err: any) {
        toast(err?.message || "Could not restore file", "alert", "risk");
      } finally {
        setBusyId(null);
      }
    };
    // Per-row permanent delete of a single item, regardless of its 14-day
    // window. Queues a purge job the agent runs on its next poll — the row shows
    // "Deleting…" until the agent confirms and the live query drops it. If the
    // agent is offline the row stays; that's honest (nothing deleted yet).
    const deleteOne = async (q: any) => {
      if (busyId) return;
      if (!window.confirm(`Permanently delete "${q.name}"? This cannot be undone.`)) return;
      setBusyId(q.id);
      try {
        if (typeof q.id === "string" && q.id.length > 12) {
          const r = await purgeItem({ quarantineId: q.id, requestedBy: PURGE_REQUESTER });
          toast(r.queued ? "Queued for permanent deletion — the agent will remove it shortly" : "Could not queue delete", r.queued ? "trash" : "alert", r.queued ? "risk" : "risk");
        }
      } catch (err: any) {
        toast(err?.message || "Could not delete file", "alert", "risk");
      } finally {
        setBusyId(null);
      }
    };
    // Permanently delete every item past its 14-day window. Irreversible, so it
    // confirms first and only ever targets expired items (the backend enforces
    // this too). The agent does the actual on-disk deletion on its next poll.
    const onPurgeExpired = async () => {
      if (purging || purgeable.count === 0) return;
      if (!window.confirm(`Permanently delete ${purgeable.count} expired file(s) and free ${fmtGB(purgeable.bytes / (1024 ** 3))}? This cannot be undone.`)) return;
      setPurging(true);
      try {
        const r = await purgeExpired({ requestedBy: PURGE_REQUESTER });
        toast(`Queued ${r.queued} file(s) for permanent deletion`, "trash", "risk");
      } catch (err: any) {
        toast(err?.message || "Could not queue purge", "alert", "risk");
      } finally {
        setPurging(false);
      }
    };

    return h("div", { className: "page-inner" },
      h(PageHead, { eyebrow: "Maintenance", title: "Quarantine", desc: "A safe deletion buffer. Files stay restorable for 14 days, then can be permanently removed to free disk space.",
        actions: [
          h("button", { key: 1, className: "btn", onClick: () => go("cleanup") }, h(Icon, { name: "chevL", size: 15 }), "Back to Cleanup"),
          h("button", { key: 2, className: "btn danger", disabled: purging || purgeable.count === 0,
            title: purgeable.count === 0 ? "No files have passed their 14-day window yet. Use the per-row Delete to remove one sooner." : `Permanently delete ${purgeable.count} expired file(s)`,
            onClick: onPurgeExpired },
            h(Icon, { name: "trash", size: 15 }), purging ? "Queuing…" : purgeable.count > 0 ? `Empty expired (${purgeable.count})` : "Empty expired"),
        ] }),

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
                  h("button", { className: "btn sm", disabled: busyId === q.id, onClick: () => restore(q.id) }, h(Icon, { name: "rotate", size: 13 }), busyId === q.id ? "…" : "Restore"),
                  h("button", { className: "btn sm danger", disabled: busyId === q.id, title: "Permanently delete this file now", onClick: () => deleteOne(q) }, h(Icon, { name: "trash", size: 13 }), busyId === q.id ? "…" : "Delete"))))))) ),

      // audit log
      cardShell("Audit Log", "list", "var(--tx-mut)", null,
        h("div", { style: { padding: "6px 0" } }, DB.audit.map((a, i) => h("div", { key: i, className: "row", style: { gap: 13, padding: "11px 18px", borderBottom: i < DB.audit.length - 1 ? "1px solid var(--line-faint)" : "none" } },
          h("span", { style: { width: 28, height: 28, borderRadius: 7, display: "grid", placeItems: "center", flexShrink: 0, background: auditColor(a.kind) + "20", color: auditColor(a.kind) } }, h(Icon, { name: auditIcon(a.kind), size: 14 })),
          h("div", { style: { flex: 1, minWidth: 0 } }, h("div", { style: { fontSize: 12.5, color: "var(--tx)" } }, h("b", { className: "hi" }, a.who), " — ", a.action)),
          h("span", { className: "mono dim", style: { fontSize: 11, flexShrink: 0 } }, a.date + " · " + a.time))))));
  }
  function byName(name: string) { const m = DB.team.find((t) => t.name === name); return m ? m.id : "founder"; }
  function auditColor(k: string) {
    const colors: Record<string, string> = { quarantine: "var(--warn)", scan: "var(--accent)", auto: "var(--auto)", approve: "var(--ok)", create: "var(--cloud)", restore: "var(--ok)" };
    return colors[k] || "var(--tx-mut)";
  }
  function auditIcon(k: string) {
    const icons: Record<string, string> = { quarantine: "shield", scan: "refresh", auto: "cpu", approve: "check", create: "plus", restore: "rotate" };
    return icons[k] || "activity";
  }
  function qkpi(label: React.ReactNode, value: React.ReactNode, icon: string, color: string) {
    return h("div", { className: "card card-pad fade-up", style: { display: "flex", alignItems: "center", gap: 13 } },
      h("div", { style: { width: 38, height: 38, borderRadius: 10, display: "grid", placeItems: "center", flexShrink: 0, background: "var(--bg-surface)", color, border: "1px solid var(--line)" } }, h(Icon, { name: icon, size: 18 })),
      h("div", null, h("div", { className: "stat-num", style: { fontSize: 21, color } }, value), h("div", { className: "eyebrow", style: { fontSize: 9.5, marginTop: 1 } }, label)));
  }

  
  


export { CleanupScreen, QuarantineScreen };
