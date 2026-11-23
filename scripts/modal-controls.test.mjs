import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPortal } from "react-dom";
import ts from "typescript";

const source = process.env.DRIVEOS_TEST_WEB_SOURCE_ROOT || fileURLToPath(new URL("../apps/web/src", import.meta.url));
const react = {
  Fragment: "Fragment",
  createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
};
// Load the actual component declarations with lightweight boundary dependencies.
// React DOM's real createPortal still checks and records the destination.
function component(file, name, dependencies = {}) {
  const filename = path.join(source, file), text = fs.readFileSync(filename, "utf8");
  const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Missing actual component ${name}`);
  const javascript = ts.transpileModule(declaration.getText(ast), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
  } }).outputText;
  const context = vm.createContext({ exports: {}, React: react, h: react.createElement, ...dependencies });
  vm.runInContext(javascript, context, { filename });
  return context.exports[name] || context[name];
}
function* nodes(tree) {
  if (!tree || typeof tree !== "object") return;
  if (Array.isArray(tree)) { for (const child of tree) yield* nodes(child); return; }
  yield tree; yield* nodes(tree.props?.children);
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree && typeof tree === "object" ? text(tree.props?.children) : "";
}
const buttons = tree => [...nodes(tree)].filter(node => node.type === "button");

test("shared dialogs escape transformed scrolling pages through a real body portal", () => {
  const body = { nodeType: 1 }, effects = [], listeners = new Map();
  const Modal = component("components/components.tsx", "Modal", {
    React: { ...react, useEffect: effect => effects.push(effect) }, createPortal,
    document: { body }, Icon: "Icon", window: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); },
    },
  });
  let closed = 0;
  const portal = Modal({ title: "Actual approval dialog", children: "Reviewed paths", onClose() { closed++; } });
  assert.equal(portal.$$typeof, Symbol.for("react.portal"));
  assert.equal(portal.containerInfo, body, "The dialog must not remain under the animated list.");
  assert.equal(portal.children.props.className, "modal-scrim");
  assert.match(text(portal.children), /Actual approval dialog.*Reviewed paths/);
  const cleanup = effects[0]();
  listeners.get("keydown")({ key: "Escape" });
  assert.equal(closed, 1);
  cleanup(); assert.equal(listeners.size, 0);
});

test("shared dialogs stay safe during server rendering without a document", () => {
  let portals = 0;
  const Modal = component("components/components.tsx", "Modal", {
    React: { ...react, useEffect() {} }, Icon: "Icon", createPortal() { portals++; },
  });
  assert.equal(Modal({ title: "Server render", onClose() {} }), null);
  assert.equal(portals, 0);
});

test("dashboard primary actions occur once and maintenance shortcuts keep their destinations", () => {
  const dependencies = { DB: { drives: [{}], projects: [] }, Icon: "Icon" };
  for (const name of ["KpiStrip", "HealthCard", "StorageMapCard", "TiersCard", "CloudMiniCard", "OffendersCard", "DupCleanupCard", "ReadyArchiveCard", "TeamCard", "WarningsRail", "ActivityRail"]) dependencies[name] = name;
  const Dashboard = component("screens/screens-dashboard.tsx", "Dashboard", dependencies);
  let scans = 0; const destinations = [];
  const tree = Dashboard({ requestScan: () => scans++, actionBusy: false, go: screen => destinations.push(screen) });
  for (const label of ["Scan & Analyze", "Create Project"]) assert.equal(buttons(tree).filter(node => text(node) === label).length, 1, label);
  buttons(tree).find(node => text(node) === "Scan & Analyze").props.onClick();
  for (const label of ["Create Project", "Review Duplicates", "Clean Up Safely", "Archive Project"]) buttons(tree).find(node => text(node) === label).props.onClick();
  assert.equal(scans, 1); assert.deepEqual(destinations, ["wizard", "duplicates", "cleanup", "archive"]);
});

test("top-bar scan shortcut appears only when it adds a distinct entry point", () => {
  const TopBar = component("app/page.tsx", "TopBar", {
    DB: { drives: [{}] }, Icon: "Icon", Avatar: "Avatar", Fragment: "Fragment",
    useCrumbs: () => [], useAuthActions: () => ({ signOut() {} }),
  });
  let scans = 0;
  for (const screen of ["dashboard", "drives", "drive", "cleanup", "duplicates", "settings"]) {
    const tree = TopBar({ route: { screen, params: {} }, go() {}, requestScan: () => scans++, busy: false });
    const shortcut = buttons(tree).filter(node => node.props.title === "Scan & Analyze all tracked drives");
    assert.equal(shortcut.length, ["dashboard", "drives"].includes(screen) ? 0 : 1, screen);
    if (shortcut.length) shortcut[0].props.onClick();
  }
  assert.equal(scans, 4);
});
