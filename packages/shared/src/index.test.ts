import { classifyFile, calculateFileRisk, calculateProjectHealth, deriveAlerts } from "./index";

const TB = 1024 ** 4;

describe("DriveOS shared library classification rules", () => {
  test("Classify raw camera footage files", () => {
    expect(classifyFile("/Volumes/Drive/ShowX/RAW/A_CAM/A001_C004.mov", "A001_C004.mov")).toBe("RAW");
    expect(classifyFile("/Volumes/Drive/ShowX/Camera/B_CAM/B001_C002.mxf", "B001_C002.mxf")).toBe("RAW");
    expect(classifyFile("/Volumes/Drive/ShowX/02_RAW/A001.braw", "A001.braw")).toBe("RAW");
  });

  test("Classify proxies", () => {
    expect(classifyFile("/Volumes/Drive/ShowX/05_PROXIES/clip_proxy.mov", "clip_proxy.mov")).toBe("PROXY");
    expect(classifyFile("/Volumes/Drive/ShowX/PROXIES/clip.mov", "clip.mov")).toBe("PROXY");
    expect(classifyFile("/Volumes/Drive/ShowX/clip_lowres.mp4", "clip_lowres.mp4")).toBe("PROXY");
  });

  test("Classify project files", () => {
    expect(classifyFile("/Volumes/Drive/ShowX/03_PROJECT_FILES/PREMIERE/edit.prproj", "edit.prproj")).toBe("PROJECT_FILE");
    expect(classifyFile("/Volumes/Drive/ShowX/illustrations/graphics.psd", "graphics.psd")).toBe("GRAPHICS"); // psd outside project files is graphics
    expect(classifyFile("/Volumes/Drive/ShowX/03_PROJECT_FILES/design.psd", "design.psd")).toBe("PROJECT_FILE"); // psd inside project folder is project file
  });

  test("Classify cache", () => {
    expect(classifyFile("/Volumes/Drive/ShowX/06_RENDERS_CACHE/file.pek", "file.pek")).toBe("CACHE");
    expect(classifyFile("/Adobe/Common/Media Cache/audio_peak.cfa", "audio_peak.cfa")).toBe("CACHE");
  });

  test("Classify export reviews and finals", () => {
    expect(classifyFile("/Volumes/Drive/ShowX/07_EXPORTS/REVIEW/v1_cut.mp4", "v1_cut.mp4")).toBe("EXPORT_REVIEW");
    expect(classifyFile("/Volumes/Drive/ShowX/07_EXPORTS/FINAL/EP214_FINAL_v7_approved.mov", "EP214_FINAL_v7_approved.mov")).toBe("EXPORT_FINAL");
  });

  test("Risk Level Assessments", () => {
    // RAW, Project files, and finals must always be red (High Risk)
    expect(calculateFileRisk("RAW", 100 * 1024 * 1024)).toBe("red");
    expect(calculateFileRisk("PROJECT_FILE", 2 * 1024 * 1024)).toBe("red");
    expect(calculateFileRisk("EXPORT_FINAL", 42 * 1024 * 1024 * 1024)).toBe("red");

    // Cache must always be green (Safe)
    expect(calculateFileRisk("CACHE", 15 * 1024 * 1024 * 1024)).toBe("green");

    // Small proxies are green, massive proxies are yellow
    expect(calculateFileRisk("PROXY", 100 * 1024 * 1024)).toBe("green");
    expect(calculateFileRisk("PROXY", 15 * 1024 * 1024 * 1024)).toBe("yellow");

    // Unknown large files must be red
    expect(calculateFileRisk("UNKNOWN", 20 * 1024 * 1024)).toBe("yellow"); // small is yellow
    expect(calculateFileRisk("UNKNOWN", 500 * 1024 * 1024)).toBe("red"); // large is red
  });

  test("Project Health Calculations", () => {
    // Perfect project
    expect(calculateProjectHealth(100, 1000, 0, 0, true, true, true)).toBe(100);

    // Project missing required folders
    expect(calculateProjectHealth(50, 1000, 0, 0, true, true, true)).toBe(88); // deducts (100 - 50) * 0.25 = 12.5 points

    // Project with excessive duplicate and cache waste
    expect(calculateProjectHealth(100, 1000, 400, 200, true, true, true)).toBe(75); // deducts (600 / 1000) * 50 = 30 points, capped at 25 points deduction

    // Project missing final deliverable and RAW camera files
    expect(calculateProjectHealth(100, 1000, 0, 0, false, true, false)).toBe(65); // deducts 15 for finals, 20 for raw
  });
});

