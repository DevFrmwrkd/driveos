import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const source = process.env.DRIVEOS_TEST_WEB_SOURCE_ROOT || fileURLToPath(new URL("../apps/web/src", import.meta.url));

function runtime(queries = {}) {
  const calls = [], modules = new Map(), banks = new Map();
  let bank, cursor;
  const react = {
    Fragment: "fragment",
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.flat(Infinity) } }; },
    useState(initial) {
      const state = bank, index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
    },
  };
  function reference(name = "") {
    return new Proxy(function () {}, { get(_target, key) {
      if (key === Symbol.toPrimitive) return () => name;
      return reference(name ? name + "." + String(key) : String(key));
    } });
  }
  const api = reference();
  const db = { jobs: [], driveById: {} };
  function load(relative) {
    const filename = path.join(source, relative);
    if (modules.has(filename)) return modules.get(filename);
    const exports = {};
    const context = vm.createContext({
      exports, document: { body: {} },
      require(name) {
        if (name === "react") return react;
        if (name === "react-dom") return { createPortal: node => node };
        if (name === "convex/react") return {
          useQuery: ref => queries[String(ref)],
          useMutation: ref => async args => {
            calls.push({ name: String(ref), args: JSON.parse(JSON.stringify(args)) });
            return { queued: args.fileIds?.length || 1, jobIds: ["job"] };
          },
        };
        if (name === "@/convexApi") return { api };
        if (name === "@/data") return { DB: db };
        if (name === "@/lib/download") return { formatBytes: bytes => bytes + " bytes", downloadText() { throw Error("Unexpected download."); } };
        if (name === "@/lib/scan-analysis") return load("lib/scan-analysis.ts").exports;
        if (name === "@/components/duplicate-quarantine-confirmation") return load("components/duplicate-quarantine-confirmation.tsx").exports;
        if (name.startsWith("@/components")) return { Icon: "Icon", Badge: "Badge", PageHead: "PageHead", Seg: "Seg", Modal: "Modal" };
        throw Error("Unexpected web dependency: " + name);
      },
    });
    const javascript = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.React, esModuleInterop: true },
    }).outputText;
    vm.runInContext(javascript, context, { filename });
    const result = { exports, context };
    modules.set(filename, result);
    return result;
  }
  function render(component, props = {}, key = component) {
    if (!banks.has(key)) banks.set(key, []);
    bank = banks.get(key); cursor = 0;
    return component(props);
  }
  return { load, render, calls, db };
}

function* nodes(tree) {
  if (!tree || typeof tree !== "object") return;
  if (Array.isArray(tree)) { for (const child of tree) yield* nodes(child); return; }
  yield tree;
  yield* nodes(tree.props?.children);
  yield* nodes(tree.props?.footer);
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree && typeof tree === "object" ? text(tree.props?.children) : "";
}
function button(tree, label) {
  const found = [...nodes(tree)].find(node => node.type === "button" && text(node).trim() === label);
  assert.ok(found, "Missing button: " + label);
  return found;
}
function component(tree, name) {
  const found = [...nodes(tree)].find(node => node.type?.name === name);
  assert.ok(found, "Missing component: " + name);
  return found;
}
function checkbox(tree) {
  const found = [...nodes(tree)].find(node => node.type === "input" && node.props.type === "checkbox");
  assert.ok(found, "Missing approval checkbox.");
  return found;
}

