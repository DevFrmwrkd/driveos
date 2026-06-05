import React from "react";
import { Icon } from "./icons";
import { DB } from "../data";

// ---- formatting helpers ----
export const fmtTB = (tb: number): string => tb >= 1 ? `${(+tb).toFixed(tb < 10 ? 2 : 1)} TB` : `${Math.round(tb * 1000)} GB`;
export const fmtGB = (gb: number): string => gb >= 1000 ? `${(gb / 1000).toFixed(2)} TB` : `${gb < 10 ? (+gb).toFixed(1) : Math.round(gb)} GB`;
export const pct = (a: number, b: number): number => b ? Math.round((a / b) * 100) : 0;
export const fmtNum = (n: number): string => n.toLocaleString("en-US");

export const STATUS_META: Record<string, { label: string; cls: string; dot: string }> = {
  online:  { label: "Online",   cls: "ok",   dot: "var(--ok)" },
  offline: { label: "Offline",  cls: "",     dot: "var(--tx-dim)" },
  uninit:  { label: "Not initialized", cls: "warn", dot: "var(--warn)" },
  cloud:   { label: "Connected", cls: "cloud", dot: "var(--cloud)" },
};

export const RISK_META: Record<string, { label: string; cls: string }> = {
  high:   { label: "High risk",   cls: "risk" },
  medium: { label: "Medium",      cls: "warn" },
  low:    { label: "Low risk",    cls: "ok" },
  none:   { label: "—",           cls: "" },
  safe:   { label: "Safe",        cls: "ok" },
  review: { label: "Review",      cls: "warn" },
  danger: { label: "Do not delete", cls: "risk" },
};

export const PROJ_STATUS: Record<string, { label: string; cls: string }> = {
  active:    { label: "Active",          cls: "accent" },
  review:    { label: "In Review",       cls: "warn" },
  delivered: { label: "Delivered",       cls: "cloud" },
  ready:     { label: "Ready to Archive",cls: "auto" },
  archived:  { label: "Archived",        cls: "" },
};

export const TIER_META: Record<string, { label: string; color: string }> = {
  hot:   { label: "Hot",   color: "var(--risk)" },
  warm:  { label: "Warm",  color: "var(--warn)" },
  cloud: { label: "Cloud", color: "var(--cloud)" },
  cold:  { label: "Cold",  color: "var(--auto)" },
};

// ---- Avatar ----
interface AvatarProps {
  id?: string;
  size?: number;
  member?: any;
}

export function Avatar({ id, size = 26, member }: AvatarProps) {
  const m = member || (DB && DB.teamById[id || ""]);
  if (!m) return null;
  return React.createElement("div", {
    title: m.name,
    style: { width: size, height: size, borderRadius: 8, flexShrink: 0,
      background: `linear-gradient(135deg, ${m.color}, ${m.color}99)`,
      color: "#0a0b10", fontWeight: 700, fontSize: size * 0.38, display: "grid", placeItems: "center",
      fontFamily: "var(--font-sans)", boxShadow: "0 0 0 1px rgba(255,255,255,0.1) inset" },
  }, m.initials);
}

// ---- Badge ----
interface BadgeProps {
  children?: React.ReactNode;
  kind?: string;
  icon?: string;
  square?: boolean;
  style?: React.CSSProperties;
}

export function Badge({ children, kind = "", icon, square, style }: BadgeProps) {
  return React.createElement("span", { className: `badge ${kind} ${square ? "sq" : ""}`, style },
    icon && React.createElement(Icon, { name: icon, size: 11, stroke: 2.4 }),
    children
  );
}

export function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] || STATUS_META.offline;
  return React.createElement("span", { className: `badge ${m.cls}` },
    React.createElement("span", { className: "dot", style: { background: m.dot } }), m.label);
}

export function RiskBadge({ risk }: { risk: string }) {
  const m = RISK_META[risk] || RISK_META.none;
  return React.createElement("span", { className: `badge ${m.cls}` }, m.label);
}

// ---- Progress bar ----
interface BarProps {
  value: number;
  max?: number;
  kind?: string;
  height?: number;
}

export function Bar({ value, max = 100, kind = "", height = 7 }: BarProps) {
  const p = Math.min(100, pct(value, max));
  return React.createElement("div", { className: "bar-track", style: { height } },
    React.createElement("div", { className: `bar-fill ${kind}`, style: { width: p + "%" } }));
}

export function tierKind(p: number): string { return p >= 90 ? "risk" : p >= 75 ? "warn" : "ok"; }

// ---- Multi-segment bar ----
interface MultiBarProps {
  segments: Array<{ label: string; value: number; color: string }>;
  height?: number;
}

