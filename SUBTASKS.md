1. Do this first — blocks all end-to-end testing.

Three configs point at two different Convex deployments:

apps/web/.env.local → NEXT_PUBLIC_CONVEX_URL = determined-anaconda-827
root .env.local → nautical-giraffe-891
driveos-config.json → determined-anaconda-827

Do:

Decide the single source-of-truth Convex deployment for driveos.
Point web (NEXT_PUBLIC_CONVEX_URL), agent (convexUrl + CONVEX_SITE_URL for the HTTP API), and root env at that one deployment.
Add driveos-config.json + local state files to .gitignore (machine-specific; currently committed).
Re-seed if needed: npx convex dev --run seed:seed.
Smoke test: agent scan → metadata shows in the same dashboard the web app reads.


2. Make the dashboard read/write — wire actions to Convex


The UI renders but action buttons only fire toast() — no mutations run. The dashboard is currently read-only.

Do:

Wire Approve cleanup → cleanup.approveJob / cleanup.createJob.
Wire Quarantine duplicate → cleanup mutation.
Wire Create project wizard → projects.create.
Wire Restore (Quarantine screen) → cleanup.markQuarantineRestored flow.
Add useQuery(api.files.list) + useQuery(api.scans.list) so Files + Scan History show live data.
Remove hardcoded fallbacks masking missing data (e.g. dupTB || 0.42, cleanTB || 0.61).

Key file: apps/web/src/app/page.tsx.