test("individual Cleanup has one review action and still requires approval before a job is queued", async () => {
  const rec = { _id: "rec", type: "delete_cache", title: "Synthetic cache", explanation: "Regenerable fixture", riskLevel: "green", status: "open", affectedFileIds: ["file"], affectedBytes: 2048 };
  const ui = runtime({
    "recommendations.list": [rec], "settings.get": { retentionDays: 14 }, "tenants.currentContext": { member: { role: "admin" } },
    "cleanup.previewFiles": [{ _id: "file", path: "/fixture/cache.bin", classification: "CACHE", sizeBytes: 2048, protected: false }],
  });
  const { exports } = ui.load("screens/screens-cleanup.tsx");
  const props = { go() {}, toast() {} };
  let tree = ui.render(exports.CleanupScreen, props);
  assert.equal(ui.calls.length, 0);
  assert.equal([...nodes(tree)].filter(node => node.type === "button" && text(node) === "Review & quarantine").length, 1);
  assert.equal([...nodes(tree)].filter(node => node.type === "button" && ["Preview", "Quarantine"].includes(text(node))).length, 0);
  button(tree, "Review & quarantine").props.onClick();
  assert.equal(ui.calls.length, 0, "Opening quarantine must not approve a physical move.");
  tree = ui.render(exports.CleanupScreen, props);
  let modal = component(tree, "CleanupPreviewModal");
  let preview = ui.render(modal.type, modal.props);
  assert.match(text(preview), /fixture\/cache.bin/);
  assert.equal(button(preview, "Move to Quarantine").props.disabled, true);
  button(preview, "Cancel").props.onClick();
  assert.equal(ui.calls.length, 0);
  tree = ui.render(exports.CleanupScreen, props);
  assert.equal([...nodes(tree)].some(node => node.type?.name === "CleanupPreviewModal"), false);
  button(tree, "Review & quarantine").props.onClick();
  modal = component(ui.render(exports.CleanupScreen, props), "CleanupPreviewModal");
  preview = ui.render(modal.type, modal.props);
  checkbox(preview).props.onChange({ target: { checked: true } });
  preview = ui.render(modal.type, modal.props);
  assert.equal(button(preview, "Move to Quarantine").props.disabled, false);
  button(preview, "Move to Quarantine").props.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(ui.calls, [{ name: "cleanup.queueRecommendations", args: { recommendationIds: ["rec"] } }]);
});

test("read-only recommendations retain Preview without a duplicate cleanup action", () => {
  const rec = { _id: "storage-rec", type: "archive_project", title: "Archive review", riskLevel: "yellow", status: "open", affectedFileIds: ["file"], affectedBytes: 2048 };
  const ui = runtime({ "recommendations.list": [rec], "settings.get": { retentionDays: 14 }, "cleanup.previewFiles": [{ _id: "file", path: "/fixture/original.mov", sizeBytes: 2048 }] });
  const { exports } = ui.load("screens/screens-cleanup.tsx");
  const props = { go() {}, toast() {} };
  const tree = ui.render(exports.CleanupScreen, props);
  assert.equal([...nodes(tree)].filter(node => node.type === "button" && text(node) === "Preview").length, 1);
  assert.equal([...nodes(tree)].filter(node => node.type === "button" && text(node) === "Review & quarantine").length, 0);
  button(tree, "Preview").props.onClick();
  const modal = component(ui.render(exports.CleanupScreen, props), "CleanupPreviewModal");
  const preview = ui.render(modal.type, modal.props);
  assert.equal(button(preview, "Move to Quarantine").props.disabled, true);
  button(preview, "Cancel").props.onClick();
  assert.equal(ui.calls.length, 0);
});

test("duplicate quarantine confirms selected paths and queues only the approved snapshot", async () => {
  const ui = runtime();
  const { context } = ui.load("screens/screens-duplicates.tsx");
  const selected = { fileId: "remove", path: "/fixture/redundant.mov", sizeBytes: 2048, role: "quarantine", tag: "Redundant" };
  const cluster = { id: "cluster", kind: "exact", risk: "safe", name: "Fixture", copies: 2, sizeGB: 0, recommendedKeepFileId: "keep", locations: [
    { fileId: "keep", path: "/fixture/keep.mov", sizeBytes: 2048, role: "keep", tag: "Keep" }, selected,
  ] };
  const props = { cluster, go() {}, toast() {} };
  let tree = ui.render(context.ClusterCard, props);
  assert.equal(ui.calls.length, 0);
  button(tree, "Quarantine 1").props.onClick();
  assert.equal(ui.calls.length, 0, "The first click opens a review, not a job.");
  tree = ui.render(context.ClusterCard, props);
  let modal = component(tree, "DuplicateQuarantineConfirmation");
  let review = ui.render(modal.type, modal.props);
  assert.match(text(review), /fixture\/redundant.mov/);
  assert.match(text(review), /Keep copy: \/fixture\/keep.mov/);
  assert.equal(button(review, "Move to Quarantine").props.disabled, true);
  button(review, "Cancel").props.onClick();
  assert.equal(ui.calls.length, 0);
  tree = ui.render(context.ClusterCard, props);
  button(tree, "Quarantine 1").props.onClick();
  // Catalog updates behind the review must not silently change the approval.
  selected.fileId = "later-file"; selected.path = "/fixture/later.mov";
  tree = ui.render(context.ClusterCard, props);
  modal = component(tree, "DuplicateQuarantineConfirmation");
  review = ui.render(modal.type, modal.props);
  assert.match(text(review), /fixture\/redundant.mov/);
  assert.doesNotMatch(text(review), /fixture\/later.mov/);
  checkbox(review).props.onChange({ target: { checked: true } });
  review = ui.render(modal.type, modal.props);
  assert.equal(button(review, "Move to Quarantine").props.disabled, false);
  button(review, "Move to Quarantine").props.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(ui.calls, [{ name: "cleanup.queueQuarantine", args: { fileIds: ["remove"], clusterId: "cluster" } }]);
});

