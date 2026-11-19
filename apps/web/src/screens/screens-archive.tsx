import React from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convexApi";
import { DB } from "@/data";
import { Icon } from "@/components/icons";
import { Badge, Modal, PageHead, StatusBadge } from "@/components/components";
import { formatBytes } from "@/lib/download";

type ScreenProps = Record<string, any>;
const CHECKLIST = [
  "Final exports and delivery masters are present",
  "Original footage and project files are present",
  "Licenses, fonts, and graphics are included",
  "An independent archive or backup copy has been checked",
  "Required cloud delivery has been checked outside DriveOS",
  "Generated files to keep or clean have been reviewed",
];
const message = (error: unknown) => error instanceof Error ? error.message : "The archive request could not be completed.";

export function ArchiveChecklistModal({ p, onClose, toast, go }: ScreenProps) {
  const manifests = useQuery(api.archive.listManifests);
  const jobs = useQuery(api.cleanup.listJobs);
  const requestManifest = useMutation(api.archive.requestManifest);
  const updateStatus = useMutation(api.projects.updateStatus);
  const [done, setDone] = React.useState<boolean[]>(() => CHECKLIST.map(() => false));
  const [busy, setBusy] = React.useState(false);
  const projectId = p?.id || p?._id;
  const latest = (manifests || []).filter((m: any) => m.projectId === projectId && /archive_manifest\.json$/i.test(m.manifestPath)).sort((a: any, b: any) => b.createdAt - a.createdAt)[0];
  const latestJob = (jobs || []).find((j: any) => j.action === "generate_manifest" && j.result?.projectId === projectId);
  const running = latestJob && ["approved", "queued", "running"].includes(latestJob.status);
  const verified = latest?.status === "verified";

  async function request(verify = false) {
    if (!projectId || busy) return;
    setBusy(true);
    try { await requestManifest({ projectId, verify }); toast(verify ? "Archive verification queued for the agent" : "Archive manifest queued for the agent", "clock", "accent"); }
    catch (error) { toast(message(error), "alert", "risk"); }
    finally { setBusy(false); }
  }
  async function archive() {
    if (!projectId || !verified || !done.every(Boolean) || busy) return;
    setBusy(true);
    try { await updateStatus({ projectId, status: "archived" }); toast(`${p.name} marked archived`, "archive", "ok"); onClose(); go?.("archive"); }
    catch (error) { toast(message(error), "alert", "risk"); }
    finally { setBusy(false); }
  }
  return <Modal title={`Archive Checklist${p ? ` — ${p.name}` : ""}`} subtitle="Review these conditions yourself. Checkmarks are your confirmation, not an automatic backup verification." icon="archive" iconKind="auto" onClose={onClose} width={760} footer={[
    <button key="close" className="btn" onClick={onClose}>Cancel</button>,
    <button key="generate" className="btn" disabled={!projectId || busy || Boolean(running)} onClick={() => void request(false)}>Generate Manifest</button>,
    <button key="verify" className="btn" disabled={!latest || busy || Boolean(running)} onClick={() => void request(true)}>Verify Manifest</button>,
    <button key="archive" className="btn primary" disabled={!projectId || !verified || !done.every(Boolean) || busy} onClick={() => void archive()}>Mark Archived</button>,
  ]}>
    {!projectId ? <p className="muted">Select a project before starting an archive.</p> : <>
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="spread"><b>Archive manifest</b><Badge kind={verified ? "ok" : latest?.status === "failed" ? "risk" : "warn"}>{running ? `Agent job ${latestJob.status}` : latest?.status || "Not generated"}</Badge></div>
        <p className="muted" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 0 }}>{latest ? `${latest.fileCount} files · ${formatBytes(latest.totalBytes)} · ${latest.manifestPath}` : "The agent creates a file inventory and checksums from the actual project folder. Its verification must finish before the project can be marked archived."}</p>
        {latestJob?.status === "failed" && <p style={{ color: "var(--risk)", fontSize: 12 }}>{latestJob.result?.error || "The agent could not complete this archive request. Check its log."}</p>}
      </div>
      <div style={{ display: "grid", gap: 9 }}>{CHECKLIST.map((text, i) => <label key={text} className="row" style={{ gap: 11, padding: 13, border: "1px solid var(--line)", borderRadius: "var(--r)", background: done[i] ? "var(--ok-soft)" : "var(--bg-surface)", cursor: "pointer" }}><input type="checkbox" checked={done[i]} onChange={e => setDone(previous => previous.map((value, index) => index === i ? e.target.checked : value))} /><span style={{ fontSize: 13 }}>{text}</span></label>)}</div>
      <p className="dim" style={{ fontSize: 12 }}>Manifest verification checks the current project inventory. It does not prove that a separate drive or cloud backup exists.</p>
    </>}
  </Modal>;
}

