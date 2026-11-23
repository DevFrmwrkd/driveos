import React from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convexApi";
import { Icon } from "@/components/icons";
import { Badge, Modal, PageHead } from "@/components/components";
import { downloadText, formatBytes } from "@/lib/download";

type ScreenProps = { go: (screen: string, params?: Record<string, string>) => void; toast: (message: string, icon?: string, kind?: string) => void };
type Recommendation = { _id: string; type: string; title: string; explanation: string; riskLevel: string; status: string; affectedFileIds: string[]; affectedBytes: number };
type Preview = { title: string; recommendations: Recommendation[] };
const CLEANUP_TYPES = new Set(["delete_cache", "delete_proxies", "remove_duplicate"]);
const category = (type: string) => ({ delete_cache: "Cache", delete_proxies: "Proxies", remove_duplicate: "Duplicates", move_to_warm: "Storage", archive_project: "Archive", copy_to_cloud: "Backup" } as Record<string, string>)[type] || "Review";
const errorText = (error: unknown) => error instanceof Error ? error.message : "The request could not be completed.";

export function CleanupScreen({ go, toast }: ScreenProps) {
  const recommendations = useQuery(api.recommendations.list) as Recommendation[] | undefined;
  const settings = useQuery(api.settings.get);
  const context = useQuery(api.tenants.currentContext);
  const queue = useMutation(api.cleanup.queueRecommendations);
  const updateStatus = useMutation(api.recommendations.updateStatus);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [deleting, setDeleting] = React.useState<Recommendation | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState("all");
  const all = recommendations || [];
  const safe = all.filter(r => CLEANUP_TYPES.has(r.type) && r.status === "open" && r.riskLevel === "green" && r.affectedFileIds.length > 0);
  const safeBatch: Recommendation[] = [];
  const batchIds = new Set<string>();
  for (const recommendation of safe) {
    const merged = new Set([...batchIds, ...recommendation.affectedFileIds]);
    if (merged.size <= 4000 && safeBatch.length < 100) {
      safeBatch.push(recommendation);
      for (const id of merged) batchIds.add(id);
    }
  }
  const categories = [...new Set(all.map(r => category(r.type)))];
  const shown = filter === "all" ? all : all.filter(r => category(r.type) === filter);
  const safeIds = [...new Set(safe.flatMap(r => r.affectedFileIds))];
  const canPurge = context?.member.role === "admin";
  const retention = settings?.retentionDays ?? 14;

  async function enqueue(recs: Recommendation[], purgeAfter = false) {
    if (busyId || !settings) return;
    setBusyId(recs[0]?._id || "bulk");
    try {
      const result = await queue({ recommendationIds: recs.map(r => r._id), purgeAfter: purgeAfter || undefined });
      toast(`Queued ${result.queued} file(s) for ${purgeAfter ? "permanent deletion" : "quarantine"}`, purgeAfter ? "trash" : "shield", purgeAfter ? "risk" : "ok");
      setDeleting(null); setPreview(null);
    } catch (error) { toast(errorText(error), "alert", "risk"); }
    finally { setBusyId(null); }
  }
  async function ignore(r: Recommendation) {
    setBusyId(r._id);
    try { await updateStatus({ recommendationId: r._id, status: "ignored" }); }
    catch (error) { toast(errorText(error), "alert", "risk"); }
    finally { setBusyId(null); }
  }

  return <div className="page-inner">
    <PageHead eyebrow="Maintenance" title="Cleanup Recommendations" desc="Review actual files before approving cleanup. The agent reports when each move completes." actions={[<button key="q" className="btn" onClick={() => go("quarantine")}><Icon name="shield" size={15} />View Quarantine</button>]} />
    {recommendations === undefined ? <div className="card card-pad muted">Loading recommendations…</div> : all.length === 0 ? <div className="card"><div className="empty"><Icon name="shieldCheck" size={24} /><h3>No cleanup recommendations yet</h3><div className="muted">Use Scan &amp; Analyze from Drives. Review its results before approving any file changes.</div></div></div> : <>
      <div className="card card-pad" style={{ marginBottom: "var(--gap)" }}>
        <div className="spread" style={{ gap: 20 }}><div><div className="eyebrow">Safe cleanup</div><h2 style={{ margin: "8px 0" }}>{safeIds.length} unique file(s)</h2><div className="muted">Only eligible cache, proxies, and redundant copies are included.</div>{safeBatch.length < safe.length && <p className="muted" style={{ fontSize: 12 }}>This batch contains {batchIds.size} files. Remaining recommendations can be reviewed in the next batch.</p>}</div><button className="btn primary lg" disabled={!settings || batchIds.size === 0 || busyId !== null} onClick={() => setPreview({ title: safeBatch.length === safe.length ? "All safe cleanup" : "Safe cleanup batch", recommendations: safeBatch })}><Icon name="broom" size={16} />{safeBatch.length === safe.length ? "Quarantine all safe" : "Quarantine safe batch"}</button></div>
        <div className="mono dim" style={{ marginTop: 14, fontSize: 12 }}>New quarantine jobs retain files for {retention} days. Existing items keep their original restore deadline.</div>
      </div>
      <div className="chip-row" style={{ marginBottom: "var(--gap)" }}>{["all", ...categories].map(c => <button key={c} className={`badge ${filter === c ? "accent" : ""}`} style={{ cursor: "pointer", padding: "6px 12px" }} onClick={() => setFilter(c)}>{c === "all" ? "All categories" : c}</button>)}</div>
      <div style={{ display: "grid", gap: 12 }}>{shown.map(r => {
        const supported = CLEANUP_TYPES.has(r.type);
        const eligible = supported && r.status === "open" && r.riskLevel !== "red" && r.affectedFileIds.length > 0;
        return <div className="card card-pad" key={r._id}>
          <div className="spread"><h3 style={{ margin: 0, fontSize: 15 }}>{r.title}</h3><Badge kind={r.riskLevel === "red" ? "risk" : r.riskLevel === "green" ? "ok" : "warn"}>{r.riskLevel === "red" ? "Protected" : r.riskLevel === "green" ? "Safe to review" : "Needs review"}</Badge></div>
          <p className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>{r.explanation}</p><div className="mono dim" style={{ fontSize: 12 }}>{r.affectedFileIds.length} listed file(s) · {formatBytes(r.affectedBytes)} · {category(r.type)}</div>
          {!supported && <p className="muted" style={{ fontSize: 12 }}>This recommendation needs a storage or backup decision. It does not authorize deleting the original files.</p>}
          {r.status === "failed" && <p style={{ color: "var(--risk)", fontSize: 12 }}>A previous cleanup attempt failed. Run analysis again to refresh the remaining files before approving another move.</p>}
          <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: "wrap" }}><button className="btn sm" onClick={() => setPreview({ title: r.title, recommendations: [r] })}><Icon name="eye" size={13} />Preview</button>{eligible && <button className="btn sm primary" disabled={!settings || busyId !== null} onClick={() => setPreview({ title: r.title, recommendations: [r] })}><Icon name="shield" size={13} />{busyId === r._id ? "Queuing…" : "Quarantine"}</button>}{eligible && canPurge && <button className="btn sm danger" disabled={!settings || busyId !== null} onClick={() => setDeleting(r)}><Icon name="trash" size={13} />Delete permanently</button>}<button className="btn sm ghost" disabled={busyId !== null} onClick={() => void ignore(r)}>Ignore</button></div>
        </div>;
      })}</div>
    </>}
    {preview && <CleanupPreviewModal preview={preview} retention={retention} busy={busyId !== null} onClose={() => setPreview(null)} onQueue={() => void enqueue(preview.recommendations)} />}
    {deleting && <DeleteConfirmModal title={deleting.title} count={deleting.affectedFileIds.length} busy={busyId !== null} onClose={() => setDeleting(null)} onConfirm={() => void enqueue([deleting], true)} />}
  </div>;
}

