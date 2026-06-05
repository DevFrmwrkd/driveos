/* ============================================================
   DriveOS — App shell, sidebar, topbar, router
   ============================================================ */
const NAV = [
  { group: "Overview", items: [
    { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  ]},
  { group: "Storage", items: [
    { id: "drives", label: "Drives", icon: "hdd", badge: { text: "1", kind: "warn" } },
    { id: "projects", label: "Projects", icon: "folder" },
    { id: "cloud", label: "Cloud", icon: "cloud" },
    { id: "archive", label: "Archive", icon: "archive" },
  ]},
  { group: "Maintenance", items: [
    { id: "duplicates", label: "Duplicates", icon: "copy" },
    { id: "cleanup", label: "Cleanup", icon: "broom", badge: { text: "8.6 TB", kind: "" } },
    { id: "quarantine", label: "Quarantine", icon: "shield" },
  ]},
  { group: "System", items: [
    { id: "search", label: "Search", icon: "search" },
    { id: "settings", label: "Settings", icon: "settings" },
  ]},
];

// route -> nav highlight (detail screens map back to their section)
const ROUTE_NAV = { drive: "drives", project: "projects", wizard: "projects" };

function Sidebar({ route, go }) {
  const active = ROUTE_NAV[route.screen] || route.screen;
  return React.createElement("div", { className: "sidebar" },
    React.createElement("div", { className: "brand", onClick: () => go("dashboard"), style: { cursor: "pointer" } },
      React.createElement("div", { className: "brand-mark" },
        React.createElement(Icon, { name: "database", size: 17, style: { color: "#fff" }, stroke: 2.4 })),
      React.createElement("div", null,
        React.createElement("div", { className: "brand-name" }, "DriveOS"),
        React.createElement("div", { className: "brand-sub" }, "Storage Command"))),
    React.createElement("div", { className: "nav" },
      NAV.map((sec) => React.createElement("div", { key: sec.group },
        React.createElement("div", { className: "nav-section-label" }, sec.group),
        sec.items.map((it) => React.createElement("div", {
          key: it.id, className: `nav-item ${active === it.id ? "active" : ""}`, onClick: () => go(it.id) },
          React.createElement(Icon, { name: it.icon, size: 17 }),
          React.createElement("span", null, it.label),
          it.badge && React.createElement("span", { className: `nav-badge ${it.badge.kind}` }, it.badge.text)))))),
    React.createElement("div", { className: "sidebar-foot" },
      React.createElement("div", { className: "agent-chip" },
        React.createElement("span", { className: "agent-dot pulse" }),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
          React.createElement("div", { style: { fontSize: 12, fontWeight: 600, color: "var(--tx-hi)" } }, "5 agents online"),
          React.createElement("div", { style: { fontSize: 10.5, color: "var(--tx-dim)", fontFamily: "var(--font-mono)" } }, "Last sync · just now")),
        React.createElement(Icon, { name: "activity", size: 14, style: { color: "var(--ok)" } }))));
}

function TopBar({ go, route, onSearchFocus }) {
  const crumbs = useCrumbs(route);
  return React.createElement("div", { className: "topbar" },
    React.createElement("div", { className: "row", style: { gap: 8, minWidth: 0 } },
      crumbs.map((c, i) => React.createElement(React.Fragment, { key: i },
        i > 0 && React.createElement(Icon, { name: "chevR", size: 13, style: { color: "var(--tx-faint)" } }),
        React.createElement("span", { onClick: c.go, style: { fontSize: 13, fontWeight: i === crumbs.length - 1 ? 600 : 500, color: i === crumbs.length - 1 ? "var(--tx-hi)" : "var(--tx-mut)", cursor: c.go ? "pointer" : "default", whiteSpace: "nowrap" } }, c.label)))),
    React.createElement("div", { className: "search-box", onClick: () => go("search"), style: { marginLeft: 24 } },
      React.createElement(Icon, { name: "search", size: 16 }),
      React.createElement("input", { placeholder: "Search files, projects, drives, hashes…", onFocus: () => go("search"), readOnly: true }),
      React.createElement("span", { className: "kbd" }, "⌘K")),
    React.createElement("div", { className: "topbar-actions" },
      React.createElement("button", { className: "btn ghost icon", title: "Notifications" }, React.createElement(Icon, { name: "bell", size: 17 })),
      React.createElement("button", { className: "btn ghost icon", title: "Refresh all agents" }, React.createElement(Icon, { name: "refresh", size: 16 })),
      React.createElement("div", { style: { width: 1, height: 22, background: "var(--line)" } }),
      React.createElement(Avatar, { id: "founder", size: 30 })));
}