export function ArchiveScreen({ go, toast }: ScreenProps) {
  const manifests = useQuery(api.archive.listManifests);
  const requestManifest = useMutation(api.archive.requestManifest);
  const [selected, setSelected] = React.useState("");
  const [modal, setModal] = React.useState<any | null>(null);
  const [busy, setBusy] = React.useState(false);
  const projects = DB.projects;
  const selectedProject = projects.find(p => p.id === selected) || projects[0];
  const ready = projects.filter(p => ["ready", "ready_to_archive", "delivered"].includes(p.status));
  const archiveDrives = DB.drives.filter(d => d.tier === "cold");
  const fullManifests = (manifests || []).filter((m: any) => /archive_manifest\.json$/i.test(m.manifestPath));
  const latestSelected = fullManifests.filter((m: any) => m.projectId === selectedProject?.id).sort((a: any, b: any) => b.createdAt - a.createdAt)[0];
  async function verify() {
    if (!selectedProject || busy) return;
    setBusy(true);
    try { await requestManifest({ projectId: selectedProject.id, verify: true }); toast("Archive verification queued for the agent", "clock", "accent"); }
    catch (error) { toast(message(error), "alert", "risk"); }
    finally { setBusy(false); }
  }
  return <div className="page-inner">
    <PageHead eyebrow="Storage" title="Archive" desc="Generate and verify actual project inventories. Backup-copy confirmation remains a separate review." actions={[
      <button key="verify" className="btn" disabled={!latestSelected || busy} title={!latestSelected ? "Generate a full archive manifest first" : "Verify the selected project's actual inventory"} onClick={() => void verify()}><Icon name="shieldCheck" size={15} />Verify Archive</button>,
      <button key="checklist" className="btn primary" disabled={!selectedProject} onClick={() => setModal(selectedProject)}><Icon name="archive" size={15} />Start Archive Checklist</button>,
    ]} />
    <div className="card card-pad" style={{ marginBottom: "var(--gap)" }}><label className="field-label" htmlFor="archive-project">Project</label><select id="archive-project" className="select" value={selectedProject?.id || ""} onChange={e => setSelected(e.target.value)} style={{ minWidth: 280 }}>{projects.length === 0 ? <option value="">No projects available</option> : projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--gap)", marginBottom: "var(--gap)" }}>{[
      ["Ready for review", ready.length], ["Archive drives", archiveDrives.length], ["Cold storage used", formatBytes(archiveDrives.reduce((sum, d) => sum + d.usedTB * 1024 ** 4, 0))], ["Verified manifests", fullManifests.filter((m: any) => m.status === "verified").length],
    ].map(([label, value]) => <div className="card card-pad" key={label}><div className="eyebrow">{label}</div><div className="stat-num" style={{ fontSize: 23, marginTop: 8 }}>{value}</div></div>)}</div>
    <h3 style={{ fontSize: 15 }}>Projects Ready for Archive Review</h3>
    {ready.length === 0 ? <div className="card card-pad muted" style={{ marginBottom: "var(--gap)" }}>No delivered or ready-to-archive projects yet. Any tracked project can generate a manifest from the selector above.</div> : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: "var(--gap)", marginBottom: "var(--gap)" }}>{ready.map(p => <div className="card card-pad" key={p.id}><h3 style={{ marginTop: 0, fontSize: 15 }}>{p.name}</h3><p className="muted">{p.client} · {formatBytes(p.sizeTB * 1024 ** 4)}</p><div className="row" style={{ gap: 8 }}><button className="btn primary sm" onClick={() => setModal(p)}>Archive Checklist</button><button className="btn sm" onClick={() => go("project", { id: p.id })}>Open</button></div></div>)}</div>}
    <h3 style={{ fontSize: 15 }}>Archive Drive Catalog</h3>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "var(--gap)", marginBottom: "var(--gap)" }}>{archiveDrives.length === 0 ? <div className="card card-pad muted">No drives are assigned to cold storage.</div> : archiveDrives.map(d => <button className="card card-pad" key={d.id} style={{ textAlign: "left", cursor: "pointer" }} onClick={() => go("drive", { id: d.id })}><div className="spread"><b>{d.name}</b><StatusBadge status={d.status} /></div><p className="muted">{d.location} · {formatBytes(d.usedTB * 1024 ** 4)} used</p><div className="dim" style={{ fontSize: 12 }}>Backup checksums have not been verified for this drive.</div></button>)}</div>
    {modal && <ArchiveChecklistModal p={modal} onClose={() => setModal(null)} toast={toast} go={go} />}
  </div>;
}
