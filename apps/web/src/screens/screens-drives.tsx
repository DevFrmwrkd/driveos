import React from "react";
import { DB } from "@/data";
import { useQuery } from "convex/react";
import { api } from "@/convexApi";
import { groupCatalogFiles } from "@/catalog";
import { formatBytes } from "@/lib/download";
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

  // Resolve a drive's owner to a real team member, or fall back to showing the
  // raw owner id from the agent (never a mock default member).
  function ownerInfo(rawOwner: any) {
    const member = (DB.teamById as Record<string, any>)[rawOwner];
    if (member) return { name: member.name, member };
    return { name: rawOwner || "Unassigned", member: null };
  }

  // ---- Drive card ----
  function DriveCard({ d, go }: ScreenProps) {
    const owner = ownerInfo(d.owner);
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
        h("div", { className: "row", style: { gap: 8 } },
          owner.member && h(Avatar, { id: d.owner, size: 22 }),
          h("span", { style: { fontSize: 12, color: "var(--tx-mut)" } }, owner.name.split(" ")[0]),
          d.location && h("span", { className: "dim", style: { fontSize: 11.5 } }, "· " + d.location)),
        h(RiskBadge, { risk: d.risk })));
  }
  function miniCell(label: React.ReactNode, value: React.ReactNode, color: string) {
    return h("div", { style: { padding: "11px 14px", borderRight: "1px solid var(--line)", textAlign: "center" } },
      h("div", { className: "eyebrow", style: { fontSize: 9, marginBottom: 3 } }, label),
      h("div", { className: "stat-num", style: { fontSize: 15, color } }, value));
  }

  // ---- Overview ----
  function DrivesScreen({ go, requestScan, actionBusy }: ScreenProps) {
    const [owner, setOwner] = React.useState("all");
    const [loc, setLoc] = React.useState("all");
    const [status, setStatus] = React.useState("all");
    const [view, setView] = React.useState("grid");
    const [showAdd, setShowAdd] = React.useState(false);

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
        actions: [h("button", { key: 1, className: "btn", disabled: actionBusy || DB.drives.length === 0, onClick: () => void requestScan() }, h(Icon, { name: "refresh", size: 15 }), "Scan All"),
          h("button", { key: 2, className: "btn primary", onClick: () => setShowAdd(true) }, h(Icon, { name: "plus", size: 16 }), "Add Drive")] }),

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
          : h(DriveTable, { list, go }),
      showAdd && h(AddDriveModal, { go, onClose: () => setShowAdd(false) }));
  }

  function DriveTable({ list, go }: ScreenProps) {
    return h("div", { className: "card", style: { overflow: "hidden" } },
      h("table", { className: "tbl" },
        h("thead", null, h("tr", null,
          ["Drive", "Owner", "Location", "Status", "Capacity", "Used", "Risk", "Dupes", "Cleanup"].map((c, i) =>
            h("th", { key: i, className: i >= 4 && i !== 6 ? "num" : "" }, c)))),
        h("tbody", null, list.map((d: any) => {
          const p = pct(d.usedTB, d.capTB);
          const owner = ownerInfo(d.owner);
          return h("tr", { key: d.id, onClick: () => go("drive", { id: d.id }) },
            h("td", null, h("div", { className: "row", style: { gap: 9 } },
              h(Icon, { name: driveIcon(d), size: 16, style: { color: "var(--tx-mut)" } }),
              h("span", { className: "hi", style: { fontWeight: 600 } }, d.name))),
            h("td", null, h("div", { className: "row", style: { gap: 7 } }, owner.member && h(Avatar, { id: d.owner, size: 20 }), owner.name.split(" ")[0])),
            h("td", { className: "muted" }, d.location || "—"),
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
  function AddDriveModal({ go, onClose }: ScreenProps) {
    return <Modal title="Connect a drive" subtitle="DriveOS reads your disks through a local agent" icon="hdd" onClose={onClose}
      footer={[<button key="close" className="btn" onClick={onClose}>Close</button>, <button key="app" className="btn primary" onClick={() => { onClose(); go("download"); }}>Get desktop app</button>]}>
      <ol style={{ paddingLeft: 20, lineHeight: 1.8, color: "var(--tx)" }}>
        <li>Install and open the DriveOS desktop app on the computer attached to the drive.</li>
        <li>Use Settings → Machines / Agents to issue a connection token for that computer.</li>
        <li>Connect the app, choose Add drive, and select the drive or folder locally.</li>
        <li>Run Scan Now. Its catalog will appear here after the agent finishes.</li>
      </ol>
      <p className="muted" style={{ fontSize: 12 }}>DriveOS uploads file metadata and hashes. Your media stays on its original disk.</p>
      <button className="btn" onClick={() => { onClose(); go("settings"); }}>Manage agents</button>
    </Modal>;
  }

  function DriveDetail({ params, go, toast, requestScan, requestAnalysis, actionBusy }: ScreenProps) {
    const catalog = useQuery(api.files.list, { driveId: params.id, limit: 200 });
    const d = DB.driveById[params.id];
    if (!d) return <div className="page-inner"><div className="card card-pad muted">Drive not found.</div></div>;
    const files = (catalog || []).filter((f: any) => !f.deletedAt);
    const indexedBytes = files.reduce((sum: number, f: any) => sum + f.sizeBytes, 0);
    const types = groupCatalogFiles(files, (f) => f.classification || "UNKNOWN");
    const folders = groupCatalogFiles(files, (f) => f.path.replace(/\\/g, "/").split("/").slice(0, -1).join("/")).slice(0, 6);
    const projectGroups = groupCatalogFiles(files.filter((f: any) => f.projectId), (f) => f.projectId);
    const driveFileIds = new Set(files.map((f: any) => String(f._id)));
    const dupes = DB.duplicates.filter((du) => (du.locations || []).some((location: any) => location.drive === d.id || driveFileIds.has(location.fileId)));
    const recommendations = DB.cleanup.filter((rec) => rec.driveId === d.id || rec.affectedFileIds.some((id: string) => driveFileIds.has(id)));
    const scans = DB.scans.filter((scan) => scan.driveId === d.id).sort((a, b) => b.startedAt - a.startedAt).slice(0, 8);
    const owner = ownerInfo(d.owner);
    const sampleLabel = catalog === undefined ? "Loading catalog…" : "Catalog sample: " + files.length + " files (up to 200). Full volume usage is shown above.";
    return <div className="page-inner">
      <button className="btn ghost sm" style={{ marginBottom: 12 }} onClick={() => go("drives")}><Icon name="chevL" size={15} />All drives</button>
      <PageHead eyebrow={owner.name + " · " + d.location} title={d.name} desc={d.mountPath || d.model}
        actions={[
          <button key="watch" className="btn" onClick={() => go("download")}><Icon name="eye" size={15} />Manage local agent</button>,
          <button key="scan" className="btn" disabled={actionBusy} onClick={() => void requestScan(d.id)}><Icon name="refresh" size={15} />Start Scan</button>,
          <button key="analysis" className="btn primary" disabled={actionBusy} onClick={() => void requestAnalysis()}><Icon name="broom" size={15} />Generate Cleanup Plan</button>,
        ]} />
      <div className="card card-pad" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr", gap: 22, marginBottom: "var(--gap)" }}>
        <div><div className="row" style={{ gap: 8, marginBottom: 10 }}><StatusBadge status={d.status} /><RiskBadge risk={d.risk} /></div><CapMeter d={d} /></div>
        {stripCell("Last seen", d.lastSeen, "clock")}
        {stripCell("Scan sessions", scans.length, "refresh")}
      </div>
      <p className="muted" style={{ fontSize: 12 }}>{sampleLabel}</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--gap)", marginBottom: "var(--gap)" }}>
        <div className="card"><div className="card-head"><div className="card-title">Indexed File Types</div><span className="mono">{formatBytes(indexedBytes)}</span></div><div className="card-pad">
          {types.length ? types.map((type) => <div className="spread" style={{ padding: "8px 0" }} key={type.name}><span>{type.name} · {type.count} files</span><span className="mono">{formatBytes(type.bytes)}</span></div>) : <span className="muted">No indexed files in this sample.</span>}
        </div></div>
        <div className="card"><div className="card-head"><div className="card-title">Storage by Project</div></div><div className="card-pad">
          {projectGroups.length ? projectGroups.map((group) => <button className="btn ghost spread" style={{ width: "100%" }} key={group.name} onClick={() => go("project", { id: group.name })}><span>{DB.projectById[group.name]?.name || "Tracked project"}</span><span className="mono">{formatBytes(group.bytes)}</span></button>) : <span className="muted">No project-linked files in this sample.</span>}
        </div></div>
        <div className="card"><div className="card-head"><div className="card-title">Largest Indexed Folders</div></div><div className="card-pad">
          {folders.length ? folders.map((folder) => <div key={folder.name} className="spread" style={{ gap: 12, padding: "8px 0" }}><span className="mono" style={{ overflowWrap: "anywhere", fontSize: 11 }}>{folder.name}</span><span className="mono" style={{ flexShrink: 0 }}>{formatBytes(folder.bytes)}</span></div>) : <span className="muted">No folder totals available yet.</span>}
        </div></div>
        <div className="card"><div className="card-head"><div className="card-title">Duplicate Clusters</div><button className="btn sm ghost" onClick={() => go("duplicates")}>Review all</button></div><div className="card-pad">
          {dupes.length ? dupes.map((du) => <div key={du.id} className="spread" style={{ padding: "8px 0" }}><span>{du.name}</span><span>{du.copies} copies</span></div>) : <span className="muted">No current duplicate clusters on this drive.</span>}
        </div></div>
        <div className="card"><div className="card-head"><div className="card-title">Cleanup Recommendations</div><button className="btn sm ghost" onClick={() => go("cleanup")}>Review</button></div><div className="card-pad">
          {recommendations.length ? recommendations.map((rec) => <div key={rec.id} style={{ padding: "8px 0" }}><div>{rec.title}</div><div className="muted" style={{ fontSize: 12 }}>{rec.why}</div></div>) : <span className="muted">No recommendations for these indexed files. Generate a cleanup plan after scanning.</span>}
        </div></div>
        <div className="card"><div className="card-head"><div className="card-title">Backup Verification</div><Badge kind="warn">Not verified</Badge></div><div className="card-pad muted">The catalog does not establish that every file has a verified archive or cloud copy. No single-copy count or backup assurance is inferred from volume usage.</div></div>
      </div>
      <div className="card"><div className="card-head"><div className="card-title">Scan Timeline</div></div><div className="card-pad">
        {scans.length ? scans.map((scan) => <div key={scan.id} className="spread" style={{ padding: "10px 0", gap: 14 }}><div><div>Scan {scan.status}</div><div className="muted" style={{ fontSize: 12 }}>{scan.files} files · {formatBytes(scan.bytes)} indexed{scan.errors ? " · " + scan.errors + " errors" : ""}</div></div><span className="mono dim" style={{ fontSize: 11 }}>{scan.when}</span></div>) : <span className="muted">No scan history for this drive.</span>}
      </div></div>
    </div>;
  }

  function stripCell(label: React.ReactNode, value: React.ReactNode, icon: string, color = "") {
    return h("div", null,
      h("div", { className: "row", style: { gap: 6, marginBottom: 5 } }, h(Icon, { name: icon, size: 13, style: { color: color || "var(--tx-dim)" } }),
        h("span", { className: "eyebrow", style: { fontSize: 9.5 } }, label)),
      h("div", { className: "stat-num", style: { fontSize: 19, color: color || "var(--tx-hi)" } }, value));
  }

export { DrivesScreen, DriveDetail };
