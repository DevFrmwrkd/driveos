export class RateLimitedError extends Error {
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message);
    this.name = "RateLimitedError";
  }
}

type Wait = (milliseconds: number) => Promise<void>;
const wait: Wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export class JobLeaseLostError extends Error {
  constructor(reason: string) { super(`Job lease lost: ${reason}`); this.name = "JobLeaseLostError"; }
}

/** Retry the same request after the server's delay, without flooding its limiter. */
export async function withRateLimitBackoff<T>(operation: () => Promise<T>, pause: Wait = wait): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (!(error instanceof RateLimitedError) || attempt >= 3) throw error;
      const seconds = Number.isFinite(error.retryAfterSeconds) ? Math.max(1, error.retryAfterSeconds) : 60;
      await pause(seconds * 1000);
    }
  }
}

/** A successful claim starts a fresh server lease. Per-file checks only renew
 * after elapsed time; concurrent checks and the timer share one request. */
export class JobLeaseClient {
  private confirmedAt: number;
  private renewing?: Promise<void>;
  private lost?: JobLeaseLostError;
  private readonly now: () => number;
  private readonly pause: Wait;
  private readonly refreshAfterMs: number;

  constructor(
    private readonly renew: () => Promise<{ claimed: boolean; reason?: string }>,
    options: { now?: () => number; pause?: Wait; refreshAfterMs?: number } = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.pause = options.pause ?? wait;
    this.refreshAfterMs = options.refreshAfterMs ?? 20_000;
    this.confirmedAt = this.now();
  }

  async ensureValid(): Promise<void> {
    if (this.lost) throw this.lost;
    if (this.renewing) return this.renewing;
    const elapsed = this.now() - this.confirmedAt;
    if (elapsed >= 0 && elapsed < this.refreshAfterMs) return;
    const request = withRateLimitBackoff(async () => {
      const lease = await this.renew();
      if (lease.claimed !== true) {
        this.lost = new JobLeaseLostError(lease.reason || "another agent owns this attempt");
        throw this.lost;
      }
      this.confirmedAt = this.now();
    }, this.pause);
    this.renewing = request;
    try { await request; }
    finally { if (this.renewing === request) this.renewing = undefined; }
  }
}
