import React from "react";
import { useMutation } from "convex/react";
import { api } from "@/convexApi";
import { DB } from "@/data";
import { Icon, Badge, PageHead, Seg } from "@/components";
import { formatBytes } from "@/lib/download";

type ScreenProps = Record<string, any>;
const KIND_LABEL: Record<string, string> = { exact: "Exact match", likely: "Likely duplicate", same_name: "Same name", stock_reuse: "Stock reuse" };

function ClusterCard({ cluster, go, toast }: ScreenProps) {
  const queueQuarantine = useMutation(api.cleanup.queueQuarantine);
  const updateStatus = useMutation(api.duplicates.updateStatus);
  const [selection, setSelection] = React.useState<Record<string, boolean>>({});
  const [busy, setBusy] = React.useState(false);
  const [queued, setQueued] = React.useState<{ ids: string[]; count: number } | null>(null);
  const locations: any[] = cluster.locations || [];
  const canSelect = (location: any) => cluster.kind === "exact" && !!location.fileId && location.fileId !== cluster.recommendedKeepFileId && !String(location.tag || "").startsWith("Protected ");
  const selected = locations.filter(location => canSelect(location) && (selection[location.fileId] ?? location.role === "quarantine"));
  const jobs = queued ? DB.jobs.filter(job => queued.ids.includes(job._id)) : [];
  const completed = !!queued && jobs.length === queued.ids.length && jobs.every(job => job.status === "completed");
  const failed = jobs.some(job => job.status === "failed");

  async function queue() {
    if (busy || selected.length === 0) return;
    setBusy(true);
    try {
      const result = await queueQuarantine({ fileIds: selected.map(location => location.fileId), clusterId: cluster.id });
      setQueued({ ids: result.jobIds, count: result.queued });
      toast(`Queued ${result.queued} duplicate copy/copies for quarantine`, "shield", "ok");
    } catch (error) { toast(error instanceof Error ? error.message : "Could not queue duplicate cleanup", "alert", "risk"); }
    finally { setBusy(false); }
  }
  async function mark(status: "ignored" | "resolved") {
    if (busy) return; setBusy(true);
    try { await updateStatus({ clusterId: cluster.id, status }); toast(status === "ignored" ? "Cluster ignored" : "Marked as intentional redundancy", "check", "ok"); }
    catch (error) { toast(error instanceof Error ? error.message : "Could not update cluster", "alert", "risk"); }
    finally { setBusy(false); }
  }

  if (queued) return <div className="card card-pad" style={{ borderColor: failed ? "var(--risk-line)" : "var(--ok-line)" }}>
    <div className="spread"><b>{cluster.name}</b><Badge kind={failed ? "risk" : completed ? "ok" : "warn"}>{failed ? "Action failed" : completed ? "Quarantine completed" : "Quarantine queued"}</Badge></div>
    <p className="muted" style={{ fontSize: 13 }}>{failed ? "The agent could not move every selected file. Review its logs before retrying." : completed ? `The agent confirmed ${queued.count} file move(s). Refresh analysis to update duplicate totals.` : `Waiting for the local agent to move ${queued.count} selected copy/copies. The recommended keep copy remains selected for retention.`}</p>
    <button className="btn sm" onClick={() => go("quarantine")}>View Quarantine</button>
  </div>;

  return <div className="card">
    <div className="card-pad"><div className="spread"><div><b className="mono">{cluster.name}</b><div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{KIND_LABEL[cluster.kind] || "Duplicate cluster"} · {cluster.copies} cataloged copies · {formatBytes(cluster.sizeGB * 1024 ** 3)} each</div></div><Badge kind={cluster.risk === "danger" ? "risk" : cluster.risk === "safe" ? "ok" : "warn"}>{cluster.risk === "danger" ? "Protected" : cluster.risk === "safe" ? "Safe to review" : "Needs review"}</Badge></div><div className="mono dim" style={{ marginTop: 10, fontSize: 11, overflowWrap: "anywhere" }}>{cluster.fingerprint}</div></div>
    <div className="muted" style={{ padding: "0 18px 10px", fontSize: 11 }}>Showing up to 20 active catalog locations. Only the selected visible copies are queued.</div>
    {locations.length ? locations.map(location => {
      const keep = location.fileId === cluster.recommendedKeepFileId;
      const eligible = canSelect(location);
      const checked = eligible && (selection[location.fileId] ?? location.role === "quarantine");
      return <div className="spread" key={location.fileId || location.path} style={{ padding: "12px 18px", gap: 15, borderTop: "1px solid var(--line)", background: checked ? "var(--warn-soft)" : undefined }}>
        <div style={{ minWidth: 0 }}><div className="mono" style={{ overflowWrap: "anywhere", fontSize: 12 }}>{location.path}</div><div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{DB.driveById[location.drive]?.name || location.drive} · {location.tag}</div></div>
        {eligible ? <label className="row" style={{ gap: 7, whiteSpace: "nowrap", fontSize: 12 }}><input type="checkbox" checked={checked} onChange={event => setSelection(current => ({ ...current, [location.fileId]: event.target.checked }))} />Quarantine</label> : <Badge kind={keep ? "ok" : "warn"}>{keep ? "Recommended keep" : "Review only"}</Badge>}
      </div>;
    }) : <div className="card-pad muted">No active file locations remain in this analysis result. Run analysis again.</div>}
    <div style={{ padding: "13px 18px", background: "var(--accent-soft)", borderTop: "1px solid var(--line)" }}><div style={{ fontSize: 12, lineHeight: 1.6 }}>{cluster.rec}</div><div className="dim" style={{ fontSize: 11, marginTop: 6 }}>The agent rechecks file protection and content before moving selected copies.</div></div>
    <div className="spread" style={{ padding: "13px 18px", borderTop: "1px solid var(--line)", gap: 12 }}><div className="mono muted" style={{ fontSize: 12 }}>{selected.length} selected · {formatBytes(selected.reduce((sum, location) => sum + (location.sizeBytes || 0), 0))}</div><div className="row" style={{ gap: 8 }}><button className="btn sm ghost" disabled={busy} onClick={() => void mark("ignored")}>Ignore</button><button className="btn sm" disabled={busy} onClick={() => void mark("resolved")}>Intentional</button><button className="btn sm primary" disabled={busy || selected.length === 0 || cluster.risk === "danger"} onClick={() => void queue()}><Icon name="shield" size={13} />{busy ? "Queuing…" : `Quarantine ${selected.length}`}</button></div></div>
  </div>;
}

