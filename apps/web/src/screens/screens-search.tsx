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


  const S = DB.searchSample;

  const ROLE_META: RoleMeta = { working: ["ok", "Working copy", "hdd"], duplicate: ["warn", "Stale duplicate", "copy"], archive: ["auto", "Archive copy", "archive"] };

  function SearchScreen({ go, toast }: ScreenProps) {
    const [q, setQ] = React.useState("A001_C004");
    const ref = React.useRef<HTMLInputElement | null>(null);
    React.useEffect(() => { if (ref.current) ref.current.focus(); }, []);

    const ql = q.trim().toLowerCase();
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const showSample = ql && norm("A001_C004").includes(norm(q)) && norm(q).length > 1;
    const projHits = ql ? DB.projects.filter((p) => [p.name, p.client, p.show].filter(Boolean).join(" ").toLowerCase().includes(ql)) : [];
    const driveHits = ql ? DB.drives.filter((d) => [d.name, d.model, d.id].filter(Boolean).join(" ").toLowerCase().includes(ql)) : [];
    // Live file matches from Convex (DB.files is populated by the files.list query).
    const fileHits = ql ? DB.files.filter((f: any) =>
      [f.name, f.path, f.quickHash, f.fullHash].filter(Boolean).join(" ").toLowerCase().includes(ql)).slice(0, 25) : [];
    const hasResults = showSample || projHits.length > 0 || driveHits.length > 0 || fileHits.length > 0;

    return h("div", { className: "page-inner", style: { maxWidth: 920 } },
      h(PageHead, { eyebrow: "System", title: "Search", desc: "Find any file, hash, project, drive, or folder across every tracked volume and the cloud." }),

      // big search
      h("div", { className: "card fade-up", style: { marginBottom: "var(--gap)" } },
        h("div", { className: "row", style: { padding: "4px 8px 4px 18px", gap: 12 } },
          h(Icon, { name: "search", size: 20, style: { color: "var(--tx-mut)" } }),
          h("input", { ref, className: "input", style: { border: "none", background: "transparent", height: 56, fontSize: 18, fontFamily: "var(--font-mono)" }, placeholder: "A001_C004, hash, project name…", value: q, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQ(e.target.value) }),
          q && h("button", { className: "btn ghost icon", onClick: () => setQ("") }, h(Icon, { name: "x", size: 18 })))),

      // quick chips
      !ql && h("div", null,
        h("div", { className: "eyebrow", style: { marginBottom: 10 } }, "Try searching"),
        h("div", { className: "chip-row" }, ["A001_C004", "Show X", "CJ Working SSD", "city_timelapse", "xxh64:9f3a"].map((s: string) =>
          h("button", { key: s, className: "tag", style: { cursor: "pointer", height: 30, padding: "0 12px" }, onClick: () => setQ(s) }, h(Icon, { name: "search", size: 12 }), s)))),

      // sample file result
      showSample && h(FileResult, { go, toast }),

      // project / drive / file matches
      (projHits.length > 0 || driveHits.length > 0 || fileHits.length > 0) && !showSample && h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--gap)" } },
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

  function FileResult({ go, toast }: ScreenProps) {
    return h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--gap)" } },
      // file header card
      h("div", { className: "card fade-up" },
        h("div", { className: "card-pad", style: { display: "flex", gap: 16 } },
          h("div", { style: { width: 52, height: 52, borderRadius: 12, flexShrink: 0, display: "grid", placeItems: "center", background: "var(--ft-raw)" + "22", color: "var(--ft-raw)", border: "1px solid var(--line)" } }, h(Icon, { name: "film", size: 24 })),
          h("div", { style: { flex: 1, minWidth: 0 } },
            h("div", { className: "row", style: { gap: 10 } }, h("span", { className: "mono hi", style: { fontSize: 17, fontWeight: 600 } }, S.file.name), h(Badge, { kind: "warn", icon: "copy" }, "3 copies")),
            h("div", { className: "row", style: { gap: 16, marginTop: 8, fontSize: 12, flexWrap: "wrap" } },
              meta("Size", S.file.sizeGB + " GB"), meta("Type", S.file.type), meta("Camera", S.file.camera), meta("Duration", S.file.duration), meta("Modified", S.file.modified)))),
        h("div", { className: "spread", style: { padding: "13px 18px", borderTop: "1px solid var(--accent-line)", background: "var(--accent-soft)" } },
          h("div", { className: "row", style: { gap: 10 } }, h(Icon, { name: "sparkle", size: 16, style: { color: "var(--accent-hi)" } }),
            h("span", { style: { fontSize: 12.5, color: "var(--tx)" } }, h("b", { className: "hi" }, "Recommended: "), "Keep working + archive copies. Quarantine the stale Brandon duplicate to recover 186 GB.")),
          h("button", { className: "btn sm primary", onClick: () => go("duplicates") }, "Resolve duplicate"))),

      // locations
      cardShell("Found on 3 locations", "map", "var(--tx-mut)", h(Badge, { square: true }, "1 working · 1 archive · 1 cloud"),
        h("div", { style: { padding: "6px 0" } }, S.found.map((f, i) => {
          const rm = ROLE_META[f.role] || ["accent", "Tracked copy", "hdd"];
          const drive = DB.driveById[f.drive] || DB.drives.find((d) => d.id === f.drive) || { name: f.drive || "Unknown drive" };
          return h("div", { key: i, className: "spread offender-row", onClick: () => go("drive", { id: f.drive }), style: { padding: "13px 18px", cursor: "pointer" } },
            h("div", { className: "row", style: { gap: 12, minWidth: 0 } },
              h("span", { style: { width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", flexShrink: 0, background: "var(--" + rm[0] + "-soft)", color: "var(--" + rm[0] + ")" } }, h(Icon, { name: rm[2], size: 15 })),
              h("div", { style: { minWidth: 0 } },
                h("div", { className: "mono", style: { fontSize: 12, color: "var(--tx-hi)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, f.path),
                h("div", { className: "row", style: { gap: 7, marginTop: 3 } }, h("span", { className: "muted", style: { fontSize: 11.5 } }, drive.name), h(StatusBadge, { status: f.status })))),
            h(Badge, { kind: rm[0], style: { flexShrink: 0 } }, rm[1]));
        }))),

      // cross-reference
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: "var(--gap)" } },
        xref("Related Project", "Show X — Ep. 214", "folder", "var(--accent-hi)", () => go("project", { id: "show-x" })),
        xref("Cloud Copy", "Exists · Google Drive", "cloud", "var(--cloud)", () => go("cloud")),
        xref("Archive Copy", "Verified · Brandon Arc 01", "archive", "var(--auto)", () => go("archive"))));
  }
  function meta(label: React.ReactNode, value: React.ReactNode) {
    return h("span", { className: "muted" }, label + ": ", h("b", { className: "hi", style: { fontWeight: 600 } }, value));
  }
  function xref(label: React.ReactNode, value: React.ReactNode, icon: string, color: string, onClick: () => void) {
    return h("div", { className: "card card-pad fade-up", onClick, style: { cursor: "pointer", display: "flex", alignItems: "center", gap: 12 } },
      h("div", { style: { width: 38, height: 38, borderRadius: 10, display: "grid", placeItems: "center", flexShrink: 0, background: "var(--bg-surface)", color, border: "1px solid var(--line)" } }, h(Icon, { name: icon, size: 18 })),
      h("div", { style: { minWidth: 0 } }, h("div", { className: "eyebrow", style: { fontSize: 9, marginBottom: 2 } }, label), h("div", { className: "hi", style: { fontWeight: 600, fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, value)));
  }

  


export { SearchScreen };