function CleanupPreviewModal({ preview, retention, busy, onClose, onQueue }: { preview: Preview; retention: number; busy: boolean; onClose: () => void; onQueue: () => void }) {
  const fileIds = [...new Set(preview.recommendations.flatMap(r => r.affectedFileIds))];
  const files = useQuery(api.cleanup.previewFiles, { fileIds });
  const [approved, setApproved] = React.useState(false);
  const supported = preview.recommendations.every(r => CLEANUP_TYPES.has(r.type) && r.status === "open" && r.riskLevel !== "red");
  const bytes = (files || []).reduce((sum: number, f: any) => sum + f.sizeBytes, 0);
  const eligibleCount = (files || []).filter((f: any) => !f.protected && !f.deletedAt).length;
  return <Modal title={preview.title} subtitle="Review actual catalog records before anything moves" icon="broom" iconKind="ok" onClose={onClose} width={820} footer={[
    <label key="approve" className="row" style={{ gap: 8, marginRight: "auto", fontSize: 12 }}><input type="checkbox" checked={approved} onChange={e => setApproved(e.target.checked)} />I approve this move to quarantine.</label>,
    <button key="cancel" className="btn" onClick={onClose}>Cancel</button>,
    <button key="report" className="btn" disabled={!files} onClick={() => downloadText("driveos-cleanup-preview.json", JSON.stringify({ recommendations: preview.recommendations.map(r => r._id), files, retentionDays: retention }, null, 2), "application/json")}>Export Report</button>,
    <button key="move" className="btn primary" disabled={!approved || busy || !files || !supported || eligibleCount === 0} onClick={onQueue}>{busy ? "Queuing…" : "Move to Quarantine"}</button>,
  ]}>
    <div className="card card-pad" style={{ marginBottom: 16 }}><b>{files ? files.length : "…"} cataloged file(s) · {formatBytes(bytes)}</b><p className="muted" style={{ marginBottom: 0, fontSize: 13 }}>Files are retained for {retention} days after approval. Archive and cloud copies have not been verified by this preview.</p></div>
    {!supported && <p className="muted">This preview does not authorize a cleanup operation. Review the recommendation and refresh analysis before approving any move.</p>}
    {files && files.length > 200 && <p className="dim" style={{ fontSize: 12 }}>Showing the first 200 of {files.length} catalog records. Export Report includes every listed record.</p>}
    {files === undefined ? <p className="muted">Loading affected files…</p> : files.length === 0 ? <p className="muted">No active files are available for this recommendation.</p> : <div style={{ maxHeight: 330, overflow: "auto", border: "1px solid var(--line)", borderRadius: "var(--r)" }}><table className="tbl"><thead><tr><th>Actual file path</th><th>Classification</th><th>Size</th></tr></thead><tbody>{files.slice(0, 200).map((f: any) => <tr key={f._id}><td className="mono" style={{ fontSize: 11, overflowWrap: "anywhere" }}>{f.path}</td><td><Badge kind={f.protected ? "risk" : ""}>{f.classification}{f.protected ? " · protected" : ""}</Badge></td><td className="mono">{formatBytes(f.sizeBytes)}</td></tr>)}</tbody></table></div>}
  </Modal>;
}

