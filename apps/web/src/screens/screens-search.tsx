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
type RoleMeta = Record<string, [string, string, string]>;



/* ============================================================
   DriveOS — Global Search
   ============================================================ */



  const ROLE_META: RoleMeta = { working: ["ok", "Working copy", "hdd"], duplicate: ["warn", "Stale duplicate", "copy"], archive: ["auto", "Archive copy", "archive"] };

  function SearchScreen({ go, toast }: ScreenProps) {
    const [q, setQ] = React.useState("");
    const ref = React.useRef<HTMLInputElement | null>(null);
    React.useEffect(() => { if (ref.current) ref.current.focus(); }, []);

    const ql = q.trim().toLowerCase();
    const projHits = ql ? DB.projects.filter((p) => [p.name, p.client, p.show].filter(Boolean).join(" ").toLowerCase().includes(ql)) : [];
    const driveHits = ql ? DB.drives.filter((d) => [d.name, d.model, d.id].filter(Boolean).join(" ").toLowerCase().includes(ql)) : [];
    // Live file matches from Convex (DB.files is populated by the files.list query).
    const fileHits = ql ? DB.files.filter((f: any) =>
      [f.name, f.path, f.quickHash, f.fullHash].filter(Boolean).join(" ").toLowerCase().includes(ql)).slice(0, 25) : [];
    const hasResults = projHits.length > 0 || driveHits.length > 0 || fileHits.length > 0;

    return h("div", { className: "page-inner", style: { maxWidth: 920 } },
      h(PageHead, { eyebrow: "System", title: "Search", desc: "Find any file, hash, project, drive, or folder across every tracked volume and the cloud." }),

      // big search
      h("div", { className: "card fade-up", style: { marginBottom: "var(--gap)" } },
        h("div", { className: "row", style: { padding: "4px 8px 4px 18px", gap: 12 } },
          h(Icon, { name: "search", size: 20, style: { color: "var(--tx-mut)" } }),
          h("input", { ref, className: "input", style: { border: "none", background: "transparent", height: 56, fontSize: 18, fontFamily: "var(--font-mono)" }, placeholder: "A001_C004, hash, project name…", value: q, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQ(e.target.value) }),
          q && h("button", { className: "btn ghost icon", onClick: () => setQ("") }, h(Icon, { name: "x", size: 18 })))),

      // hint when nothing typed yet
      !ql && h("div", { className: "muted", style: { fontSize: 13, padding: "4px 2px" } },
        "Type a file name, path, project, drive, or hash to search across everything DriveOS has indexed."),

      // project / drive / file matches
      (projHits.length > 0 || driveHits.length > 0 || fileHits.length > 0) && h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--gap)" } },
        fileHits.length > 0 && cardShell("Files · " + fileHits.length, "film", "var(--tx-mut)", null,
          h("div", { style: { padding: "6px 0" } }, fileHits.map((f: any) => {
            const rm = (RISK_META as Record<string, any>)[f.risk] || RISK_META.review;
            return h("div", { key: f.id, className: "offender-row spread", style: { padding: "11px 18px" } },
              h("div", { style: { minWidth: 0 } },
                h("span", { className: "mono hi", style: { fontWeight: 600, fontSize: 12.5 } }, f.name || "Untitled file"),
                h("div", { className: "mono dim", style: { fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 520 } }, f.path)),
              h("div", { className: "row", style: { gap: 10, flexShrink: 0 } },
                h(Badge, { kind: rm.cls }, f.type),
                h("span", { className: "mono", style: { fontSize: 12, color: "var(--tx-mut)" } }, fmtGB(f.sizeGB))));
          }))),
        projHits.length > 0 && cardShell("Projects · " + projHits.length, "folder", "var(--tx-mut)", null,
          h("div", { style: { padding: "6px 0" } }, projHits.map((p) => {
            const status = PROJ_STATUS[p.status] || PROJ_STATUS.active;
            return h("div", { key: p.id, className: "offender-row spread", onClick: () => go("project", { id: p.id }), style: { padding: "11px 18px", cursor: "pointer" } },
              h("div", null, h("span", { className: "hi", style: { fontWeight: 600, fontSize: 13 } }, p.name || "Untitled project"), h("span", { className: "muted", style: { fontSize: 11.5, marginLeft: 8 } }, p.client || "No client")),
              h(Badge, { kind: status.cls }, status.label));
          }))),
        driveHits.length > 0 && cardShell("Drives · " + driveHits.length, "hdd", "var(--tx-mut)", null,
          h("div", { style: { padding: "6px 0" } }, driveHits.map((d) => h("div", { key: d.id, className: "offender-row spread", onClick: () => go("drive", { id: d.id }), style: { padding: "11px 18px", cursor: "pointer" } },
            h("div", null, h("span", { className: "hi", style: { fontWeight: 600, fontSize: 13 } }, d.name || "Untitled drive"), h("span", { className: "muted mono", style: { fontSize: 11, marginLeft: 8 } }, d.model || d.bus || d.id || "Unknown model")),
            h(StatusBadge, { status: d.status }))))) ),

      // no results
      ql && !hasResults &&
        h("div", { className: "card" }, h("div", { className: "empty" }, h("div", { className: "empty-ico" }, h(Icon, { name: "search", size: 24 })), h("h3", null, "No matches for “" + q + "”"), h("div", { className: "muted" }, "Try a filename, project, drive, or a fingerprint hash."))));
  }


  


export { SearchScreen };
