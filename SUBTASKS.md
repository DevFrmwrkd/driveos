Do this first — blocks all end-to-end testing.

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