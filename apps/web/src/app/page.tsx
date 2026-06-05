"use client";

import React, { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { DB } from "@/data";
import { Icon } from "@/components/icons";
import { Avatar, useToast } from "@/components/components";
import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";

// Import all modularized screens
import { Dashboard } from "@/screens/screens-dashboard";
import { DrivesScreen, DriveDetail } from "@/screens/screens-drives";
import { ProjectsScreen, ProjectDetail } from "@/screens/screens-projects";
import { DuplicateCenter } from "@/screens/screens-duplicates";
import { CleanupScreen, QuarantineScreen } from "@/screens/screens-cleanup";
import { CloudScreen } from "@/screens/screens-cloud";
import { ArchiveScreen } from "@/screens/screens-archive";
import { SearchScreen } from "@/screens/screens-search";
import { SettingsScreen } from "@/screens/screens-settings";
import { CreateWizard } from "@/screens/screens-wizard";

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
const ROUTE_NAV: Record<string, string> = { drive: "drives", project: "projects", wizard: "projects" };
const SCREEN_IDS = new Set([
  "dashboard",
  "drives",
  "drive",
  "projects",
  "project",
  "duplicates",
  "cleanup",
  "quarantine",
  "cloud",
  "archive",
  "search",
  "settings",
  "wizard",
]);
const DEFAULT_OWNER = "founder";

function routeFromHash(hash: string) {
  const raw = hash.replace(/^#/, "").trim();
  if (!raw) return { screen: "dashboard", params: {} };
  const [screen, id] = raw.split("/");
  if (!SCREEN_IDS.has(screen)) return { screen: "dashboard", params: {} };
  return { screen, params: id ? { id } : {} };
}

function resolveOwnerId(record: any) {
  const owner = record?.owner || record?.ownerId || DEFAULT_OWNER;
  return (DB as any).teamById?.[owner] ? owner : DEFAULT_OWNER;
}

function resolveProjectStatus(status?: string) {
  if (status === "ready_to_archive") return "ready";
  return status || "active";
}

function resolveRisk(usedBytes = 0, capacityBytes = 1) {
  const ratio = capacityBytes > 0 ? usedBytes / capacityBytes : 0;
  if (ratio >= 0.9) return "high";
  if (ratio >= 0.75) return "medium";
  return "low";
}

function resolveDuplicateRisk(risk?: string) {
  if (risk === "green") return "safe";
  if (risk === "red") return "danger";
  if (risk === "yellow") return "review";
  return risk || "review";
}

function duplicateName(cluster: any) {
  const match = String(cluster?.explanation || "").match(/duplicates? of "([^"]+)"/i);
  return match?.[1] || "Duplicate cluster";
}

interface SidebarProps {
  route: { screen: string; params: any };
  go: (screen: string, params?: any) => void;
}

function Sidebar({ route, go }: SidebarProps) {
  const active = ROUTE_NAV[route.screen] || route.screen;
  return (
    <div className="sidebar">
      <div className="brand" onClick={() => go("dashboard")} style={{ cursor: "pointer" }}>
        <div className="brand-mark">
          <Icon name="database" size={17} style={{ color: "#fff" }} stroke={2.4} />
        </div>
        <div>
          <div className="brand-name">DriveOS</div>
          <div className="brand-sub">Storage Command</div>
        </div>
      </div>
      <div className="nav">
        {NAV.map((sec) => (
          <div key={sec.group}>
            <div className="nav-section-label">{sec.group}</div>
            {sec.items.map((it) => (
              <div
                key={it.id}
                className={`nav-item ${active === it.id ? "active" : ""}`}
                onClick={() => go(it.id)}
              >
                <Icon name={it.icon} size={17} />
                <span>{it.label}</span>
                {it.badge && <span className={`nav-badge ${it.badge.kind}`}>{it.badge.text}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <div className="agent-chip">
          <span className="agent-dot pulse" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tx-hi)" }}>5 agents online</div>
            <div style={{ fontSize: 10.5, color: "var(--tx-dim)", fontFamily: "var(--font-mono)" }}>
              Last sync · just now
            </div>
          </div>
          <Icon name="activity" size={14} style={{ color: "var(--ok)" }} />
        </div>
      </div>
    </div>
  );
}

interface TopBarProps {
  go: (screen: string, params?: any) => void;
  route: { screen: string; params: any };
}

function TopBar({ go, route }: TopBarProps) {
  const crumbs = useCrumbs(route);
  return (
    <div className="topbar">
      <div className="row" style={{ gap: 8, minWidth: 0 }}>
        {crumbs.map((c: any, i: number) => (
          <Fragment key={i}>
            {i > 0 && <Icon name="chevR" size={13} style={{ color: "var(--tx-faint)" }} />}
            <span
              onClick={c.go}
              style={{
                fontSize: 13,
                fontWeight: i === crumbs.length - 1 ? 600 : 500,
                color: i === crumbs.length - 1 ? "var(--tx-hi)" : "var(--tx-mut)",
                cursor: c.go ? "pointer" : "default",
                whiteSpace: "nowrap",
              }}
            >
              {c.label}
            </span>
          </Fragment>
        ))}
      </div>
      <div className="search-box" onClick={() => go("search")} style={{ marginLeft: 24 }}>
        <Icon name="search" size={16} />
        <input placeholder="Search files, projects, drives, hashes…" readOnly />
        <span className="kbd">⌘K</span>
      </div>
      <div className="topbar-actions">
        <button className="btn ghost icon" title="Notifications">
          <Icon name="bell" size={17} />
        </button>
        <button className="btn ghost icon" title="Refresh all agents">
          <Icon name="refresh" size={16} />
        </button>
        <div style={{ width: 1, height: 22, background: "var(--line)" }} />
        <Avatar id="founder" size={30} />
      </div>
    </div>
  );
}

function useCrumbs(route: { screen: string; params: any }) {
  const base = [{ label: "DriveOS" }];
  const map: Record<string, any[]> = {
    dashboard: [{ label: "Dashboard" }],
    drives: [{ label: "Drives" }],
    projects: [{ label: "Projects" }],
    duplicates: [{ label: "Duplicate Center" }],
    cleanup: [{ label: "Cleanup Recommendations" }],
    quarantine: [{ label: "Quarantine" }],
    cloud: [{ label: "Cloud Storage" }],
    archive: [{ label: "Archive" }],
    search: [{ label: "Search" }],
    settings: [{ label: "Settings" }],
    wizard: [{ label: "Projects" }, { label: "New Project" }],
  };

  if (route.screen === "drive") {
    const driveName = DB.driveById[route.params.id]?.name || "Drive";
    return base.concat([{ label: "Drives" }, { label: driveName }]);
  }
  if (route.screen === "project") {
    const projectName = DB.projectById[route.params.id]?.name || "Project";
    return base.concat([{ label: "Projects" }, { label: projectName }]);
  }
  return base.concat(map[route.screen] || [{ label: route.screen }]);
}

function Placeholder({ title }: { title: string }) {
  return (
    <div className="page-inner">
      <div className="empty" style={{ paddingTop: 120 }}>
        <div className="empty-ico">
          <Icon name="cpu" size={24} />
        </div>
        <h3>{title || "Screen"}</h3>
        <div className="muted">This screen is part of the DriveOS prototype.</div>
      </div>
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState<{ screen: string; params: any }>(() =>
    typeof window === "undefined" ? { screen: "dashboard", params: {} } : routeFromHash(window.location.hash)
  );
  const [push, toastNode] = useToast();
  const [dense, setDense] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);

  // Convex real-time data sync layer
  const convexDrives = useQuery(api.drives.list);
  const convexProjects = useQuery(api.projects.list);
  const convexDuplicates = useQuery(api.duplicates.list);
  const convexRecommendations = useQuery(api.recommendations.list);
  const convexQuarantine = useQuery(api.cleanup.listQuarantine);
  const convexAudit = useQuery(api.audit.list);

  // Sync back to our local DB data layer reactively!
  if (convexDrives && convexDrives.length > 0) {
    (DB as any).drives = convexDrives.map((d: any) => ({
      ...d,
      id: d._id,
      name: d.label,
      owner: resolveOwnerId(d),
      location: d.location || "Studio",
      status: d.status || "online",
      tier: d.tier || "hot",
      bus: d.bus || d.filesystem || "Local volume",
      model: d.model || d.mountPath || "Tracked drive",
      capTB: (d.capacityBytes || 0) / (1024 ** 4),
      usedTB: (d.usedBytes || 0) / (1024 ** 4),
      projects: Array.isArray(d.projects) ? d.projects : [],
      dupTB: d.dupTB || 0,
      cleanTB: d.cleanTB || 0,
      scans: d.scans || 0,
      lastSeen: "Just now",
      risk: d.risk || resolveRisk(d.usedBytes, d.capacityBytes),
    }));
    (DB as any).driveById = Object.fromEntries((DB as any).drives.map((d: any) => [d.id, d]));
  }
  if (convexProjects && convexProjects.length > 0) {
    (DB as any).projects = convexProjects.map((p: any) => ({
      ...p,
      id: p._id,
      owner: resolveOwnerId(p),
      status: resolveProjectStatus(p.status),
      tier: p.tier || "hot",
      show: p.showName || p.episode || p.template || "Tracked project",
      template: p.template || "YouTube Show",
      client: p.client || "Studio",
      sizeTB: (p.totalBytes || 0) / (1024 ** 4),
      dupTB: (p.duplicateBytes || 0) / (1024 ** 4),
      cleanTB: (p.safeCleanupBytes || 0) / (1024 ** 4),
      modified: "Just now",
      structure: p.storageHealthScore || 100,
      archiveReady: p.status === "archived" ? 100 : p.status === "ready_to_archive" || p.status === "ready" ? 80 : 30,
      locations: Array.isArray(p.locations) && p.locations.length > 0 ? p.locations : [],
    }));
    (DB as any).projectById = Object.fromEntries((DB as any).projects.map((p: any) => [p.id, p]));
  }
  if (convexDuplicates && convexDuplicates.length > 0) {
    (DB as any).duplicates = convexDuplicates.map((d: any) => ({
      ...d,
      id: d._id,
      name: d.name || duplicateName(d),
      type: d.fileType || "unknown",
      sizeGB: (d.totalBytes || 0) / (1024 ** 3),
      recoverGB: (d.wastedBytes || 0) / (1024 ** 3),
      copies: d.fileCount || d.fileIds?.length || 0,
      kind: d.type,
      risk: resolveDuplicateRisk(d.riskLevel),
      project: d.projectIds?.[0] || "—",
      owner: DEFAULT_OWNER,
      modified: "Just now",
      fingerprint: d.hashKey || "",
      locations: Array.isArray(d.locations) ? d.locations : [],
      rec: d.explanation,
    }));
  }
  if (convexRecommendations && convexRecommendations.length > 0) {
    (DB as any).cleanup = convexRecommendations.map((r: any) => ({
      ...r,
      id: r._id,
      cat: r.type === "delete_cache" ? "Cache" : "Proxies",
      recoverTB: r.affectedBytes / (1024 ** 4),
      files: r.affectedFileIds.length,
      projects: ["show-x"],
      why: r.explanation,
      action: r.title,
    }));
  }
  if (convexQuarantine && convexQuarantine.length > 0) {
    (DB as any).quarantine = convexQuarantine.map((q: any) => ({
      ...q,
      id: q._id,
      name: q.originalPath.split('/').pop() || "",
      origin: q.originalPath,
      qpath: q.quarantinePath,
      reason: "Quarantined via recommendation",
      by: "DriveOS Agent",
      date: "Just now",
      deadline: "30 days",
      sizeGB: q.sizeBytes / (1024 ** 3),
      verified: true,
    }));
  }
  if (convexAudit && convexAudit.length > 0) {
    (DB as any).audit = convexAudit.map((a: any) => ({
      time: new Date(a.createdAt).toLocaleTimeString(),
      date: new Date(a.createdAt).toLocaleDateString(),
      who: a.actorId || "System",
      action: a.message,
      kind: a.action,
    }));
  }

  const go = useCallback((screen: string, params = {}) => {
    setRoute({ screen, params });
    if (pageRef.current) pageRef.current.scrollTop = 0;
    try {
      window.location.hash = screen + (params && (params as any).id ? "/" + (params as any).id : "");
    } catch (e) {}
  }, []);

  useEffect(() => {
    (window as any).__go = go;
  }, [go]);

  useEffect(() => {
    const syncRouteFromHash = () => {
      const next = routeFromHash(window.location.hash);
      setRoute((current) => {
        const currentId = current.params?.id || "";
        const nextId = next.params?.id || "";
        return current.screen === next.screen && currentId === nextId ? current : next;
      });
      if (pageRef.current) pageRef.current.scrollTop = 0;
    };

    syncRouteFromHash();
    window.addEventListener("hashchange", syncRouteFromHash);
    return () => window.removeEventListener("hashchange", syncRouteFromHash);
  }, []);

  // Tweaks: accent + density
  useDriveOSTweaks(setDense);

  const SCREENS: Record<string, React.ComponentType<any>> = {
    dashboard: Dashboard,
    drives: DrivesScreen,
    drive: DriveDetail,
    projects: ProjectsScreen,
    project: ProjectDetail,
    duplicates: DuplicateCenter,
    cleanup: CleanupScreen,
    quarantine: QuarantineScreen,
    cloud: CloudScreen,
    archive: ArchiveScreen,
    search: SearchScreen,
    settings: SettingsScreen,
    wizard: CreateWizard,
  };

  const Screen = SCREENS[route.screen];
  const props = { go, toast: push, route, params: route.params };

  return (
    <div className={"app" + (dense ? " dense" : "")}>
      <Sidebar route={route} go={go} />
      <div className="main">
        <TopBar go={go} route={route} />
        <div className="page" ref={pageRef}>
          <div key={route.screen + (route.params.id || "")} className="fade-up">
            {Screen ? <Screen {...props} /> : <Placeholder title={route.screen} />}
          </div>
        </div>
      </div>
      {toastNode}
    </div>
  );
}

function useDriveOSTweaks(setDense: (dense: boolean) => void) {
  useEffect(() => {
    const apply = (t: any) => {
      const root = document.documentElement;
      const accents: Record<string, string[]> = {
        indigo: ["#6f7fa8", "#9aa9c8", "#52627f"],
        cyan: ["#6f7fa8", "#9aa9c8", "#52627f"],
        purple: ["#756f91", "#9a94b4", "#5d5875"],
        blue: ["#667f9e", "#8fa6bf", "#4f637d"],
        emerald: ["#728b78", "#9aac9d", "#596e5f"],
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
        const r = {
          sharp: ["5px", "8px", "11px", "14px"],
          soft: ["7px", "11px", "15px", "20px"],
          round: ["10px", "16px", "22px", "28px"],
        }[t.radius as "sharp" | "soft" | "round"];
        if (r) {
          root.style.setProperty("--r-sm", r[0]);
          root.style.setProperty("--r", r[1]);
          root.style.setProperty("--r-lg", r[2]);
          root.style.setProperty("--r-xl", r[3]);
        }
      }
    };
    const onMsg = (e: MessageEvent) => {
      const d = e.data;
      if (d && d.type === "tweak:update" && d.values) apply(d.values);
      if (d && d.type === "tweak:init" && d.values) apply(d.values);
    };
    window.addEventListener("message", onMsg);
    try {
      window.parent.postMessage({ type: "tweak:ready" }, "*");
    } catch (e) {}
    return () => window.removeEventListener("message", onMsg);
  }, [setDense]);
}