describe("DriveOS notifications & alerts engine", () => {
  const now = 1_700_000_000_000;

  test("Flags a near-full working drive as critical", () => {
    const alerts = deriveAlerts({
      drives: [
        { _id: "d1", label: "CJ Working SSD", capacityBytes: 4 * TB, usedBytes: 3.8 * TB, status: "online", cleanTB: 0.6 },
      ],
      now,
    });
    const drive = alerts.find((a) => a.key === "drive-full-d1");
    expect(drive).toBeDefined();
    expect(drive!.severity).toBe("critical");
    expect(drive!.actionScreen).toBe("drive");
    expect(drive!.actionParams).toEqual({ id: "d1" });
    expect(drive!.message).toContain("recover");
  });

  test("Uses a warning (not critical) for moderately full drives", () => {
    const alerts = deriveAlerts({
      drives: [{ _id: "d2", label: "Master 02", capacityBytes: 20 * TB, usedBytes: 17 * TB, status: "online" }],
      now,
    });
    const drive = alerts.find((a) => a.key === "drive-full-d2");
    expect(drive?.severity).toBe("warning");
  });

  test("Does not warn on healthy, cloud, or uninitialized capacity drives", () => {
    const alerts = deriveAlerts({
      drives: [
        { _id: "ok", label: "Healthy", capacityBytes: 10 * TB, usedBytes: 2 * TB, status: "online" },
        { _id: "cloud", label: "GDrive", capacityBytes: 20 * TB, usedBytes: 19 * TB, status: "cloud" },
      ],
      now,
    });
    expect(alerts.find((a) => a.key === "drive-full-ok")).toBeUndefined();
    expect(alerts.find((a) => a.key === "drive-full-cloud")).toBeUndefined();
  });

  test("Surfaces an init alert for uninitialized drives", () => {
    const alerts = deriveAlerts({
      drives: [{ _id: "new", label: "Japan Storage 01", capacityBytes: 20 * TB, usedBytes: 0, status: "uninit" }],
      now,
    });
    expect(alerts.find((a) => a.key === "drive-uninit-new")?.severity).toBe("info");
  });

  test("Aggregates duplicate waste above the threshold", () => {
    const alerts = deriveAlerts({
      duplicateClusters: [
        { status: "open", wastedBytes: 0.8 * TB },
        { status: "open", wastedBytes: 0.5 * TB },
        { status: "resolved", wastedBytes: 5 * TB },
      ],
      now,
    });
    const dup = alerts.find((a) => a.key === "dup-waste");
    expect(dup).toBeDefined();
    expect(dup!.metricBytes).toBeCloseTo(1.3 * TB, -9);
    expect(dup!.message).toContain("2 open duplicate clusters");
  });

  test("Reports safe cleanup only for open green recommendations", () => {
    const alerts = deriveAlerts({
      recommendations: [
        { status: "open", riskLevel: "green", affectedBytes: 0.4 * TB },
        { status: "open", riskLevel: "green", affectedBytes: 0.3 * TB },
        { status: "open", riskLevel: "red", affectedBytes: 9 * TB },
        { status: "completed", riskLevel: "green", affectedBytes: 9 * TB },
      ],
      now,
    });
    const cleanup = alerts.find((a) => a.key === "cleanup-safe");
    expect(cleanup?.severity).toBe("success");
    expect(cleanup!.metricBytes).toBeCloseTo(0.7 * TB, -9);
  });

  test("Flags single-copy project risk and ready-to-archive projects", () => {
    const alerts = deriveAlerts({
      projects: [
        { _id: "p1", name: "Brand Films", status: "active", riskyBytes: 0.9 * TB, storageHealthScore: 64 },
        { _id: "p2", name: "Client Launch", status: "ready_to_archive", totalBytes: 0.92 * TB, storageHealthScore: 88 },
      ],
      now,
    });
    expect(alerts.find((a) => a.key === "project-risk-p1")?.severity).toBe("critical");
    expect(alerts.find((a) => a.key === "project-archive-p2")?.severity).toBe("info");
  });

  test("Flags due-soon projects and stale agents", () => {
    const alerts = deriveAlerts({
      projects: [{ _id: "p3", name: "Spot", status: "active", dueDate: now + 2 * 24 * 60 * 60 * 1000 }],
      machines: [{ _id: "m1", name: "CJ-Workstation", status: "online", lastSeenAt: now - 60 * 60 * 1000 }],
      now,
    });
    expect(alerts.find((a) => a.key === "project-due-p3")?.severity).toBe("warning");
    expect(alerts.find((a) => a.key === "agent-offline-m1")?.severity).toBe("warning");
  });

  test("Sorts critical alerts before lower-severity ones", () => {
    const alerts = deriveAlerts({
      drives: [{ _id: "d", label: "Full", capacityBytes: 4 * TB, usedBytes: 3.9 * TB, status: "online" }],
      recommendations: [{ status: "open", riskLevel: "green", affectedBytes: 2 * TB }],
      now,
    });
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[alerts.length - 1].severity).toBe("success");
  });
});
