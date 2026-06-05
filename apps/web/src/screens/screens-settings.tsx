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
const h = React.createElement;



/* ============================================================
   DriveOS — Settings
   ============================================================ */


  

  const SECTIONS = [
    { id: "team", label: "Team Members", icon: "users" },
    { id: "agents", label: "Machines / Agents", icon: "cpu" },
    { id: "templates", label: "Folder Templates", icon: "folder" },
    { id: "rules", label: "Cleanup Rules", icon: "broom" },
    { id: "classify", label: "File Classification", icon: "filter" },
    { id: "cloud", label: "Cloud Integrations", icon: "cloud" },
    { id: "tiers", label: "Storage Tiers", icon: "layers" },
    { id: "safedelete", label: "Quarantine & Safe Delete", icon: "shield" },
    { id: "notif", label: "Notifications", icon: "bell" },
    { id: "audit", label: "Audit Log", icon: "list" },
  ];

  function Toggle({ on, onChange }) {
    return h("div", { onClick: () => onChange(!on), style: { width: 42, height: 24, borderRadius: 99, flexShrink: 0, cursor: "pointer", background: on ? "var(--accent)" : "var(--bg-elevated)", border: "1px solid " + (on ? "var(--accent-lo)" : "var(--line-strong)"), position: "relative", transition: "background .15s" } },
      h("span", { style: { position: "absolute", top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: 99, background: "#fff", transition: "left .15s", boxShadow: "0 1px 3px rgba(0,0,0,.4)" } }));
  }
  function Row({ title, desc, control }) {
    return h("div", { className: "spread", style: { padding: "15px 0", borderBottom: "1px solid var(--line-faint)" } },
      h("div", { style: { minWidth: 0, paddingRight: 20 } }, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 13.5 } }, title), desc && h("div", { className: "muted", style: { fontSize: 12, marginTop: 3 } }, desc)),
      h("div", { style: { flexShrink: 0 } }, control));
  }

  function SettingsScreen({ go, toast }) {
    const [sec, setSec] = React.useState("team");
    return h("div", { className: "page-inner" },
      h(PageHead, { eyebrow: "System", title: "Settings", desc: "Configure team, agents, templates, rules, and the safety behavior of DriveOS." }),
      h("div", { style: { display: "grid", gridTemplateColumns: "232px 1fr", gap: "var(--gap)", alignItems: "start" } },
        // sub-nav
        h("div", { className: "card fade-up", style: { padding: 8, position: "sticky", top: 0 } },
          SECTIONS.map((s) => h("div", { key: s.id, className: "nav-item " + (sec === s.id ? "active" : ""), onClick: () => setSec(s.id), style: { marginBottom: 1 } },
            h(Icon, { name: s.icon, size: 16 }), h("span", null, s.label)))),
        // content
        h("div", { key: sec, className: "fade-up", style: { minWidth: 0 } },
          sec === "team" && h(TeamSettings, { toast }),
          sec === "agents" && h(AgentSettings, null),
          sec === "templates" && h(TemplateSettings, { toast }),
          sec === "rules" && h(RuleSettings, null),
          sec === "classify" && h(ClassifySettings, null),
          sec === "cloud" && h(CloudSettings, { toast }),
          sec === "tiers" && h(TierSettings, null),
          sec === "safedelete" && h(SafeDeleteSettings, null),
          sec === "notif" && h(NotifSettings, null),
          sec === "audit" && h(AuditSettings, null))));
  }

  function Panel({ title, desc, action, children }) {
    return h("div", { className: "card" },
      h("div", { className: "card-head" }, h("div", null, h("div", { className: "card-title" }, title), desc && h("div", { className: "muted", style: { fontSize: 12, marginTop: 2 } }, desc)), action && h("div", { className: "right" }, action)),
      h("div", { className: "card-pad" }, children));
  }

  function TeamSettings({ toast }) {
    return h(Panel, { title: "Team Members", desc: "People with access to DriveOS and their storage footprint.", action: h("button", { className: "btn sm primary", onClick: () => toast("Invite sent", "user", "accent") }, h(Icon, { name: "plus", size: 14 }), "Invite") },
      h("table", { className: "tbl" },
        h("thead", null, h("tr", null, ["Member", "Role", "Location", "Drives", "Storage", "Access"].map((c, i) => h("th", { key: i, className: i === 3 || i === 4 ? "num" : "" }, c)))),
        h("tbody", null, DB.team.map((m) => h("tr", { key: m.id, style: { cursor: "default" } },
          h("td", null, h("div", { className: "row", style: { gap: 10 } }, h(Avatar, { id: m.id, size: 28 }), h("span", { className: "hi", style: { fontWeight: 600 } }, m.name))),
          h("td", { className: "muted" }, m.role),
          h("td", { className: "muted" }, m.location),
          h("td", { className: "num mono" }, m.drives),
          h("td", { className: "num mono hi" }, m.usedTB > 0 ? fmtTB(m.usedTB) : "—"),
          h("td", null, h(Badge, { kind: m.role.includes("Founder") ? "accent" : "" }, m.role.includes("Founder") ? "Admin" : "Editor")))))));
  }

  function AgentSettings() {
    const agents = [
      { name: "CJ-Studio-MBP", os: "macOS 15.2", user: "cj", status: "online", v: "1.8.2", drives: 2 },
      { name: "Brandon-Tower", os: "Windows 11", user: "brandon", status: "online", v: "1.8.2", drives: 3 },
      { name: "Ingest-Station", os: "macOS 15.1", user: "mara", status: "online", v: "1.8.2", drives: 2 },
      { name: "Kenji-Tokyo-MBP", os: "macOS 15.2", user: "kenji", status: "online", v: "1.8.1", drives: 2 },
      { name: "Studio-NAS-Agent", os: "Synology DSM", user: "founder", status: "offline", v: "1.7.9", drives: 4 },
    ];
    return h(Panel, { title: "Machines / Agents", desc: "Local agents that scan and watch drives. Metadata only — no media is uploaded.", action: h("button", { className: "btn sm" }, h(Icon, { name: "download", size: 14 }), "Install Agent") },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 10 } }, agents.map((a, i) =>
        h("div", { key: i, className: "spread", style: { padding: "13px 15px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
          h("div", { className: "row", style: { gap: 12 } },
            h("div", { style: { width: 36, height: 36, borderRadius: 9, display: "grid", placeItems: "center", flexShrink: 0, background: a.status === "online" ? "var(--ok-soft)" : "var(--bg-panel-2)", color: a.status === "online" ? "var(--ok)" : "var(--tx-dim)" } }, h(Icon, { name: "cpu", size: 17 })),
            h("div", null, h("div", { className: "hi mono", style: { fontWeight: 600, fontSize: 13 } }, a.name),
              h("div", { className: "muted", style: { fontSize: 11.5 } }, a.os + " · " + DB.teamById[a.user].name + " · " + a.drives + " drives"))),
          h("div", { className: "row", style: { gap: 10 } }, h("span", { className: "mono dim", style: { fontSize: 11 } }, "agent v" + a.v), h(StatusBadge, { status: a.status }))))));
  }

  function TemplateSettings({ toast }) {
    return h(Panel, { title: "Folder Templates", desc: "Structures used by the Create Project wizard.", action: h("button", { className: "btn sm primary", onClick: () => toast("New template", "plus", "accent") }, h(Icon, { name: "plus", size: 14 }), "New Template") },
      h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 } }, DB.templates.filter((t) => t.id !== "custom").map((t) =>
        h("div", { key: t.id, className: "spread", style: { padding: "14px 15px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
          h("div", null, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 13.5 } }, t.name), h("div", { className: "muted", style: { fontSize: 11.5, marginTop: 2 } }, t.desc), h("div", { className: "mono dim", style: { fontSize: 10.5, marginTop: 4 } }, t.folders + " folders")),
          h("button", { className: "btn sm ghost icon" }, h(Icon, { name: "settings", size: 15 }))))));
  }

  function RuleSettings() {
    const [rules, setRules] = React.useState({ raw: true, proxy: true, cache: true, finals: true, license: true, abandoned: false });
    const items = [
      ["raw", "Protect RAW footage", "Never auto-delete original camera files", "shield"],
      ["proxy", "Auto-quarantine proxies after delivery", "Once a project is Delivered", "layers"],
      ["cache", "Auto-quarantine cache after confirmation", "Premiere / DaVinci regenerable cache", "cpu"],
      ["finals", "Protect final exports", "Delivery masters never auto-cleaned", "download"],
      ["license", "Protect license & admin docs", "Music, SFX, paperwork stay with archive", "lock"],
      ["abandoned", "Flag abandoned project copies", "No edits in 60+ days with archive copy present", "box"],
    ];
    return h(Panel, { title: "Cleanup Rules", desc: "Global defaults applied across all projects. Per-project overrides are set in the wizard." },
      items.map(([k, t, d]) => h(Row, { key: k, title: t, desc: d, control: h(Toggle, { on: rules[k], onChange: (v) => setRules((r) => ({ ...r, [k]: v })) }) })));
  }

  function ClassifySettings() {
    const rules = [
      [".mov, .mxf, .braw, .r3d, .ari", "raw", "RAW Footage"],
      ["*_proxy.*, /05_PROXIES/", "proxy", "Proxies"],
      [".pek, .cfa, /06_RENDERS_CACHE/", "cache", "Cache / Renders"],
      ["/07_EXPORTS/, *_FINAL.*", "export", "Exports"],
      ["/STOCK_FOOTAGE/, /artgrid/", "stock", "Stock Footage"],
      [".wav, .aif, .mp3", "audio", "Audio"],
      [".aep, .psd, .ai, .prproj", "gfx", "Graphics / AE"],
    ];
    return h(Panel, { title: "File-Type Classification", desc: "How DriveOS classifies files by extension and path pattern.", action: h("button", { className: "btn sm" }, h(Icon, { name: "plus", size: 14 }), "Add Rule") },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 9 } }, rules.map(([pat, key, label], i) =>
        h("div", { key: i, className: "spread", style: { padding: "12px 14px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
          h("div", { className: "row", style: { gap: 11 } }, h("span", { style: { width: 9, height: 9, borderRadius: 2, background: getVar("var(--ft-" + key + ")"), flexShrink: 0 } }), h("span", { className: "hi", style: { fontWeight: 600, fontSize: 13, width: 130 } }, label), h("span", { className: "mono dim", style: { fontSize: 11.5 } }, pat)),
          h("button", { className: "btn sm ghost icon" }, h(Icon, { name: "settings", size: 14 }))))));
  }

  function CloudSettings({ toast }) {
    return h(Panel, { title: "Cloud Integrations", desc: "Connected cloud storage providers." },
      h("div", { className: "spread", style: { padding: "15px 16px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--cloud-line)" } },
        h("div", { className: "row", style: { gap: 13 } }, h("div", { style: { width: 42, height: 42, borderRadius: 11, display: "grid", placeItems: "center", background: "var(--cloud-soft)", color: "var(--cloud)", border: "1px solid var(--cloud-line)" } }, h(Icon, { name: "cloud", size: 20 })),
          h("div", null, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 14 } }, "Google Workspace"), h("div", { className: "mono dim", style: { fontSize: 11.5 } }, DB.cloud.account + " · 13.4 / 20 TB"))),
        h("div", { className: "row", style: { gap: 9 } }, h(Badge, { kind: "ok", icon: "checkCircle" }, "Connected"), h("button", { className: "btn sm" }, "Manage"))),
      h("div", { style: { marginTop: 12 } }, h("button", { className: "btn", onClick: () => toast("Connecting…", "link", "accent") }, h(Icon, { name: "plus", size: 15 }), "Connect another provider")));
  }

  function TierSettings() {
    return h(Panel, { title: "Storage Tiers", desc: "How drives are grouped and color-coded across DriveOS." },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 11 } }, DB.tiers.map((t) =>
        h("div", { key: t.key, className: "spread", style: { padding: "14px 15px", borderRadius: "var(--r)", background: "var(--bg-surface)", border: "1px solid var(--line)" } },
          h("div", { className: "row", style: { gap: 12 } }, h("span", { style: { width: 12, height: 12, borderRadius: 3, background: getVar(t.color), flexShrink: 0 } }),
            h("div", null, h("div", { className: "hi", style: { fontWeight: 600, fontSize: 13.5 } }, TIER_META[t.key].label + " — " + t.label.split("— ")[1]), h("div", { className: "muted", style: { fontSize: 11.5 } }, t.desc))),
          h("div", { className: "row", style: { gap: 14 } }, h("span", { className: "mono dim", style: { fontSize: 11.5 } }, fmtTB(t.usedTB) + " / " + t.capTB + " TB"), h("div", { style: { width: 90 } }, h(Bar, { value: t.usedTB, max: t.capTB, kind: tierKind(pct(t.usedTB, t.capTB)), height: 6 })))))));
  }

  function SafeDeleteSettings() {
    const [days, setDays] = React.useState(30);
    const [confirm, setConfirm] = React.useState(true);
    const [autoSafe, setAutoSafe] = React.useState(true);
    return h(Panel, { title: "Quarantine & Safe Delete", desc: "The safety net. Quarantine is always the primary action — permanent deletion is protected." },
      h(Row, { title: "Quarantine retention period", desc: "How long files stay restorable before they can be purged.", control: h("div", { className: "row", style: { gap: 12 } },
        h("input", { type: "range", min: 7, max: 90, step: 1, value: days, onChange: (e) => setDays(+e.target.value), style: { width: 160, accentColor: getVar("var(--accent)") } }),
        h("span", { className: "mono hi", style: { fontWeight: 600, width: 60 } }, days + " days")) }),
      h(Row, { title: "Auto-quarantine safe categories", desc: "Let the agent quarantine regenerable cache without approval.", control: h(Toggle, { on: autoSafe, onChange: setAutoSafe }) }),
      h(Row, { title: "Require confirmation for permanent delete", desc: "Force a typed confirmation before any purge.", control: h(Toggle, { on: confirm, onChange: setConfirm }) }),
      h("div", { style: { marginTop: 16, padding: "13px 15px", borderRadius: "var(--r)", background: "var(--risk-soft)", border: "1px solid var(--risk-line)", display: "flex", gap: 11 } },
        h(Icon, { name: "lock", size: 16, style: { color: "var(--risk)", flexShrink: 0, marginTop: 1 } }),
        h("div", { style: { fontSize: 12.5, color: "var(--tx)", lineHeight: 1.5 } }, h("b", { className: "hi" }, "Permanent deletion is disabled by default. "), "Only Admins can purge, and only after the retention window — with a typed confirmation.")));
  }

  function NotifSettings() {
    const [n, setN] = React.useState({ full: true, single: true, archive: true, weekly: true, agent: false });
    const items = [["full", "Drive over 90% full", "Alert when any working drive is nearly full"], ["single", "Single-copy file detected", "Files with no archive or cloud backup"], ["archive", "Project ready to archive", "When a delivered project passes readiness checks"], ["weekly", "Weekly storage digest", "Health summary every Monday"], ["agent", "Agent went offline", "When a machine stops reporting"]];
    const rows = items.map(([k, t, d]) => {
      const control = h(Toggle, { on: n[k], onChange: (v) => setN((x) => ({ ...x, [k]: v })) });
      return h(Row, { key: k, title: t, desc: d, control });
    });
    return h(Panel, { title: "Notifications", desc: "What DriveOS alerts you about." }, rows);
  }

  function AuditSettings() {
    return h(Panel, { title: "Audit Log", desc: "Every quarantine, restore, scan, and config change — retained for compliance.", action: h("button", { className: "btn sm" }, h(Icon, { name: "download", size: 14 }), "Export CSV") },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 0 } }, DB.audit.map((a, i) =>
        h("div", { key: i, className: "row", style: { gap: 13, padding: "12px 4px", borderBottom: i < DB.audit.length - 1 ? "1px solid var(--line-faint)" : "none" } },
          h("span", { className: "mono dim", style: { fontSize: 11, width: 70, flexShrink: 0 } }, a.date),
          h("span", { className: "mono dim", style: { fontSize: 11, width: 44, flexShrink: 0 } }, a.time),
          h("span", { style: { fontSize: 12.5, color: "var(--tx)" } }, h("b", { className: "hi" }, a.who), " — ", a.action)))));
  }

  


export { SettingsScreen };