function DeleteConfirmModal({ title, count, busy, onClose, onConfirm }: { title: string; count: number; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = React.useState("");
  const armed = typed.trim().toUpperCase() === "DELETE";
  if (typeof document === "undefined") return null;
  return createPortal(<Modal title="Permanently delete files" subtitle={title} icon="trash" iconKind="risk" onClose={onClose} width={560} footer={[<button key="cancel" className="btn" onClick={onClose}>Cancel</button>, <button key="delete" className="btn danger" disabled={!armed || busy} onClick={onConfirm}>{busy ? "Queuing…" : "Permanently delete"}</button>]}><p>These {count} file(s) will be permanently removed by their local agent. This cannot be undone.</p><label className="field-label" htmlFor="permanent-delete-confirm">Type DELETE to confirm</label><input id="permanent-delete-confirm" className="input mono" placeholder="DELETE" value={typed} autoFocus onChange={e => setTyped(e.target.value)} /></Modal>, document.body);
}

export function QuarantineScreen({ go, toast }: ScreenProps) {
  const query = useQuery(api.cleanup.listQuarantine);
  const [clockTick, setClockTick] = React.useState(() => Math.floor(Date.now() / 60000));
  React.useEffect(() => {
    const timer = setInterval(() => setClockTick(Math.floor(Date.now() / 60000)), 60000);
    return () => clearInterval(timer);
  }, []);
  const purgeable = useQuery(api.cleanup.purgeableCount, { refreshAt: clockTick });
  const settings = useQuery(api.settings.get);
  const context = useQuery(api.tenants.currentContext);
  const requestRestore = useMutation(api.cleanup.requestRestore);
  const purgeItem = useMutation(api.cleanup.purgeItem);
  const purgeExpired = useMutation(api.cleanup.purgeExpired);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<any | null>(null);
  const active = (query || []).filter((q: any) => ["quarantined", "pending_restore", "pending_purge"].includes(q.status));
  const canPurge = context?.member.role === "admin";
  const restorable = active.filter((q: any) => q.status === "quarantined");
  const deadline = restorable.reduce((earliest: number, q: any) => Math.min(earliest, q.rollbackUntil), Infinity);
  const actor = context?.member.email || "";
  async function restore(id: string) {
    if (busyId) return; setBusyId(id);
    try { await requestRestore({ quarantineId: id }); toast("Restore queued — waiting for the agent to move the file back", "rotate", "accent"); }
    catch (error) { toast(errorText(error), "alert", "risk"); } finally { setBusyId(null); }
  }
  async function remove() {
    if (!deleting || busyId) return; setBusyId(deleting === "expired" ? "expired" : deleting._id);
    try { const result = deleting === "expired" ? await purgeExpired({ requestedBy: actor }) : await purgeItem({ quarantineId: deleting._id, requestedBy: actor }); toast(`Queued ${result.queued} file(s) for permanent deletion`, "trash", "risk"); setDeleting(null); }
    catch (error) { toast(errorText(error), "alert", "risk"); } finally { setBusyId(null); }
  }
  return <div className="page-inner">
    <PageHead eyebrow="Maintenance" title="Quarantine" desc={`Files remain recoverable until their recorded restore deadline. New jobs use a ${settings?.retentionDays ?? 14}-day retention period.`} actions={[<button key="back" className="btn" onClick={() => go("cleanup")}>Back to Cleanup</button>, ...(canPurge ? [<button key="purge" className="btn danger" disabled={!purgeable?.count || busyId !== null} onClick={() => setDeleting("expired")}>Empty expired{purgeable?.count ? ` (${purgeable.count})` : ""}</button>] : [])]} />
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--gap)", marginBottom: "var(--gap)" }}>{[["In Quarantine", formatBytes(active.reduce((sum: number, q: any) => sum + q.sizeBytes, 0))], ["Items", active.length], ["Restorable", restorable.length], ["Earliest deadline", Number.isFinite(deadline) ? new Date(deadline).toLocaleDateString() : "—"]].map(([label, value]) => <div className="card card-pad" key={label}><div className="eyebrow">{label}</div><div className="stat-num" style={{ fontSize: 22, marginTop: 8 }}>{value}</div></div>)}</div>
    {query === undefined ? <div className="card card-pad muted">Loading quarantine…</div> : active.length === 0 ? <div className="card"><div className="empty"><h3>Quarantine is empty</h3><div className="muted">Files appear here after an agent confirms their move. Restored and permanently deleted files leave this list.</div></div></div> : <div className="card" style={{ overflowX: "auto" }}><table className="tbl"><thead><tr><th>File</th><th>Status</th><th>Moved</th><th>Restore deadline</th><th>Size</th><th>Actions</th></tr></thead><tbody>{active.map((q: any) => <tr key={q._id}><td><div className="hi mono" style={{ fontSize: 12 }}>{q.originalPath.split(/[\\/]/).pop()}</div><div className="dim mono" style={{ fontSize: 10.5, overflowWrap: "anywhere", maxWidth: 480 }}>{q.originalPath}</div></td><td><Badge kind={q.status === "quarantined" ? "warn" : "accent"}>{q.status === "pending_restore" ? "Restore queued" : q.status === "pending_purge" ? "Delete queued" : "Quarantined"}</Badge></td><td className="mono muted">{new Date(q.movedAt).toLocaleString()}</td><td className="mono muted">{new Date(q.rollbackUntil).toLocaleString()}</td><td className="mono">{formatBytes(q.sizeBytes)}</td><td><div className="row" style={{ gap: 7 }}><button className="btn sm" disabled={q.status !== "quarantined" || busyId !== null} onClick={() => void restore(q._id)}>Restore</button>{canPurge && <button className="btn sm danger" disabled={q.status !== "quarantined" || busyId !== null} onClick={() => setDeleting(q)}>Delete</button>}</div></td></tr>)}</tbody></table></div>}
    {deleting && <DeleteConfirmModal title={deleting === "expired" ? "Expired quarantine items" : deleting.originalPath.split(/[\\/]/).pop()} count={deleting === "expired" ? purgeable?.count || 0 : 1} busy={busyId !== null} onClose={() => setDeleting(null)} onConfirm={() => void remove()} />}
  </div>;
}
