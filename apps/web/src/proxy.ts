import { convexAuthNextjsMiddleware } from "@convex-dev/auth/nextjs/server";

// Keeps the Convex Auth session cookie fresh on every request. Route-level
// gating is handled in the app via <Authenticated>/<Unauthenticated>.
export default convexAuthNextjsMiddleware();

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
