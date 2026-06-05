import { classifyFile, calculateFileRisk, calculateProjectHealth } from "./index";

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