export function DuplicateCenter({ go, toast, requestAnalysis, actionBusy }: ScreenProps) {
  const [kind, setKind] = React.useState("all");
  const [risk, setRisk] = React.useState("all");
  const [scope, setScope] = React.useState("all");
  const list = DB.duplicates.filter(cluster => (kind === "all" || cluster.kind === kind) && (risk === "all" || cluster.risk === risk) &&
    (scope === "all" || (scope === "drives" && new Set((cluster.locations || []).map((location: any) => location.drive)).size > 1) ||
      (scope === "cloud" && (cluster.locations || []).some((location: any) => DB.driveById[location.drive]?.status === "cloud")) ||
      (scope === "project" && cluster.project !== "—")));
  const recoverBytes = (level: string) => DB.duplicates.filter(cluster => cluster.risk === level).reduce((sum, cluster) => sum + (cluster.wastedBytes || 0), 0);
  return <div className="page-inner">
    <PageHead eyebrow="Maintenance" title="Duplicate Center" desc="Review the latest duplicate analysis and select redundant copies. Files move only after the agent confirms the approved job." actions={[<button key="refresh" className="btn" disabled={actionBusy} onClick={() => void requestAnalysis()}><Icon name="refresh" size={15} />Re-scan</button>]} />
    <div className="card card-pad" style={{ marginBottom: "var(--gap)", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 18 }}>
      {[["Last analysis total", formatBytes(DB.duplicates.reduce((sum, cluster) => sum + (cluster.totalBytes || 0), 0))], ["Safe candidates", formatBytes(recoverBytes("safe"))], ["Needs review", formatBytes(recoverBytes("review"))], ["Protected", formatBytes(recoverBytes("danger"))]].map(([label, value]) => <div key={label}><div className="eyebrow">{label}</div><div className="stat-num" style={{ fontSize: 24, marginTop: 8 }}>{value}</div></div>)}
    </div>
    <div className="filter-bar"><Icon name="filter" size={15} /><Seg value={kind} onChange={setKind} options={[{ value: "all", label: "All" }, { value: "exact", label: "Exact" }, { value: "likely", label: "Likely" }, { value: "same_name", label: "Same name" }, { value: "stock_reuse", label: "Stock" }]} /><Seg value={risk} onChange={setRisk} options={[{ value: "all", label: "Any risk" }, { value: "safe", label: "Safe" }, { value: "review", label: "Review" }, { value: "danger", label: "Protected" }]} /><select aria-label="Duplicate locations" className="select" value={scope} onChange={event => setScope(event.target.value)}><option value="all">All locations</option><option value="drives">Across drives</option><option value="project">Inside a project</option><option value="cloud">Cloud duplicates</option></select></div>
    {list.length ? <div style={{ display: "grid", gap: "var(--gap)" }}>{list.map(cluster => <ClusterCard key={cluster.id} cluster={cluster} go={go} toast={toast} />)}</div> : <div className="card"><div className="empty"><Icon name="checkCircle" size={24} /><h3>No duplicates match</h3><div className="muted">Run analysis after scanning, or adjust the filters.</div></div></div>}
  </div>;
}