export function MultiBar({ segments, height = 9 }: MultiBarProps) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  return React.createElement("div", { className: "bar-multi", style: { height } },
    segments.map((s, i) => React.createElement("span", {
      key: i, title: `${s.label}: ${fmtTB(s.value)}`,
      style: { width: (s.value / total * 100) + "%", background: s.color } })));
}

// ---- Donut chart ----
interface DonutProps {
  data: Array<{ label: string; value: number; color: string }>;
  size?: number;
  thickness?: number;
  children?: React.ReactNode;
  gap?: number;
}

export function Donut({ data, size = 168, thickness = 22, children, gap = 2 }: DonutProps) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  const r = (size - thickness) / 2;
  const C = 2 * Math.PI * r;
  let offset = 0;
  return React.createElement("div", { className: "donut-wrap", style: { width: size, height: size } },
    React.createElement("svg", { width: size, height: size, style: { transform: "rotate(-90deg)" } },
      React.createElement("circle", { cx: size / 2, cy: size / 2, r, fill: "none",
        stroke: "rgba(255,255,255,0.05)", strokeWidth: thickness }),
      data.map((d, i) => {
        const len = (d.value / total) * C;
        const seg = React.createElement("circle", {
          key: i, cx: size / 2, cy: size / 2, r, fill: "none",
          stroke: d.color, strokeWidth: thickness,
          strokeDasharray: `${Math.max(0, len - gap)} ${C - Math.max(0, len - gap)}`,
          strokeDashoffset: -offset, strokeLinecap: "butt",
          style: { transition: "stroke-dasharray .6s ease" } });
        offset += len;
        return seg;
      })
    ),
    children && React.createElement("div", { className: "donut-center" }, children)
  );
}

// ---- Health ring (gauge w/ color by score) ----
interface HealthRingProps {
  score: number;
  size?: number;
  thickness?: number;
}

export function HealthRing({ score, size = 150, thickness = 13 }: HealthRingProps) {
  const r = (size - thickness) / 2;
  const C = 2 * Math.PI * r;
  const color = score >= 80 ? "var(--ok)" : score >= 60 ? "var(--warn)" : "var(--risk)";
  return React.createElement("div", { className: "donut-wrap", style: { width: size, height: size } },
    React.createElement("svg", { width: size, height: size, style: { transform: "rotate(-90deg)" } },
      React.createElement("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: "rgba(255,255,255,0.06)", strokeWidth: thickness }),
      React.createElement("circle", { cx: size / 2, cy: size / 2, r, fill: "none", stroke: color, strokeWidth: thickness,
        strokeLinecap: "round", strokeDasharray: `${C * score / 100} ${C}`, style: { transition: "stroke-dasharray .8s cubic-bezier(.2,.7,.3,1)", filter: `drop-shadow(0 0 6px ${color})` } })),
    React.createElement("div", { className: "donut-center" },
      React.createElement("div", { className: "stat-num", style: { fontSize: size * 0.3, color } }, score),
      React.createElement("div", { style: { fontSize: 10.5, color: "var(--tx-dim)", fontFamily: "var(--font-mono)", letterSpacing: ".08em", marginTop: -2 } }, "/ 100")));
}

// ---- Sparkline ----
interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
}

export function Sparkline({ data, width = 120, height = 34, color = "var(--accent-hi)", fill = true }: SparklineProps) {
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => [ (i / (data.length - 1)) * width, height - ((v - min) / range) * (height - 6) - 3 ]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = line + ` L${width} ${height} L0 ${height} Z`;
  const gid = "sg" + React.useId().replace(/:/g, "");
  return React.createElement("svg", { className: "spark", width, height, viewBox: `0 0 ${width} ${height}` },
    fill && React.createElement("defs", null, React.createElement("linearGradient", { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 },
      React.createElement("stop", { offset: "0%", stopColor: color, stopOpacity: 0.3 }),
      React.createElement("stop", { offset: "100%", stopColor: color, stopOpacity: 0 }))),
    fill && React.createElement("path", { d: area, fill: `url(#${gid})` }),
    React.createElement("path", { d: line, fill: "none", stroke: color, strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }));
}

// ---- Mini vertical bars ----
interface MiniBarsProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}

export function MiniBars({ data, width = 120, height = 34, color = "var(--accent)" }: MiniBarsProps) {
  const max = Math.max(...data) || 1;
  const bw = width / data.length;
  return React.createElement("svg", { width, height, viewBox: `0 0 ${width} ${height}` },
    data.map((v, i) => React.createElement("rect", {
      key: i, x: i * bw + 1, y: height - (v / max) * height, width: bw - 2, height: (v / max) * height,
      rx: 1.5, fill: color, opacity: 0.35 + 0.65 * (v / max) })));
}

