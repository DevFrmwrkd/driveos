import React from "react";
import { Modal } from "@/components/components";
import { formatBytes } from "@/lib/download";

type SelectedFile = { fileId: string; path: string; sizeBytes?: number };
type Props = {
  files: SelectedFile[];
  keepPath?: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
};

export function DuplicateQuarantineConfirmation({ files, keepPath, busy, onClose, onConfirm }: Props) {
  const [approved, setApproved] = React.useState(false);
  async function confirm() {
    if (!approved || busy) return;
    await onConfirm();
  }
  return <Modal title="Approve duplicate quarantine" subtitle="Review the selected paths before approving a move" icon="shield" iconKind="warn" width={760}
    onClose={() => { if (!busy) onClose(); }} footer={[
      <label key="approve" className="row" style={{ gap: 8, marginRight: "auto", fontSize: 12 }}>
        <input type="checkbox" checked={approved} disabled={busy} onChange={event => setApproved(event.target.checked)} />
        I approve moving these files to quarantine.
      </label>,
      <button key="cancel" className="btn" disabled={busy} onClick={onClose}>Cancel</button>,
      <button key="move" className="btn primary" disabled={!approved || busy} onClick={() => void confirm()}>{busy ? "Queuing…" : "Move to Quarantine"}</button>,
    ]}>
    <p>{files.length} selected file(s) · {formatBytes(files.reduce((sum, file) => sum + (file.sizeBytes || 0), 0))}</p>
    <p className="muted">The agent will move these files into quarantine and recheck the keep copy. Files move only after the approved job runs.</p>
    <div style={{ maxHeight: 260, overflow: "auto" }}>{files.map(file => <div key={file.fileId} className="mono" style={{ padding: "10px 0", overflowWrap: "anywhere", fontSize: 12 }}>{file.path}</div>)}</div>
    {keepPath && <p className="muted" style={{ fontSize: 12, overflowWrap: "anywhere" }}>Keep copy: {keepPath}</p>}
  </Modal>;
}
