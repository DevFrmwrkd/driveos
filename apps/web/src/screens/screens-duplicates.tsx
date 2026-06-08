import React from "react";
import { useMutation } from "convex/react";
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
type AnyRecord = Record<string, any>;



/* ============================================================
   DriveOS — Duplicate Center
   ============================================================ */


  

  const KIND_LABEL: Record<string, string> = { exact: "Exact match", likely: "Likely duplicate", samename: "Same name, diff. content", stock: "Stock duplicated across projects" };

  function fmtDuplicateSize(gb: number) {
    if (gb >= 1000) return fmtGB(gb);
    if (gb >= 10) return Math.round(gb) + " GB";
    if (gb >= 1) return gb.toFixed(1) + " GB";
    const mb = gb * 1024;
    if (mb >= 1) return Math.round(mb) + " MB";
    return Math.max(1, Math.round(mb * 1024)) + " KB";
  }

  const DUP_REQUESTER = "founder";

  function ClusterCard({ c, go, toast }: ScreenProps) {
    const [roles, setRoles] = React.useState<string[]>(() => c.locations.map((l: any) => l.role));
    const [resolved, setResolved] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const createJob = useMutation(api.cleanup.createJob);
    const approveJob = useMutation(api.cleanup.approveJob);
    const updateClusterStatus = useMutation(api.duplicates.updateStatus);

    // Quarantine every copy in the cluster except the recommended keep file.
    const onQuarantine = async (label: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const isConvexCluster = typeof c.id === "string" && c.id.length > 12;
        const allIds: string[] = Array.isArray(c.fileIds) ? c.fileIds : [];
        const keepId = c.recommendedKeepFileId;
        const quarantineIds = allIds.filter((id) => id !== keepId);
        if (isConvexCluster && quarantineIds.length > 0) {
          const sizeBytes = c.sizeGB * (1024 ** 3);
          const jobId = await createJob({
            requestedBy: DUP_REQUESTER,
            action: "quarantine",
            affectedFileIds: quarantineIds,
            affectedBytes: Math.round(sizeBytes * quarantineIds.length),
          });
          if (jobId) await approveJob({ jobId, approvedBy: DUP_REQUESTER });
        }
        if (isConvexCluster) await updateClusterStatus({ clusterId: c.id, status: "quarantined" });
        setResolved(label);
      } catch (err: any) {
        toast(err?.message || "Could not queue quarantine", "alert", "risk");
      } finally {
        setBusy(false);
      }
    };

    const onIntentional = async () => {
      if (busy) return;
      setBusy(true);
      try {
        if (typeof c.id === "string" && c.id.length > 12) await updateClusterStatus({ clusterId: c.id, status: "resolved" });
        setResolved("Marked intentional");
      } catch (err: any) {
        toast(err?.message || "Could not update cluster", "alert", "risk");
      } finally {
        setBusy(false);
      }
    };

    const onIgnore = async () => {
      try {
        if (typeof c.id === "string" && c.id.length > 12) await updateClusterStatus({ clusterId: c.id, status: "ignored" });
        toast("Cluster ignored", "x", "accent");
      } catch (err: any) {
        toast(err?.message || "Could not ignore cluster", "alert", "risk");
      }
    };
    const keepCount = roles.filter((r: string) => r === "keep").length;
    const quarCount = roles.filter((r: string) => r === "quarantine").length;
    const recover = c.locations.reduce((s: number, l: any, i: number) => s + (roles[i] === "quarantine" ? c.sizeGB : 0), 0);
    const riskMeta = (RISK_META as AnyRecord)[c.risk] || RISK_META.review;

    const cycle = (i: number) => {
      const order = ["keep", "quarantine", "review"];
      setRoles((r) => r.map((x: string, j: number) => j === i ? order[(order.indexOf(x) + 1) % order.length] : x));
    };

    if (resolved) {
      return h("div", { className: "card fade-up", style: { borderColor: "var(--ok-line)", background: "var(--ok-soft)" } },
        h("div", { className: "card-pad row", style: { gap: 12 } },
          h(Icon, { name: "checkCircle", size: 20, style: { color: "var(--ok)" } }),
          h("div", { style: { flex: 1 } }, h("div", { className: "hi", style: { fontWeight: 600 } }, c.name + " · " + resolved),
            h("div", { className: "muted", style: { fontSize: 12 } }, resolved === "Quarantined" ? "Moved " + quarCount + " copies to quarantine · recovered " + fmtDuplicateSize(recover) : "Marked as intentional redundancy")),
          h("button", { className: "btn sm ghost", onClick: () => setResolved(null) }, "Undo")));
    }

    return h("div", { className: "card fade-up" },
      // header
      h("div", { className: "card-pad", style: { paddingBottom: 14, display: "flex", gap: 14, alignItems: "flex-start" } },
        h("div", { style: { width: 46, height: 46, borderRadius: 11, flexShrink: 0, display: "grid", placeItems: "center", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
          h(Icon, { name: FT_ICON[c.type] || "box", size: 20, style: { color: "var(--ft-" + c.type + ")" } })),
        h("div", { style: { flex: 1, minWidth: 0 } },
          h("div", { className: "spread" },
            h("div", { className: "row", style: { gap: 9, minWidth: 0 } },
              h("span", { className: "mono hi", style: { fontSize: 14, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, c.name),
              h(Badge, { kind: riskMeta.cls, icon: c.risk === "danger" ? "lock" : c.risk === "safe" ? "shieldCheck" : "info" }, riskMeta.label)),
            h("div", { className: "row", style: { gap: 8, flexShrink: 0 } },
              h("span", { className: "stat-num", style: { fontSize: 18 } }, fmtDuplicateSize(c.sizeGB)),
              h("span", { className: "muted", style: { fontSize: 12 } }, "× " + c.copies))),
          h("div", { className: "row", style: { gap: 14, marginTop: 6, fontSize: 11.5, flexWrap: "wrap" } },
            h("span", { className: "tag" }, KIND_LABEL[c.kind] || "Duplicate cluster"),
            h("span", { className: "muted" }, h(Icon, { name: "fingerprint", size: 12, style: { verticalAlign: "-2px", marginRight: 4 } }), c.fingerprint),
            c.project !== "—" && h("span", { className: "muted" }, "Project: ", h("b", { className: "hi" }, (DB.projectById[c.project] || {}).name || c.project)),
            h("span", { className: "muted" }, "Modified ", c.modified)))),
      // locations
      h("div", { style: { borderTop: "1px solid var(--line)" } },
        c.locations.map((l: any, i: number) => {
          const role = roles[i];
          const drive = (DB.driveById as AnyRecord)[l.drive] || { name: l.drive, status: "offline" };
          const rc = role === "keep" ? "ok" : role === "quarantine" ? "warn" : "cloud";
          return h("div", { key: i, className: "spread", style: { padding: "11px 18px", borderBottom: i < c.locations.length - 1 ? "1px solid var(--line-faint)" : "none", background: role === "quarantine" ? "var(--warn-soft)" : "transparent" } },
            h("div", { className: "row", style: { gap: 11, minWidth: 0, flex: 1 } },
              h(Icon, { name: drive.status === "cloud" ? "cloud" : "hdd", size: 15, style: { color: "var(--tx-dim)", flexShrink: 0 } }),
              h("div", { style: { minWidth: 0 } },
                h("div", { className: "mono", style: { fontSize: 11.5, color: "var(--tx)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, l.path),
                h("div", { className: "row", style: { gap: 7, marginTop: 2 } }, h("span", { className: "muted", style: { fontSize: 11 } }, drive.name), h("span", { className: "dim", style: { fontSize: 11 } }, "· " + l.tag)))),
            h("button", { className: "badge " + rc, style: { cursor: "pointer", height: 24 }, onClick: () => cycle(i) },
              h(Icon, { name: role === "keep" ? "shieldCheck" : role === "quarantine" ? "shield" : "eye", size: 12 }),
              role === "keep" ? "Keep" : role === "quarantine" ? "Quarantine" : "Review"));
        })),
      // recommendation
      h("div", { style: { padding: "13px 18px", background: "var(--accent-soft)", borderTop: "1px solid var(--accent-line)", display: "flex", gap: 10, alignItems: "flex-start" } },
        h(Icon, { name: "sparkle", size: 15, style: { color: "var(--accent-hi)", marginTop: 1, flexShrink: 0 } }),
        h("div", { style: { fontSize: 12.5, color: "var(--tx)", lineHeight: 1.5 } }, h("b", { className: "hi" }, "Recommendation · "), c.rec)),
      // actions
      h("div", { className: "spread", style: { padding: "13px 18px", borderTop: "1px solid var(--line)" } },
        h("div", { className: "row", style: { gap: 8 } },
          h("span", { className: "mono", style: { fontSize: 12, color: "var(--tx-mut)" } }, "Keep ", h("b", { style: { color: "var(--ok)" } }, keepCount), " · Quarantine ", h("b", { style: { color: "var(--warn)" } }, quarCount)),
          recover > 0 && h(Badge, { kind: "ok" }, "Recover " + fmtDuplicateSize(recover))),
        h("div", { className: "row", style: { gap: 8 } },
          h("button", { className: "btn sm ghost", disabled: busy, onClick: onIgnore }, "Ignore"),
          h("button", { className: "btn sm", disabled: busy, onClick: onIntentional }, h(Icon, { name: "flag", size: 13 }), "Intentional"),
          h("button", { className: "btn sm primary", disabled: quarCount === 0 || c.risk === "danger" || busy, onClick: () => onQuarantine("Quarantined") },
            h(Icon, { name: "shield", size: 13 }), busy ? "Queuing…" : "Quarantine " + quarCount))));
  }

  function DuplicateCenter({ go, toast }: ScreenProps) {
    const [kind, setKind] = React.useState("all");
    const [risk, setRisk] = React.useState("all");
    const [scope, setScope] = React.useState("all");

    let list = DB.duplicates.filter((c) =>
      (kind === "all" || c.kind === kind) &&
      (risk === "all" || c.risk === risk) &&
      (scope === "all" ||
        (scope === "drives" && new Set(c.locations.map((l: any) => l.drive)).size > 1) ||
        (scope === "cloud" && c.locations.some((l: any) => ((DB.driveById as AnyRecord)[l.drive] || {}).status === "cloud")) ||
        (scope === "project" && c.project !== "—")));

    const totalRecover = DB.duplicates.reduce((s, c) => s + c.recoverGB, 0);
    // Derived from live duplicate clusters rather than hardcoded figures.
    const totalDupTB = DB.duplicates.reduce((s, c) => s + (c.sizeGB * c.copies) / 1024, 0);
    const clusterCount = DB.duplicates.length;
    const recoverByRisk = (rk: string) => DB.duplicates.filter((c) => c.risk === rk).reduce((s, c) => s + c.recoverGB, 0);
    const reviewTB = recoverByRisk("review") / 1024;
    const protectedTB = recoverByRisk("danger") / 1024;

    return h("div", { className: "page-inner" },
      h(PageHead, { eyebrow: "Maintenance", title: "Duplicate Center", desc: "Review duplicate clusters across every drive and the cloud. Nothing is deleted — confirmed copies move to a recoverable quarantine.",
        actions: [h("button", { key: 1, className: "btn", onClick: () => toast("Re-running fingerprint match…", "fingerprint", "accent") }, h(Icon, { name: "refresh", size: 15 }), "Re-scan")] }),

      // summary
      h("div", { className: "card fade-up", style: { marginBottom: "var(--gap)", display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", gap: 0 } },
        h("div", { className: "card-pad", style: { display: "flex", flexDirection: "column", justifyContent: "center", gap: 4 } },
          h("div", { className: "eyebrow" }, "Total Duplicate Storage"),
          h("div", { className: "row", style: { alignItems: "baseline", gap: 8 } }, h("span", { className: "stat-num", style: { fontSize: 34 } }, totalDupTB.toFixed(1)), h("span", { style: { fontSize: 16, color: "var(--tx-mut)", fontWeight: 600 } }, "TB")),
          h("div", { className: "muted", style: { fontSize: 12 } }, "across ", h("b", { className: "hi" }, fmtNum(clusterCount) + " cluster" + (clusterCount === 1 ? "" : "s")))),
        sumBox("Safe to recover", fmtDuplicateSize(totalRecover), "var(--ok)", "shieldCheck"),
        sumBox("Needs review", fmtTB(reviewTB), "var(--warn)", "info"),
        sumBox("Protected", fmtTB(protectedTB), "var(--risk)", "lock")),

      // filters
      h("div", { className: "filter-bar" },
        h(Icon, { name: "filter", size: 15, style: { color: "var(--tx-dim)" } }),
        h(Seg, { value: kind, onChange: setKind, options: [
          { value: "all", label: "All" }, { value: "exact", label: "Exact" }, { value: "likely", label: "Likely" }, { value: "samename", label: "Same name" }, { value: "stock", label: "Stock" }] }),
        h(Seg, { value: risk, onChange: setRisk, options: [
          { value: "all", label: "Any risk" }, { value: "safe", label: "Safe" }, { value: "review", label: "Review" }, { value: "danger", label: "Protected" }] }),
        h("select", { className: "select", value: scope, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setScope(e.target.value) },
          h("option", { value: "all" }, "All locations"),
          h("option", { value: "drives" }, "Across drives"),
          h("option", { value: "project" }, "Inside a project"),
          h("option", { value: "cloud" }, "Cloud duplicates"))),

      list.length === 0
        ? h("div", { className: "card" }, h("div", { className: "empty" }, h("div", { className: "empty-ico" }, h(Icon, { name: "checkCircle", size: 24 })), h("h3", null, "No duplicates match"), h("div", { className: "muted" }, "Either everything's clean here, or the filters are too tight.")))
        : h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--gap)" } }, list.map((c) => h(ClusterCard, { key: c.id, c, go, toast }))));
  }

  function sumBox(label: React.ReactNode, value: React.ReactNode, color: string, icon: string) {
    return h("div", { className: "card-pad", style: { borderLeft: "1px solid var(--line)", display: "flex", flexDirection: "column", justifyContent: "center", gap: 5 } },
      h("div", { className: "row", style: { gap: 7 } }, h(Icon, { name: icon, size: 14, style: { color } }), h("span", { className: "eyebrow", style: { fontSize: 9.5 } }, label)),
      h("div", { className: "stat-num", style: { fontSize: 22, color } }, value));
  }

  


export { DuplicateCenter };
