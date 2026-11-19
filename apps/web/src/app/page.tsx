"use client";

import React, { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { DB } from "@/data";
import { Icon } from "@/components/icons";
import { Avatar, useToast } from "@/components/components";
import { useQuery, useMutation, Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@/convexApi";
import { LoginScreen } from "@/screens/screens-login";
import { DownloadScreen } from "@/screens/screens-download";

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
    { id: "drives", label: "Drives", icon: "hdd" },
    { id: "projects", label: "Projects", icon: "folder" },
    { id: "cloud", label: "Cloud", icon: "cloud" },
    { id: "archive", label: "Archive", icon: "archive" },
  ]},
  { group: "Maintenance", items: [
    { id: "duplicates", label: "Duplicates", icon: "copy" },
    { id: "cleanup", label: "Cleanup", icon: "broom" },
    { id: "quarantine", label: "Quarantine", icon: "shield" },
  ]},
  { group: "System", items: [
    { id: "search", label: "Search", icon: "search" },
    { id: "settings", label: "Settings", icon: "settings" },
    { id: "download", label: "Get the app", icon: "download" },
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
  "download",
]);
const DEFAULT_OWNER = "";

function routeFromHash(hash: string) {
  const raw = hash.replace(/^#/, "").trim();
  if (!raw) return { screen: "dashboard", params: {} };
  const [screen, id] = raw.split("/");
  if (!SCREEN_IDS.has(screen)) return { screen: "dashboard", params: {} };
  return { screen, params: id ? { id } : {} };
}

function resolveOwnerId(record: any) {
  // Keep the real owner id (e.g. "steven") even if they're not in the team list,
  // rather than masking it with a mock default owner.
  return record?.owner || record?.ownerId || DEFAULT_OWNER;
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

// Recommendation risk uses the same green/yellow/red scale as duplicates.
function resolveRecommendationRisk(risk?: string) {
  return resolveDuplicateRisk(risk);
}

function recommendationCategory(type?: string) {
  const map: Record<string, string> = {
    delete_cache: "Cache",
    delete_proxies: "Proxies",
    delete_duplicate_stock: "Duplicate stock",
    review_exports: "Review exports",
    archive_abandoned: "Abandoned copies",
    delete_duplicate_downloads: "Duplicate downloads",
    delete_duplicates: "Duplicates",
    remove_duplicate: "Duplicates",
    move_to_warm: "Storage move",
    archive_project: "Archive",
    copy_to_cloud: "Backup",
  };
  return map[type || ""] || "Unknown";
}

function duplicateName(cluster: any) {
  const match = String(cluster?.explanation || "").match(/duplicates? of "([^"]+)"/i);
  return match?.[1] || "Duplicate cluster";
}

interface SidebarProps {
  route: { screen: string; params: any };
  go: (screen: string, params?: any) => void;
  tenantName?: string;
  onlineAgents: number;
  lastSync: string;
}

function Sidebar({ route, go, tenantName, onlineAgents, lastSync }: SidebarProps) {
  const active = ROUTE_NAV[route.screen] || route.screen;
  return (
    <div className="sidebar">
      <div className="brand" onClick={() => go("dashboard")} style={{ cursor: "pointer" }}>
        <div className="brand-mark">
          <Icon name="database" size={17} style={{ color: "#fff" }} stroke={2.4} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="brand-name">DriveOS</div>
          <div className="brand-sub" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {tenantName || "Storage Command"}
          </div>
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
                {it.id === "drives" && DB.drives.some((d) => d.status === "offline") ? <span className="nav-badge warn">{DB.drives.filter((d) => d.status === "offline").length}</span> : null}
                {it.id === "cleanup" && DB.cleanup.length > 0 ? <span className="nav-badge">{DB.cleanup.length}</span> : null}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="sidebar-foot">
        <div className="agent-chip">
          <span className={"agent-dot" + (onlineAgents ? " pulse" : "")} style={{ background: onlineAgents ? "var(--ok)" : "var(--tx-dim)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--tx-hi)" }}>{onlineAgents} agent{onlineAgents === 1 ? "" : "s"} online</div>
            <div style={{ fontSize: 10.5, color: "var(--tx-dim)", fontFamily: "var(--font-mono)" }}>
              Last sync · {lastSync}
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
  requestScan: (driveId?: string) => Promise<void>;
  busy: boolean;
  memberId?: string;
}

function TopBar({ go, route, requestScan, busy, memberId }: TopBarProps) {
  const crumbs = useCrumbs(route);
  const { signOut } = useAuthActions();
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
        <button className="btn ghost icon" title="Notifications" onClick={() => go("settings")}>
          <Icon name="bell" size={17} />
        </button>
        <button className="btn ghost icon" title="Request scans from all agents" disabled={busy || DB.drives.length === 0} onClick={() => void requestScan()}>
          <Icon name="refresh" size={16} />
        </button>
        <div style={{ width: 1, height: 22, background: "var(--line)" }} />
        <Avatar id={memberId} size={30} />
        <button className="btn ghost icon" title="Sign out" onClick={() => void signOut()}>
          <Icon name="external" size={16} />
        </button>
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
    download: [{ label: "Get the app" }],
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
  // Track the hash at the top level so the public "#download" page is reachable
  // without an account (and the dashboard's own routing still works once signed in).
  const [hash, setHash] = useState(
    typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : ""
  );
  useEffect(() => {
    const on = () => setHash(window.location.hash.replace(/^#/, ""));
    window.addEventListener("hashchange", on);
    on();
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const showPublicDownload = hash.split("/")[0] === "download";

  return (
    <>
      <AuthLoading>
        <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)", color: "var(--tx-mut)", fontSize: 13 }}>
          Loading DriveOS…
        </div>
      </AuthLoading>
      <Unauthenticated>
        {showPublicDownload ? <DownloadScreen /> : <LoginScreen />}
      </Unauthenticated>
      <Authenticated>
        <Workspace />
      </Authenticated>
    </>
  );
}

function Workspace() {
  const [route, setRoute] = useState<{ screen: string; params: any }>({ screen: "dashboard", params: {} });
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
  const convexFiles = useQuery(api.files.list, { limit: 200 });
  const convexScans = useQuery(api.scans.list);
  const convexTeam = useQuery(api.admin.listTeamMembers);
  const convexContext = useQuery(api.tenants.currentContext);
  const tenantName = convexContext?.tenant?.name;

  const convexMachines = useQuery(api.drives.listMachines);
  const convexCloud = useQuery(api.cloud.listConnections);
  const convexJobs = useQuery(api.cleanup.listJobs);
  const queueScan = useMutation(api.drives.requestScan);
  const queueAnalysis = useMutation(api.scans.requestAnalysis);
  const [actionBusy, setActionBusy] = useState(false);

  // Always replace live collections, including while loading and on empty
  // responses. A different account must never inherit the previous workspace.
  const palette = ["#9aa9c8", "#8fb0a0", "#c8a98f", "#a98fc8", "#c88f9a", "#8fc8c0"];
  DB.team = (convexTeam || []).map((m: any, i: number) => ({
    ...m, id: m.email, name: m.name || m.email || "Member", role: m.role || "editor",
    initials: (m.name || m.email || "?").split(/\s+/).map((w: string) => w[0]).join("").slice(0, 2).toUpperCase(),
    color: palette[i % palette.length], location: m.location || "", usedTB: 0, drives: 0,
  }));
  DB.teamById = Object.fromEntries(DB.team.map((m) => [m.id, m]));
  DB.files = (convexFiles || []).filter((f: any) => !f.deletedAt).map((f: any) => ({
    ...f, id: f._id, sizeGB: (f.sizeBytes || 0) / 1024 ** 3,
    type: f.classification || "UNKNOWN", risk: resolveDuplicateRisk(f.riskLevel),
    modified: f.modifiedAtFile ? new Date(f.modifiedAtFile).toLocaleString() : "Unknown",
  }));
  DB.drives = (convexDrives || []).map((d: any) => ({
    ...d, id: d._id, name: d.label, owner: resolveOwnerId(d),
    location: d.location || "Unknown location", status: d.status || "unknown", tier: d.tier || "unknown",
    bus: d.filesystem || "Local volume", model: d.mountPath || "Tracked drive",
    capTB: (d.capacityBytes || 0) / 1024 ** 4, usedTB: (d.usedBytes || 0) / 1024 ** 4,
    projects: [...new Set([...DB.files.filter((f) => f.driveId === d._id && f.projectId).map((f) => f.projectId), ...(convexProjects || []).filter((p: any) => p.driveId === d._id).map((p: any) => p._id)])],
    dupTB: d.dupTB || 0, cleanTB: d.cleanTB || 0, scans: d.scans || 0,
    lastSeen: d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "Never",
    risk: resolveRisk(d.usedBytes, d.capacityBytes),
  }));
  DB.driveById = Object.fromEntries(DB.drives.map((d) => [d.id, d]));
  DB.projects = (convexProjects || []).map((p: any) => ({
    ...p, id: p._id, owner: resolveOwnerId(p), status: resolveProjectStatus(p.status),
    tier: p.tier || "unknown", show: p.showName || p.episode || "", template: p.template || "Standard studio",
    client: p.client || "", sizeTB: (p.totalBytes || 0) / 1024 ** 4,
    dupTB: (p.duplicateBytes || 0) / 1024 ** 4, cleanTB: (p.safeCleanupBytes || 0) / 1024 ** 4,
    modified: p.createdAt ? new Date(p.createdAt).toLocaleString() : "Unknown",
    structure: null, archiveReady: null,
    locations: [...new Set([...(p.driveId ? [p.driveId] : []), ...DB.files.filter((f) => f.projectId === p._id && f.driveId).map((f) => f.driveId)])],
  }));
  DB.projectById = Object.fromEntries(DB.projects.map((p) => [p.id, p]));
  DB.duplicates = (convexDuplicates || []).map((d: any) => ({
    ...d, id: d._id, name: d.name || duplicateName(d), type: d.fileType || "unknown",
    sizeGB: (d.totalBytes || 0) / (d.fileCount || d.fileIds?.length || 1) / 1024 ** 3,
    recoverGB: (d.wastedBytes || 0) / 1024 ** 3, copies: d.fileCount || d.fileIds?.length || 0,
    kind: d.type, risk: resolveDuplicateRisk(d.riskLevel), project: d.projectIds?.[0] || "—",
    owner: "", modified: d.updatedAt ? new Date(d.updatedAt).toLocaleString() : "Unknown",
    fingerprint: d.hashKey || "", locations: d.locations || [], rec: d.explanation,
  }));
  const hiddenStatuses = new Set(["approved", "completed", "dismissed", "ignored", "quarantined"]);
  DB.cleanup = (convexRecommendations || []).filter((r: any) => !hiddenStatuses.has(r.status)).map((r: any) => ({
    ...r, id: r._id, cat: recommendationCategory(r.type), risk: resolveRecommendationRisk(r.riskLevel),
    approval: r.riskLevel === "yellow" || r.riskLevel === "red", recoverTB: (r.affectedBytes || 0) / 1024 ** 4,
    files: r.affectedFileIds?.length || 0, affectedFileIds: r.affectedFileIds || [], affectedBytes: r.affectedBytes || 0,
    projects: r.projectId ? [r.projectId] : ["—"], why: r.explanation, action: r.title,
  }));
  DB.quarantine = (convexQuarantine || []).filter((q: any) => ["quarantined", "pending_restore", "pending_purge"].includes(q.status)).map((q: any) => ({
    ...q, id: q._id, name: q.originalPath.replace(/\\/g, "/").split("/").pop() || q.originalPath,
    origin: q.originalPath, qpath: q.quarantinePath, reason: "Quarantined by approved job", by: "DriveOS Agent",
    date: new Date(q.movedAt).toLocaleString(), deadline: new Date(q.rollbackUntil).toLocaleString(),
    sizeGB: q.sizeBytes / 1024 ** 3, verified: false,
  }));
  DB.audit = (convexAudit || []).map((a: any) => ({
    id: a._id, time: new Date(a.createdAt).toLocaleTimeString(), date: new Date(a.createdAt).toLocaleDateString(),
    who: a.actorId || "System", action: a.message, kind: a.action,
  }));
  DB.scans = (convexScans || []).map((scan: any) => ({
    ...scan, id: scan._id, files: scan.filesScanned || 0, bytes: scan.bytesScanned || 0,
    sizeTB: (scan.bytesScanned || 0) / 1024 ** 4, errors: scan.errorsCount || 0,
    when: scan.startedAt ? new Date(scan.startedAt).toLocaleString() : "Unknown",
  }));
  DB.machines = convexMachines || [];
  DB.jobs = convexJobs || [];
  DB.cloudConnections = (convexCloud || []).map((c: any) => ({
    ...c, account: c.accountEmail, usedBytes: c.quotaBytesUsed, capacityBytes: c.quotaBytesTotal,
  }));
  DB.tiers = DB.tiers.map((tier) => ({ ...tier,
    usedTB: DB.drives.filter((d) => d.tier === tier.key).reduce((sum, d) => sum + d.usedTB, 0),
    capTB: DB.drives.filter((d) => d.tier === tier.key).reduce((sum, d) => sum + d.capTB, 0),
  }));
  const dataLoading = [convexDrives, convexProjects, convexDuplicates, convexRecommendations,
    convexQuarantine, convexAudit, convexFiles, convexScans, convexTeam, convexMachines, convexCloud, convexJobs].some((value) => value === undefined);
  const onlineAgents = DB.machines.filter((m) => m.status === "online").length;
  const latestSync = DB.scans.reduce((latest, scan) => Math.max(latest, scan.completedAt || 0), 0);
  const lastSync = latestSync ? new Date(latestSync).toLocaleString() : "Never";

  const requestScan = useCallback(async (driveId?: string) => {
    setActionBusy(true);
    try {
      const result = await queueScan(driveId ? { driveId } : {});
      push(result.queued ? "Queued " + result.queued + " scan request(s). Connected agents run them on their next poll." : "No tracked drives are available for scanning.", "refresh", result.queued ? "ok" : "warn");
    } catch (error: any) { push(error?.data || error?.message || "Could not request a scan", "alert", "risk"); }
    finally { setActionBusy(false); }
  }, [queueScan, push]);
  const requestAnalysis = useCallback(async () => {
    setActionBusy(true);
    try {
      const result = await queueAnalysis({});
      push(result.message || (result.scheduled ? "Analysis queued" : "Analysis is already queued"), "cpu", "ok");
    } catch (error: any) { push(error?.data || error?.message || "Could not request analysis", "alert", "risk"); }
    finally { setActionBusy(false); }
  }, [queueAnalysis, push]);

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
    download: () => <DownloadScreen embedded />,
  };

  const Screen = SCREENS[route.screen];
  const props = { go, toast: push, route, params: route.params, requestScan, requestAnalysis, actionBusy };

  return (
    <div className={"app" + (dense ? " dense" : "")}>
      <Sidebar route={route} go={go} tenantName={tenantName} onlineAgents={onlineAgents} lastSync={lastSync} />
      <div className="main">
        <TopBar go={go} route={route} requestScan={requestScan} busy={actionBusy} memberId={convexContext?.member?.email} />
        <div className="page" ref={pageRef}>
          <div key={route.screen + (route.params.id || "")} className="fade-up">
            {dataLoading ? <div className="page-inner"><div className="card card-pad muted" role="status">Loading workspace…</div></div> : Screen ? <Screen {...props} /> : <Placeholder title={route.screen} />}
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
        indigo: ["#6c7b9b", "#96a4bd", "#52607a"],
        cyan: ["#6c7b9b", "#96a4bd", "#52607a"],
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
