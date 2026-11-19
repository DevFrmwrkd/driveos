/** Destructive demo fixtures belong only to an explicitly enabled local app. */
export function requireLocalDemoSeed(environment: Record<string, string | undefined>) {
  let local = false;
  try { local = ["127.0.0.1", "localhost", "[::1]"].includes(new URL(environment.CONVEX_SITE_URL || "").hostname); }
  catch { /* missing or invalid deployment URL is not a local fixture */ }
  if (!local || environment.DRIVEOS_ENABLE_DEMO_SEED !== "1") {
    throw new Error("Demo seeding is disabled. It requires a disposable loopback backend with DRIVEOS_ENABLE_DEMO_SEED=1.");
  }
}
