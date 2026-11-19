// The database mutation applies this decision atomically. Keeping the policy
// separate makes clock boundaries and competing attempts straightforward to test.
export const JOB_LEASE_MS = 120_000;

export interface LeasedJob {
  status: string;
  updatedAt: number;
  claimToken?: string;
  leaseExpiresAt?: number;
  leaseRequired?: boolean;
  attempts?: number;
}

export function jobLeaseExpired(job: LeasedJob, now: number) {
  // Old agents neither heartbeat nor hold the upgraded agent's local job lock.
  // Age alone cannot prove they stopped touching files; never take them over.
  return job.status === "running" && Boolean(job.claimToken) &&
    typeof job.leaseExpiresAt === "number" && now >= job.leaseExpiresAt;
}

export function jobAvailableToAgent(job: LeasedJob, now: number, leaseProtocol?: number) {
  if (job.status === "approved" || job.status === "queued") {
    return leaseProtocol === 1 || (!job.leaseRequired && !job.claimToken);
  }
  return leaseProtocol === 1 && jobLeaseExpired(job, now);
}

export function decideJobLease(job: LeasedJob, status: string, claimToken: string | undefined, now: number) {
  if (["completed", "failed", "cancelled"].includes(job.status)) {
    return { accepted: false as const, reason: "already_finished" };
  }
  if (claimToken !== undefined && !/^[a-zA-Z0-9_-]{20,200}$/.test(claimToken)) {
    return { accepted: false as const, reason: "invalid_claim_token" };
  }
  if (status === "running") {
    if (job.status === "running" && !job.claimToken) {
      return { accepted: false as const, reason: "legacy_running_requires_review" };
    }
    const renewing = job.status === "running" && Boolean(claimToken) && job.claimToken === claimToken;
    const available = ["approved", "queued"].includes(job.status) || (claimToken && jobLeaseExpired(job, now));
    if (!renewing && !available) return { accepted: false as const, reason: "already_claimed" };
    if (!claimToken) {
      if (job.leaseRequired || job.claimToken) return { accepted: false as const, reason: "agent_upgrade_required" };
      return { accepted: true as const, renewing: false, patch: {} };
    }
    return {
      accepted: true as const,
      renewing,
      patch: {
        claimToken,
        leaseRequired: true,
        leaseExpiresAt: now + JOB_LEASE_MS,
        attempts: renewing ? (job.attempts ?? 1) : (job.attempts ?? 0) + 1,
      },
    };
  }
  if (job.status !== "running") return { accepted: false as const, reason: "not_running" };
  if (job.claimToken) {
    if (claimToken !== job.claimToken || jobLeaseExpired(job, now)) {
      return { accepted: false as const, reason: "lease_lost" };
    }
  } else if (job.leaseRequired || claimToken) {
    return { accepted: false as const, reason: "lease_lost" };
  }
  return { accepted: true as const, renewing: false, patch: { leaseExpiresAt: undefined } };
}

export function withoutClaimToken<T extends { claimToken?: string }>(job: T): Omit<T, "claimToken"> {
  const { claimToken: _claimToken, ...visible } = job;
  return visible;
}