test("permanent-delete confirmation remains disabled until DELETE is typed", () => {
  const ui = runtime();
  const { context } = ui.load("screens/screens-cleanup.tsx");
  let approved = 0;
  const props = { title: "Fixture", count: 1, busy: false, onClose() {}, onConfirm() { approved++; } };
  let tree = ui.render(context.DeleteConfirmModal, props);
  assert.equal(button(tree, "Permanently delete").props.disabled, true);
  const input = [...nodes(tree)].find(node => node.type === "input");
  input.props.onChange({ target: { value: "DELETE" } });
  tree = ui.render(context.DeleteConfirmModal, props);
  assert.equal(button(tree, "Permanently delete").props.disabled, false);
  button(tree, "Permanently delete").props.onClick();
  assert.equal(approved, 1);
});

const state = (status, extra = {}) => ({ status, catalogCurrent: false, lastRunAt: null, completedAt: null, error: null, maxFiles: 250000, ...extra });

test("scan requests and analysis states never label queued, stale, failed or missing results as complete", () => {
  const { exports: helpers } = runtime().load("lib/scan-analysis.ts");
  const queued = helpers.scanRequestFeedback(2);
  assert.match(queued.message, /queued.*2 drive/);
  assert.match(queued.message, /analysis follows successful scans/);
  assert.equal(queued.kind, "accent");
  const duplicate = helpers.scanRequestFeedback(0);
  assert.match(duplicate.message, /No new scans were queued/);
  assert.doesNotMatch(duplicate.message, /No tracked drives/);
  for (const value of [state("queued"), state("running"), state("failed"), state("stale"), state("completed")]) {
    assert.notEqual(helpers.scanAnalysisMessage(value, []).title, "Analysis complete");
  }
  assert.equal(helpers.scanAnalysisMessage(undefined, []), null);
  assert.equal(helpers.scanAnalysisMessage(state("completed", { catalogCurrent: true }), []).title, "Analysis complete");
});

test("combined scan status keeps requests visible until a newer attempt on the same drive", () => {
  const { exports: helpers } = runtime().load("lib/scan-analysis.ts");
  const job = (status, createdAt, extra = {}) => ({ action: "scan", status, createdAt, machineId: "machine-A", result: { analyzeAfterScan: true, driveId: "drive-A", ...extra } });
  assert.equal(helpers.scanAnalysisMessage(state("idle"), [job("approved", 1)]).title, "Scan & Analyze queued");
  assert.equal(helpers.scanAnalysisMessage(state("idle"), [job("running", 1)]).title, "Scanning files");
  const failed = job("failed", 1, { error: "Synthetic drive is disconnected." });
  const message = helpers.scanAnalysisMessage(state("completed", { catalogCurrent: true }), [job("completed", 1), failed]);
  assert.equal(message.title, "Scan & Analyze failed");
  assert.match(message.detail, /disconnected/);
  const partlyWaiting = helpers.scanAnalysisMessage(state("idle"), [failed, job("approved", 1)]);
  assert.equal(partlyWaiting.title, "Scan & Analyze failed");
  assert.match(partlyWaiting.detail, /1 other drive scan/);
  assert.equal(helpers.scanAnalysisMessage(state("idle"), [failed, job("approved", 2)]).title, "Scan & Analyze queued");
  assert.equal(helpers.scanAnalysisMessage(state("completed", { catalogCurrent: true }), [failed, job("completed", 2)]).title, "Analysis complete");
});