function useCrumbs(route) {
  const DB = window.DB;
  const base = [{ label: "DriveOS" }];
  const map = {
    dashboard: [{ label: "Dashboard" }], drives: [{ label: "Drives" }], projects: [{ label: "Projects" }],
    duplicates: [{ label: "Duplicate Center" }], cleanup: [{ label: "Cleanup Recommendations" }],
    quarantine: [{ label: "Quarantine" }], cloud: [{ label: "Cloud Storage" }], archive: [{ label: "Archive" }],
    search: [{ label: "Search" }], settings: [{ label: "Settings" }], wizard: [{ label: "Projects" }, { label: "New Project" }],
  };
  if (route.screen === "drive") return base.concat([{ label: "Drives" }, { label: DB.driveById[route.params.id] ? DB.driveById[route.params.id].name : "Drive" }]);
  if (route.screen === "project") return base.concat([{ label: "Projects" }, { label: DB.projectById[route.params.id] ? DB.projectById[route.params.id].name : "Project" }]);
  return base.concat(map[route.screen] || [{ label: route.screen }]);
}

function Placeholder({ title }) {
  return React.createElement("div", { className: "page-inner" },
    React.createElement("div", { className: "empty", style: { paddingTop: 120 } },
      React.createElement("div", { className: "empty-ico" }, React.createElement(Icon, { name: "cpu", size: 24 })),
      React.createElement("h3", null, title || "Screen"),
      React.createElement("div", { className: "muted" }, "This screen is part of the DriveOS prototype.")));
}

// ---- Router ----
function App() {
  const [route, setRoute] = React.useState({ screen: "dashboard", params: {} });
  const [push, toastNode] = useToast();
  const [dense, setDense] = React.useState(false);
  const pageRef = React.useRef(null);

  const go = React.useCallback((screen, params = {}) => {
    setRoute({ screen, params });
    if (pageRef.current) pageRef.current.scrollTop = 0;
    try { history.replaceState(null, "", "#" + screen + (params.id ? "/" + params.id : "")); } catch (e) {}
  }, []);
  React.useEffect(() => { window.__go = go; }, [go]);

  // Tweaks: accent + density
  useDriveOSTweaks(setDense);

  const SCREENS = {
    dashboard: window.Dashboard, drives: window.DrivesScreen, drive: window.DriveDetail,
    projects: window.ProjectsScreen, project: window.ProjectDetail, duplicates: window.DuplicateCenter,
    cleanup: window.CleanupScreen, quarantine: window.QuarantineScreen, cloud: window.CloudScreen,
    archive: window.ArchiveScreen, search: window.SearchScreen, settings: window.SettingsScreen,
    wizard: window.CreateWizard,
  };
  const Screen = SCREENS[route.screen];
  const props = { go, toast: push, route, params: route.params };

  return React.createElement("div", { className: "app" + (dense ? " dense" : "") },
    React.createElement(Sidebar, { route, go }),
    React.createElement("div", { className: "main" },
      React.createElement(TopBar, { go, route }),
      React.createElement("div", { className: "page", ref: pageRef },
        React.createElement("div", { key: route.screen + (route.params.id || ""), className: "fade-up" },
          Screen ? React.createElement(Screen, props) : React.createElement(Placeholder, { title: route.screen })))),
    toastNode);
}

// ---- Tweaks host wiring (accent + density) ----
function useDriveOSTweaks(setDense) {
  React.useEffect(() => {
    const apply = (t) => {
      const root = document.documentElement;
      const accents = {
        indigo: ["#6366f1", "#818cf8", "#4f46e5"],
        cyan:   ["#22d3ee", "#67e8f9", "#06b6d4"],
        purple: ["#a855f7", "#c084fc", "#9333ea"],
        blue:   ["#3b82f6", "#60a5fa", "#2563eb"],
        emerald:["#10b981", "#34d399", "#059669"],
      };
      if (t.accent && accents[t.accent]) {
        const [a, hi, lo] = accents[t.accent];
        root.style.setProperty("--accent", a);
        root.style.setProperty("--accent-hi", hi);
        root.style.setProperty("--accent-lo", lo);
        root.style.setProperty("--accent-glow", a + "59");
        root.style.setProperty("--accent-soft", a + "24");
        root.style.setProperty("--accent-line", a + "66");
      }
      if (t.density !== undefined) setDense(t.density === "compact");
      if (t.radius !== undefined) {
        const r = { sharp: ["5px","8px","11px","14px"], soft: ["7px","11px","15px","20px"], round: ["10px","16px","22px","28px"] }[t.radius];
        if (r) { root.style.setProperty("--r-sm", r[0]); root.style.setProperty("--r", r[1]); root.style.setProperty("--r-lg", r[2]); root.style.setProperty("--r-xl", r[3]); }
      }
    };
    const onMsg = (e) => {
      const d = e.data;
      if (d && d.type === "tweak:update" && d.values) apply(d.values);
      if (d && d.type === "tweak:init" && d.values) apply(d.values);
    };
    window.addEventListener("message", onMsg);
    try { window.parent.postMessage({ type: "tweak:ready" }, "*"); } catch (e) {}
    return () => window.removeEventListener("message", onMsg);
  }, []);
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
