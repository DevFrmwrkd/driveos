/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ResendOTP from "../ResendOTP.js";
import type * as access from "../access.js";
import type * as admin from "../admin.js";
import type * as agentAuth from "../agentAuth.js";
import type * as archive from "../archive.js";
import type * as audit from "../audit.js";
import type * as auth from "../auth.js";
import type * as catalogAnalysis from "../catalogAnalysis.js";
import type * as catalogObservations from "../catalogObservations.js";
import type * as cleanup from "../cleanup.js";
import type * as cloud from "../cloud.js";
import type * as compaction from "../compaction.js";
import type * as crons from "../crons.js";
import type * as demoSeedPolicy from "../demoSeedPolicy.js";
import type * as drives from "../drives.js";
import type * as duplicates from "../duplicates.js";
import type * as emails from "../emails.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as invitations from "../invitations.js";
import type * as jobLease from "../jobLease.js";
import type * as jobUtils from "../jobUtils.js";
import type * as keepCopy from "../keepCopy.js";
import type * as projects from "../projects.js";
import type * as rateLimits from "../rateLimits.js";
import type * as recommendations from "../recommendations.js";
import type * as retention from "../retention.js";
import type * as scans from "../scans.js";
import type * as seed from "../seed.js";
import type * as settings from "../settings.js";
import type * as tenants from "../tenants.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ResendOTP: typeof ResendOTP;
  access: typeof access;
  admin: typeof admin;
  agentAuth: typeof agentAuth;
  archive: typeof archive;
  audit: typeof audit;
  auth: typeof auth;
  catalogAnalysis: typeof catalogAnalysis;
  catalogObservations: typeof catalogObservations;
  cleanup: typeof cleanup;
  cloud: typeof cloud;
  compaction: typeof compaction;
  crons: typeof crons;
  demoSeedPolicy: typeof demoSeedPolicy;
  drives: typeof drives;
  duplicates: typeof duplicates;
  emails: typeof emails;
  files: typeof files;
  http: typeof http;
  invitations: typeof invitations;
  jobLease: typeof jobLease;
  jobUtils: typeof jobUtils;
  keepCopy: typeof keepCopy;
  projects: typeof projects;
  rateLimits: typeof rateLimits;
  recommendations: typeof recommendations;
  retention: typeof retention;
  scans: typeof scans;
  seed: typeof seed;
  settings: typeof settings;
  tenants: typeof tenants;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
