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
const h: any = React.createElement;

type ScreenProps = Record<string, any>;



/* ============================================================
   DriveOS — Cloud Storage
   ============================================================ */


  function CloudScreen({ go, toast }: ScreenProps) {
    // Cloud connections come from Convex (none yet — cloud sync is a future
    // feature). Show a clear not-connected state rather than fake numbers.
    const connections: any[] = (DB as any).cloudConnections || [];

    return h("div", { className: "page-inner" },
      h(PageHead, { eyebrow: "Storage", title: "Cloud Storage", desc: "Track cloud storage (Google Drive, Dropbox, iCloud) alongside local drives." }),

      connections.length === 0
        ? h("div", { className: "card fade-up" },
            h("div", { className: "empty", style: { padding: "60px 24px", textAlign: "center" } },
              h("div", { className: "empty-ico" }, h(Icon, { name: "cloud", size: 26 })),
              h("h3", { style: { marginTop: 12 } }, "No cloud provider connected"),
              h("div", { className: "muted", style: { fontSize: 13, marginTop: 6, maxWidth: 440, marginLeft: "auto", marginRight: "auto", lineHeight: 1.5 } },
                "Connect a cloud account (Google Drive, Dropbox, iCloud) to track its quota, find sync gaps, and spot cloud duplicates next to your local drives."),
              h("div", { className: "mono dim", style: { fontSize: 11.5, marginTop: 16 } }, "Cloud sync is coming soon.")))
        : h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--gap)" } },
            connections.map((c: any, i: number) => {
              const used = (c.usedBytes || 0) / (1024 ** 4);
              const cap = (c.capacityBytes || 0) / (1024 ** 4);
              return h("div", { key: i, className: "card card-pad fade-up", style: { display: "flex", gap: 18, alignItems: "center" } },
                h("div", { style: { width: 42, height: 42, borderRadius: 11, display: "grid", placeItems: "center", background: "var(--cloud-soft)", color: "var(--cloud)", border: "1px solid var(--cloud-line)" } }, h(Icon, { name: "cloud", size: 20 })),
                h("div", { style: { flex: 1 } },
                  h("div", { className: "hi", style: { fontWeight: 600, fontSize: 14 } }, c.provider || "Cloud"),
                  h("div", { className: "mono dim", style: { fontSize: 11 } }, c.account || ""),
                  h("div", { className: "stat-num", style: { fontSize: 20, marginTop: 6 } }, fmtTB(used), cap > 0 && h("span", { style: { fontSize: 13, color: "var(--tx-mut)", fontWeight: 600 } }, " / " + cap.toFixed(0) + " TB")),
                  cap > 0 && h("div", { style: { marginTop: 8 } }, h(Bar, { value: used, max: cap, kind: "cloud", height: 8 }))));
            })));
  }

  


export { CloudScreen };
