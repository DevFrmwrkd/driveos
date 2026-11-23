import React from "react";
import { useQuery } from "convex/react";
import { api } from "@/convexApi";
import { Badge } from "@/components/components";
import { scanAnalysisMessage, type AnalysisState } from "@/lib/scan-analysis";

type Props = { jobs: Parameters<typeof scanAnalysisMessage>[1]; scans?: Parameters<typeof scanAnalysisMessage>[2] };

export function ScanAnalysisStatus({ jobs, scans = [] }: Props) {
  const analysis = useQuery(api.scans.analysisStatus) as AnalysisState | undefined;
  const message = scanAnalysisMessage(analysis, jobs, scans);
  if (!message) return null;
  return <div className="page-inner" style={{ paddingBottom: 0 }}>
    <div className="card card-pad" role="status" aria-live="polite">
      <div style={{ marginBottom: 7 }}><Badge kind={message.kind}>{message.title}</Badge></div>
      <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>{message.detail}</div>
    </div>
  </div>;
}