// ---- Treemap (single row, weighted) ----
interface TreemapProps {
  data: Array<{ label: string; value: number; color: string }>;
  height?: number;
  onClick?: (d: any) => void;
}

export function Treemap({ data, height = 150, onClick }: TreemapProps) {
  const total = data.reduce((s, d) => s + d.value, 0) || 1;
  return React.createElement("div", { className: "treemap", style: { height } },
    data.map((d, i) => {
      const w = (d.value / total * 100);
      const big = w > 12;
      return React.createElement("div", {
        key: i, className: "treemap-cell", onClick: () => onClick && onClick(d),
        style: { flex: `${d.value} 1 0`, minWidth: 40,
          background: `linear-gradient(160deg, ${alphaColor(d.color, 14)}, ${alphaColor(d.color, 5)})`,
          borderColor: alphaColor(d.color, 18) } },
        React.createElement("div", { style: { fontWeight: 700, fontSize: big ? 13 : 11, color: "var(--tx-hi)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, d.label),
        big && React.createElement("div", { className: "mono", style: { fontSize: 11, color: "var(--tx-mut)", marginTop: 2 } }, fmtTB(d.value)),
        React.createElement("div", { style: { position: "absolute", top: 8, right: 9, width: 7, height: 7, borderRadius: 2, background: d.color } }));
    }));
}

// ---- Stat card (KPI) ----
interface StatCardProps {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  icon?: string;
  kind?: string;
  spark?: React.ReactNode;
  trend?: string;
  accent?: string;
}

export function StatCard({ label, value, unit, sub, icon, kind = "", spark, trend, accent }: StatCardProps) {
  return React.createElement("div", { className: "card card-pad fade-up", style: { display: "flex", flexDirection: "column", gap: 10 } },
    React.createElement("div", { className: "spread" },
      React.createElement("div", { className: "eyebrow" }, label),
      icon && React.createElement("div", { style: { color: accent || "var(--tx-dim)" } }, React.createElement(Icon, { name: icon, size: 16 }))),
    React.createElement("div", { className: "row", style: { alignItems: "baseline", gap: 6 } },
      React.createElement("span", { className: "stat-num", style: { fontSize: 30 } }, value),
      unit && React.createElement("span", { style: { fontSize: 14, color: "var(--tx-mut)", fontWeight: 600 } }, unit)),
    spark && React.createElement("div", null, spark),
    sub && React.createElement("div", { style: { fontSize: 12, color: "var(--tx-mut)" } }, sub));
}

// ---- Checkbox ----
interface CheckProps {
  on: boolean;
  onChange?: (val: boolean) => void;
  size?: number;
}

export function Check({ on, onChange, size = 18 }: CheckProps) {
  return React.createElement("div", { className: `chk ${on ? "on" : ""}`, onClick: (e) => { e.stopPropagation(); onChange && onChange(!on); }, style: { width: size, height: size } },
    React.createElement(Icon, { name: "check", size: size * 0.66, stroke: 3, style: { color: "#fff" } }));
}

// ---- Segmented control ----
interface SegProps {
  options: Array<{ label: string; value: any }>;
  value: any;
  onChange: (val: any) => void;
}

export function Seg({ options, value, onChange }: SegProps) {
  return React.createElement("div", { className: "seg" },
    options.map((o) => React.createElement("button", {
      key: o.value, className: o.value === value ? "on" : "", onClick: () => onChange(o.value) }, o.label)));
}

// ---- File-type icon dot ----
export const FT_ICON: Record<string, string> = { raw: "film", proxy: "layers", cache: "cpu", export: "download", stock: "globe", audio: "audio", gfx: "image", unknown: "box" };

export function FileTypePill({ type }: { type: string }) {
  const ft = (DB.fileTypes.find((f: any) => f.key === type)) || { color: "var(--ft-unknown)", label: type };
  return React.createElement("span", { className: "tag" },
    React.createElement("span", { style: { width: 7, height: 7, borderRadius: 2, background: ft.color } }),
    ft.label);
}

// ---- Modal shell ----
interface ModalProps {
  title: string;
  subtitle?: string;
  icon?: string;
  iconKind?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}

export function Modal({ title, subtitle, icon, iconKind = "accent", onClose, children, footer, width = 720 }: ModalProps) {
  React.useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return React.createElement("div", { className: "modal-scrim", onMouseDown: (e) => e.target === e.currentTarget && onClose() },
    React.createElement("div", { className: "modal", style: { maxWidth: width } },
      React.createElement("div", { className: "modal-head" },
        icon && React.createElement("div", { style: { width: 38, height: 38, borderRadius: 10, flexShrink: 0, display: "grid", placeItems: "center",
          background: `var(--${iconKind === "accent" ? "accent" : iconKind}-soft)`, color: iconKind === "accent" ? "var(--accent-hi)" : `var(--${iconKind})`,
          border: `1px solid var(--${iconKind === "accent" ? "accent" : iconKind}-line)` } }, React.createElement(Icon, { name: icon, size: 19 })),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
          React.createElement("h3", { style: { fontSize: 17 } }, title),
          subtitle && React.createElement("div", { className: "muted", style: { fontSize: 13, marginTop: 3 } }, subtitle)),
        React.createElement("button", { className: "btn ghost icon sm", onClick: onClose }, React.createElement(Icon, { name: "x", size: 17 }))),
      React.createElement("div", { className: "modal-body" }, children),
      footer && React.createElement("div", { className: "modal-foot" }, footer)));
}

// ---- Section header ----
interface SectionTitleProps {
  children: React.ReactNode;
  icon?: string;
  right?: React.ReactNode;
}

export function SectionTitle({ children, icon, right }: SectionTitleProps) {
  return React.createElement("div", { className: "spread", style: { marginBottom: 14 } },
    React.createElement("div", { className: "row", style: { gap: 9 } },
      icon && React.createElement("div", { style: { color: "var(--tx-mut)" } }, React.createElement(Icon, { name: icon, size: 16 })),
      React.createElement("h3", { style: { fontSize: 15 } }, children)),
    right);
}

// ---- Legend ----
interface LegendProps {
  data: Array<{ label: string; value: number; color: string }>;
  fmt?: (n: number) => string;
}

export function Legend({ data, fmt = fmtTB }: LegendProps) {
  return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 9 } },
    data.map((d, i) => React.createElement("div", { key: i, className: "spread", style: { fontSize: 12.5 } },
      React.createElement("div", { className: "row", style: { gap: 8 } },
        React.createElement("span", { style: { width: 9, height: 9, borderRadius: 3, background: d.color, flexShrink: 0 } }),
        React.createElement("span", { style: { color: "var(--tx)" } }, d.label)),
      React.createElement("span", { className: "mono", style: { color: "var(--tx-mut)" } }, fmt(d.value)))));
}