test("scanning one drive cannot hide another drive's queued, running, or failed scan", () => {
  const { exports: helpers } = runtime().load("lib/scan-analysis.ts");
  const job = (driveId, status, createdAt, machineId = "machine-A") => ({
    action: "scan", status, createdAt, machineId,
    result: { analyzeAfterScan: true, driveId, error: status === "failed" ? `${driveId} is disconnected.` : undefined },
  });
  const analyzed = state("completed", { catalogCurrent: true, lastRunAt: 300, completedAt: 310 });
  const refreshedA = job("drive-A", "completed", 200);
  for (const [status, title] of [["approved", "Scan & Analyze queued"], ["queued", "Scan & Analyze queued"], ["running", "Scanning files"], ["failed", "Scan & Analyze failed"]]) {
    const outstandingB = job("drive-B", status, 100);
    const message = helpers.scanAnalysisMessage(analyzed, [outstandingB, job("drive-A", "completed", 100), refreshedA]);
    assert.equal(message.title, title, `${status} drive-B must survive a later drive-A scan`);
    if (status === "failed") assert.match(message.detail, /drive-B is disconnected/);
    else assert.match(message.detail, /1 drive scan/);
  }
  const failedB = job("drive-B", "failed", 100);
  const retryingA = helpers.scanAnalysisMessage(analyzed, [failedB, job("drive-A", "approved", 200)]);
  assert.equal(retryingA.title, "Scan & Analyze failed");
  assert.match(retryingA.detail, /1 other drive scan/);
  assert.equal(helpers.scanAnalysisMessage(analyzed, [failedB, refreshedA, job("drive-B", "approved", 220)]).title, "Scan & Analyze queued");
  assert.equal(helpers.scanAnalysisMessage(analyzed, [failedB, refreshedA, job("drive-B", "completed", 220)]).title, "Analysis complete");
  assert.equal(helpers.scanAnalysisMessage(analyzed, [failedB, job("drive-B", "completed", 220, "machine-B")]).title, "Scan & Analyze failed");
  assert.equal(helpers.scanAnalysisMessage(analyzed, [failedB, job("drive-B", "completed", 100)]).title, "Scan & Analyze failed");
});

test("scan status retains every active request and does not guess the owner of legacy failures", () => {
  const { exports: helpers } = runtime().load("lib/scan-analysis.ts");
  const known = { action: "scan", status: "completed", machineId: "machine-A", createdAt: 200, result: { analyzeAfterScan: true, driveId: "drive-A" } };
  const analyzed = state("completed", { catalogCurrent: true, lastRunAt: 300 });
  for (const legacy of [
    { machineId: undefined },
    { result: { analyzeAfterScan: true } },
    { createdAt: undefined },
  ]) {
    const failed = { ...known, status: "failed", createdAt: 100, ...legacy };
    assert.equal(helpers.scanAnalysisMessage(analyzed, [failed, known]).title, "Scan & Analyze failed", JSON.stringify(legacy));
  }
  const active = [
    { ...known, status: "approved", createdAt: 100 },
    { ...known, status: "running", createdAt: 90, machineId: undefined },
  ];
  const message = helpers.scanAnalysisMessage(analyzed, [...active, known]);
  assert.equal(message.title, "Scanning files");
  assert.match(message.detail, /2 drive scan/);
});

test("a validated cached analysis recovers a later successful desktop scan without a new analyzer run", () => {
  const { exports: helpers } = runtime().load("lib/scan-analysis.ts");
  const failed = { action: "scan", status: "failed", machineId: "machine-A", createdAt: 10, updatedAt: 50, result: { analyzeAfterScan: true, driveId: "drive-A" } };
  const scan = { machineId: "machine-A", driveId: "drive-A", startedAt: 60, completedAt: 80, status: "completed", errorsCount: 0 };
  const reused = state("completed", { catalogCurrent: true, lastRunAt: 20, completedAt: 30, validatedAt: 90 });
  assert.equal(helpers.scanAnalysisMessage(reused, [failed], [scan]).title, "Analysis complete");
  for (const changed of [
    { validatedAt: 79 }, { validatedAt: null }, { validatedAt: undefined },
    { status: "queued" }, { status: "running" }, { status: "failed" }, { status: "stale" }, { catalogCurrent: false },
  ]) {
    assert.equal(helpers.scanAnalysisMessage({ ...reused, ...changed }, [failed], [scan]).title, "Scan & Analyze failed", JSON.stringify(changed));
  }
  assert.equal(helpers.scanAnalysisMessage(reused, [failed], [scan, { ...scan, startedAt: 85, completedAt: 88, status: "partial" }]).title, "Scan & Analyze failed");
});

