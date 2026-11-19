import React from "react";
import { DB } from "@/data";
import { useQuery } from "convex/react";
import { api } from "@/convexApi";
import { groupCatalogFiles } from "@/catalog";
import { formatBytes } from "@/lib/download";
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

type ScreenProps = Record<string, any>;
type AnyRecord = Record<string, any>;



/* ============================================================
   DriveOS — Projects Overview + Project Detail
   ============================================================ */


  

  function structKind(s: number) { return s >= 85 ? "ok" : s >= 65 ? "warn" : "risk"; }

  // ---- Project card ----
  function ProjectCard({ p, go }: ScreenProps) {
    const st = (PROJ_STATUS as AnyRecord)[p.status] || { cls: "", label: p.status || "Unknown" };
    const tier = (TIER_META as AnyRecord)[p.tier] || { color: "--tx-dim", label: p.tier || "Unknown" };
    const owner = (DB.teamById as AnyRecord)[p.owner] || { name: p.owner || "Unknown" };
    return h("div", { className: "card fade-up", onClick: () => go("project", { id: p.id }),
      style: { cursor: "pointer", transition: "border-color .14s" },
      onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.borderColor = "var(--line-strong)"),
      onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => (e.currentTarget.style.borderColor = "var(--line)") },
      h("div", { className: "card-pad", style: { paddingBottom: 14 } },
        h("div", { className: "spread", style: { marginBottom: 13, alignItems: "flex-start" } },
          h("div", { style: { minWidth: 0 } },
            h("div", { className: "hi", style: { fontWeight: 600, fontSize: 14.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, p.name),
            h("div", { className: "muted", style: { fontSize: 11.5, marginTop: 2 } }, p.client, " · ", p.show)),
          h("span", { className: "badge " + st.cls, style: { flexShrink: 0 } }, st.label)),
        h("div", { className: "row", style: { gap: 7, marginBottom: 15 } },
          h("span", { className: "tag" }, h("span", { style: { width: 7, height: 7, borderRadius: 2, background: getVar(tier.color) } }), tier.label, " storage"),
          h(Avatar, { id: p.owner, size: 20 }),
          h("span", { className: "muted", style: { fontSize: 11.5 } }, owner.name.split(" ")[0])),
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
  function healthCell(label: React.ReactNode, val: number | null, kind: string, right = false) {
    return h("div", { style: { padding: "12px 16px", borderRight: right ? "none" : "1px solid var(--line)" } },
      h("div", { className: "spread", style: { marginBottom: 6 } },
        h("span", { className: "eyebrow", style: { fontSize: 9 } }, label),
        h("span", { className: "mono", style: { fontSize: 11, color: val == null ? "var(--tx-dim)" : "var(--" + kind + ")" } }, val == null ? "Not assessed" : val + "%")),
      val != null && h(Bar, { value: val, max: 100, kind, height: 5 }));
  }

  // ---- Overview ----
  function ProjectsScreen({ go }: ScreenProps) {
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
        h("select", { className: "select", value: tier, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setTier(e.target.value) },
          h("option", { value: "all" }, "All tiers"), ["hot", "warm", "cloud", "cold"].map((t) => h("option", { key: t, value: t }, ((TIER_META as AnyRecord)[t] || { label: t }).label))),
        h("select", { className: "select", value: owner, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setOwner(e.target.value) },
          h("option", { value: "all" }, "All editors"), DB.team.map((m) => h("option", { key: m.id, value: m.id }, m.name)))),

      list.length === 0
        ? h("div", { className: "card" }, h("div", { className: "empty" }, h("div", { className: "empty-ico" }, h(Icon, { name: "folder", size: 24 })), h("h3", null, "No projects match"), h("div", { className: "muted" }, "Adjust filters or create a new project.")))
        : h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: "var(--gap)" } },
            list.map((p) => h(ProjectCard, { key: p.id, p, go }))));
  }
  function pkpi(label: React.ReactNode, value: React.ReactNode, kind: string) {
    const color = kind ? "var(--" + (kind === "accent" ? "accent-hi" : kind) + ")" : "var(--tx-hi)";
    return h("div", { className: "card card-pad fade-up" },
      h("div", { className: "stat-num", style: { fontSize: 24, color } }, value),
      h("div", { className: "eyebrow", style: { fontSize: 9.5, marginTop: 3 } }, label));
  }

  // ============================================================
  //  PROJECT DETAIL
  // ============================================================
  function ProjectDetail({ params, go, toast, requestAnalysis, actionBusy }: ScreenProps) {
    const catalog = useQuery(api.files.list, { projectId: params.id, limit: 200 });
    const [modal, setModal] = React.useState<"archive" | "location" | null>(null);
    const p = DB.projectById[params.id];
    if (!p) return <div className="page-inner"><div className="card card-pad muted">Project not found.</div></div>;
    const owner = DB.teamById[p.owner] || { name: p.owner || "Unassigned" };
    const status = PROJ_STATUS[p.status] || { label: p.status, cls: "" };
    const files = (catalog || []).filter((f: any) => !f.deletedAt);
    const bytes = files.reduce((sum: number, file: any) => sum + file.sizeBytes, 0);
    const groups = groupCatalogFiles(files, (file) => file.classification || "UNKNOWN");
    const setupJob = DB.jobs.find((job) => job.action === "create_folder_structure" && job.result?.projectId === p.id);
    const manifestJob = DB.jobs.find((job) => job.action === "generate_manifest" && job.result?.projectId === p.id);
    const locations = [...new Set(files.map((file: any) => file.driveId).filter(Boolean))] as string[];
    if (p.driveId && !locations.includes(p.driveId)) locations.push(p.driveId);
    const duplicates = DB.duplicates.filter((cluster) => (cluster.projectIds || []).includes(p.id));
    const setupLabel = setupJob ? setupJob.status === "completed" ? "Folder setup completed by agent" : "Folder setup: " + setupJob.status.replace(/_/g, " ") : "Folder setup has not been confirmed";
    return <div className="page-inner">
      <button className="btn ghost sm" style={{ marginBottom: 12 }} onClick={() => go("projects")}><Icon name="chevL" size={15} />All projects</button>
      <PageHead eyebrow={p.client + (p.show ? " · " + p.show : "")} title={p.name} desc={owner.name + " · " + (p.template || "Standard studio")}
        actions={[
          <button key="location" className="btn" disabled={!p.rootPath} onClick={() => setModal("location")}><Icon name="folder" size={15} />Project location</button>,
          <button key="cleanup" className="btn" onClick={() => go("cleanup")}><Icon name="broom" size={15} />Review Cleanup</button>,
          <button key="archive" className="btn primary" onClick={() => setModal("archive")}><Icon name="archive" size={15} />Archive Checklist</button>,
        ]} />
      <div className="row" style={{ gap: 9, marginBottom: 18 }}><Badge kind={status.cls}>{status.label}</Badge><span className="tag">{p.tier} storage</span><span className="muted" style={{ fontSize: 12 }}>{setupLabel}</span></div>
      <div className="card card-pad" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 20, marginBottom: "var(--gap)" }}>
        {sumCell("Indexed sample", formatBytes(bytes), "database")}
        {sumCell("Sample files", files.length, "folder")}
        {sumCell("Duplicate clusters", duplicates.length, "copy", "var(--warn)")}
        {sumCell("Backup verification", "Not verified", "shield", "var(--warn)")}
      </div>
      <p className="muted" style={{ fontSize: 12 }}>{catalog === undefined ? "Loading project catalog…" : "Up to 200 indexed project files are shown. Folder setup status does not verify current contents or backup copies."}</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--gap)", marginBottom: "var(--gap)" }}>
        <div className="card"><div className="card-head"><div className="card-title">Project Folder Setup</div></div><div className="card-pad">
          <div className="mono" style={{ overflowWrap: "anywhere", fontSize: 12, marginBottom: 12 }}>{p.rootPath || "No local root configured"}</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>{setupLabel}{setupJob?.status === "failed" ? ": " + (setupJob.result?.error || "See agent logs") : ""}</div>
          <div className="tree">{DB.folderTemplate.filter((folder) => folder.lvl === 0).map((folder) => <div className="tree-row" key={folder.name}><Icon name="folder" size={13} /><span>{folder.name}</span><span className="dim" style={{ marginLeft: "auto", fontSize: 10 }}>standard template</span></div>)}</div>
        </div></div>
        <div className="card"><div className="card-head"><div className="card-title">Indexed File Types</div></div><div className="card-pad">
          {groups.length ? groups.map((group) => <div className="spread" style={{ padding: "9px 0" }} key={group.name}><span>{group.name} · {group.count} files</span><span className="mono">{formatBytes(group.bytes)}</span></div>) : <div className="muted">No files indexed for this project yet. Scan its drive after folder setup completes.</div>}
        </div></div>
        <div className="card"><div className="card-head"><div className="card-title">Locations & Redundancy</div><Badge kind="warn">Not verified</Badge></div><div className="card-pad">
          {locations.length ? locations.map((id) => <div key={id} className="row" style={{ gap: 9, padding: "8px 0" }}><Icon name="hdd" size={15} /><span>{DB.driveById[id]?.name || "Tracked drive"}</span><span className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>Catalog location</span></div>) : <div className="muted">No catalog locations have been confirmed.</div>}
          <p className="muted" style={{ fontSize: 12 }}>A catalog location is not proof of a complete or checksum-verified backup. Cloud and archive copies remain unverified.</p>
        </div></div>
        <div className="card"><div className="card-head"><div className="card-title">Project Actions</div></div><div className="card-pad" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <button className="btn" disabled={actionBusy} onClick={() => void requestAnalysis()}><Icon name="cpu" size={15} />Refresh Duplicate & Cleanup Analysis</button>
          <button className="btn" onClick={() => go("duplicates")}><Icon name="copy" size={15} />Review Duplicate Clusters</button>
          <button className="btn" onClick={() => setModal("archive")}><Icon name="fingerprint" size={15} />Generate Archive Manifest</button>
          <div className="muted" style={{ fontSize: 12 }}>{manifestJob ? "Latest manifest request: " + manifestJob.status.replace(/_/g, " ") : "No manifest request has been recorded."}</div>
        </div></div>
      </div>
      {modal === "location" ? <Modal title="Project location" icon="folder" onClose={() => setModal(null)} footer={<button className="btn" onClick={() => setModal(null)}>Close</button>}><div className="mono" style={{ overflowWrap: "anywhere" }}>{p.rootPath}</div><p className="muted" style={{ fontSize: 12 }}>Open this path on the computer that owns the selected drive. A browser cannot open a remote computer's folder.</p></Modal> : null}
      {modal === "archive" ? <ArchiveChecklistModal p={p} onClose={() => setModal(null)} toast={toast} go={go} /> : null}
    </div>;
  }

  function sumCell(label: React.ReactNode, value: React.ReactNode, icon: string, color = "") {
    return h("div", null,
      h("div", { className: "row", style: { gap: 7, marginBottom: 6 } }, h(Icon, { name: icon, size: 14, style: { color: color || "var(--tx-dim)" } }), h("span", { className: "eyebrow", style: { fontSize: 9.5 } }, label)),
      h("div", { className: "stat-num", style: { fontSize: 22, color: color || "var(--tx-hi)" } }, value));
  }
  function copyRow(label: React.ReactNode, present: boolean, icon: string) {
    return h("div", { className: "spread", style: { padding: "11px 13px", borderRadius: "var(--r)", background: present ? "var(--ok-soft)" : "var(--risk-soft)", border: "1px solid var(--" + (present ? "ok" : "risk") + "-line)" } },
      h("div", { className: "row", style: { gap: 10 } }, h(Icon, { name: icon, size: 16, style: { color: present ? "var(--ok)" : "var(--risk)" } }), h("span", { className: "hi", style: { fontWeight: 600, fontSize: 13 } }, label)),
      h("span", { className: "badge " + (present ? "ok" : "risk") }, present ? "Verified" : "Missing"));
  }
  function dupStat(label: React.ReactNode, value: React.ReactNode, color: string) {
    return h("div", { style: { flex: 1, padding: "11px 13px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
      h("div", { className: "eyebrow", style: { fontSize: 9, marginBottom: 4 } }, label),
      h("div", { className: "stat-num", style: { fontSize: 18, color } }, value));
  }

  
  


export { ProjectsScreen, ProjectDetail };