// ---- Page head ----
interface PageHeadProps {
  eyebrow?: string;
  title: string;
  desc?: string;
  actions?: React.ReactNode;
}

export function PageHead({ eyebrow, title, desc, actions }: PageHeadProps) {
  return React.createElement("div", { className: "page-head" },
    React.createElement("div", null,
      eyebrow && React.createElement("div", { className: "eyebrow", style: { marginBottom: 6 } }, eyebrow),
      React.createElement("div", { className: "page-title" }, title),
      desc && React.createElement("div", { className: "page-desc" }, desc)),
    actions && React.createElement("div", { className: "page-head-actions" }, actions));
}

// ---- Toast host ----
export function useToast(): [(msg: string, icon?: string, kind?: string) => void, React.ReactElement] {
  const [toasts, setToasts] = React.useState<any[]>([]);
  const push = React.useCallback((msg: string, icon = "checkCircle", kind = "ok") => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg, icon, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);
  const node = React.createElement("div", { className: "toast-wrap" },
    toasts.map((t) => React.createElement("div", { key: t.id, className: "toast" },
      React.createElement("span", { style: { color: `var(--${t.kind})` } }, React.createElement(Icon, { name: t.icon, size: 18 })),
      t.msg)));
  return [push, node];
}

// ---- Card shell container helper ----
export function cardShell(
  title: string,
  icon?: string,
  iconColor?: string,
  right?: React.ReactNode,
  body?: React.ReactNode,
  extraClass?: string
) {
  return React.createElement(
    "div",
    { className: "card fade-up " + (extraClass || "") },
    React.createElement(
      "div",
      { className: "card-head" },
      icon && React.createElement(Icon, { name: icon, size: 16, style: { color: iconColor || "var(--tx-mut)" } }),
      React.createElement("div", { className: "card-title" }, title),
      right && React.createElement("div", { className: "right" }, right)
    ),
    body
  );
}

// ---- Computed variable helper ----
export function getVar(v: any): string {
  return v;
}

function alphaColor(color: string, opacity: number): string {
  if (color.startsWith("var(")) return `color-mix(in srgb, ${color} ${opacity}%, transparent)`;
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    const alpha = Math.round((opacity / 100) * 255).toString(16).padStart(2, "0");
    return `${color}${alpha}`;
  }
  return color;
}