test("analysis progress renders a live status without approving any file operation", () => {
  const ui = runtime({ "scans.analysisStatus": state("queued") });
  const { exports } = ui.load("components/scan-analysis-status.tsx");
  const tree = ui.render(exports.ScanAnalysisStatus, { jobs: [] });
  const live = [...nodes(tree)].find(node => node.props?.role === "status");
  assert.equal(live.props["aria-live"], "polite");
  assert.match(text(tree), /Analysis queued/);
  assert.equal(ui.calls.length, 0);
});

test("a later desktop scan and fresh analysis recover only the failed owning drive", () => {
  const { exports: helpers } = runtime().load("lib/scan-analysis.ts");
  const failed = {
    action: "scan", status: "failed", machineId: "machine-A", createdAt: 10, updatedAt: 50,
    result: { analyzeAfterScan: true, driveId: "drive-A", error: "Old drive-A failure." },
  };
  const scan = { machineId: "machine-A", driveId: "drive-A", startedAt: 60, completedAt: 80, status: "completed", errorsCount: 0 };
  const analyzed = state("completed", { catalogCurrent: true, lastRunAt: 90, completedAt: 100 });
  assert.equal(helpers.scanAnalysisMessage(analyzed, [failed], [scan]).title, "Analysis complete");

  for (const changed of [
    { driveId: "drive-B" }, { machineId: "machine-B" }, { startedAt: 50 }, { startedAt: 20 },
    { status: "partial" }, { status: "failed" }, { status: "running" }, { errorsCount: 1 },
    { completedAt: undefined }, { completedAt: 59 },
  ]) {
    assert.equal(helpers.scanAnalysisMessage(analyzed, [failed], [{ ...scan, ...changed }]).title, "Scan & Analyze failed", JSON.stringify(changed));
  }
  for (const value of [
    state("queued"), state("running"), state("failed"), state("stale"),
    state("completed", { catalogCurrent: false, lastRunAt: 90 }),
    state("completed", { catalogCurrent: true, lastRunAt: 79 }),
    state("completed", { catalogCurrent: true }),
  ]) {
    assert.equal(helpers.scanAnalysisMessage(value, [failed], [scan]).title, "Scan & Analyze failed", JSON.stringify(value));
  }
  const otherFailed = { ...failed, result: { ...failed.result, driveId: "drive-B", error: "Drive-B remains disconnected." } };
  const outstanding = helpers.scanAnalysisMessage(analyzed, [failed, otherFailed], [scan]);
  assert.equal(outstanding.title, "Scan & Analyze failed");
  assert.match(outstanding.detail, /Drive-B remains disconnected/);

  for (const later of [
    { ...scan, startedAt: 85, completedAt: 88, status: "partial" },
    { ...scan, startedAt: 85, completedAt: undefined, status: "running" },
    { ...scan, status: "partial" },
  ]) {
    assert.equal(helpers.scanAnalysisMessage(analyzed, [failed], [scan, later]).title, "Scan & Analyze failed", "A newer or simultaneous incomplete attempt must not be hidden.");
  }
});

test("the live status panel uses scan-session evidence for desktop recovery without approving operations", () => {
  const ui = runtime({ "scans.analysisStatus": state("completed", { catalogCurrent: true, lastRunAt: 90, completedAt: 100 }) });
  const { exports } = ui.load("components/scan-analysis-status.tsx");
  const tree = ui.render(exports.ScanAnalysisStatus, {
    jobs: [{ action: "scan", status: "failed", machineId: "machine-A", createdAt: 10, updatedAt: 50, result: { analyzeAfterScan: true, driveId: "drive-A" } }],
    scans: [{ machineId: "machine-A", driveId: "drive-A", startedAt: 60, completedAt: 80, status: "completed", errorsCount: 0 }],
  });
  assert.match(text(tree), /Analysis complete/);
  assert.doesNotMatch(text(tree), /Scan & Analyze failed/);
  assert.equal(ui.calls.length, 0);
});
