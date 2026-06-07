/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as archive from "../archive.js";
import type * as audit from "../audit.js";
import type * as cleanup from "../cleanup.js";
import type * as cloud from "../cloud.js";
import type * as crons from "../crons.js";
import type * as drives from "../drives.js";
import type * as duplicates from "../duplicates.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as notifications from "../notifications.js";
import type * as projects from "../projects.js";
import type * as recommendations from "../recommendations.js";
import type * as scans from "../scans.js";
import type * as seed from "../seed.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  archive: typeof archive;
  audit: typeof audit;
  cleanup: typeof cleanup;
  cloud: typeof cloud;
  crons: typeof crons;
  drives: typeof drives;
  duplicates: typeof duplicates;
  files: typeof files;
  http: typeof http;
  notifications: typeof notifications;
  projects: typeof projects;
  recommendations: typeof recommendations;
  scans: typeof scans;
  seed: typeof seed;
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

export declare const components: {};
