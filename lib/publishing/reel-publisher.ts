/**
 * Reel publisher.
 *
 * Instagram has no native scheduling for reels, so a ReelPublication row waits
 * in SCHEDULED until `scheduledFor`, then the worker walks it through:
 *
 *   SCHEDULED -> CREATING_CONTAINER -> PROCESSING -> PUBLISHING -> PUBLISHED
 *
 * Every transition is a guarded `updateMany` claim, so two sweeps (or a sweep
 * racing a crash recovery) can never both act on the same row. The one
 * irreversible call, `media_publish`, is only made on a container we created
 * and whose status_code is FINISHED; a container that reports PUBLISHED without
 * a recorded media id goes to NEEDS_REVIEW instead of being published again.
 */

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { decryptToken } from "@/lib/meta/oauth";
import {
  createReelContainer,
  getContainerStatus,
  getContentPublishingLimit,
  getMediaInsights,
  getMediaPermalink,
  publishMediaContainer,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";

export const MAX_PUBLISH_ATTEMPTS = 5;
// A claim older than this belongs to a sweep that died mid-step.
export const STALE_CLAIM_MS = 10 * 60_000;
// Meta must still be able to fetch the video when the container is created.
export const VIDEO_URL_SAFETY_MS = 30 * 60_000;
export const INSIGHT_CHECKPOINTS_HOURS = [24, 48, 72];
// A checkpoint missed by more than this (worker down) is skipped rather than
// recorded late under the wrong label.
export const INSIGHT_WINDOW_HOURS = 12;
export const REEL_INSIGHT_METRICS = [
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saved",
  "total_interactions",
  "reels_skip_rate",
  "ig_reels_avg_watch_time",
  "ig_reels_video_view_total_time",
];
const DEFAULT_PUBLISHING_QUOTA = 100;

const accountSelect = {
  instagramId: true,
  accessToken: true,
  provider: true,
} as const;

type PublicationAccount = {
  instagramId: string;
  accessToken: string;
  provider: "META" | "ZERNIO";
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function metaToken(account: PublicationAccount): string {
  if (account.provider !== "META") {
    throw new Error("Reel publishing needs a Meta-connected account");
  }
  return decryptToken(account.accessToken);
}

async function logEvent(
  workspaceId: string,
  level: "INFO" | "WARNING" | "ERROR",
  message: string,
  payload: Prisma.InputJsonObject
) {
  try {
    await prisma.operationalEvent.create({
      data: { workspaceId, source: "WORKER", level, message, payload },
    });
  } catch (error) {
    console.error("[Reel Publisher] Could not record event:", errorMessage(error));
  }
}

export interface ReelSweepResult {
  containersCreated: number;
  published: number;
  failed: number;
  needsReview: number;
  insightsCollected: number;
}

function emptyResult(): ReelSweepResult {
  return {
    containersCreated: 0,
    published: 0,
    failed: 0,
    needsReview: 0,
    insightsCollected: 0,
  };
}

// ─── Step 1: create containers for due rows ────────────────────────────────────

async function startDuePublications(now: Date, result: ReelSweepResult) {
  const due = await prisma.reelPublication.findMany({
    where: { status: "SCHEDULED", scheduledFor: { lte: now } },
    orderBy: { scheduledFor: "asc" },
    take: 10,
    include: { instagramAccount: { select: accountSelect } },
  });

  const quotaFull = new Set<string>();

  for (const row of due) {
    if (quotaFull.has(row.instagramAccountId)) continue;

    const claim = await prisma.reelPublication.updateMany({
      where: { id: row.id, status: "SCHEDULED" },
      data: { status: "CREATING_CONTAINER", claimedAt: now },
    });
    if (claim.count !== 1) continue;

    if (
      row.videoUrlExpiresAt &&
      row.videoUrlExpiresAt.getTime() - now.getTime() < VIDEO_URL_SAFETY_MS
    ) {
      await prisma.reelPublication.updateMany({
        where: { id: row.id, status: "CREATING_CONTAINER" },
        data: {
          status: "FAILED",
          claimedAt: null,
          lastError: "videoUrl expired before the container could be created",
        },
      });
      result.failed++;
      continue;
    }

    try {
      const token = metaToken(row.instagramAccount);
      const limit = await getContentPublishingLimit(
        token,
        row.instagramAccount.instagramId
      );
      if (limit.quotaUsage >= (limit.quotaTotal ?? DEFAULT_PUBLISHING_QUOTA)) {
        quotaFull.add(row.instagramAccountId);
        await prisma.reelPublication.updateMany({
          where: { id: row.id, status: "CREATING_CONTAINER" },
          data: {
            status: "SCHEDULED",
            claimedAt: null,
            lastError: `Publishing quota reached (${limit.quotaUsage})`,
          },
        });
        continue;
      }

      const container = await createReelContainer(
        token,
        row.instagramAccount.instagramId,
        {
          videoUrl: row.videoUrl,
          caption: row.caption,
          coverUrl: row.coverUrl,
          thumbOffsetMs: row.thumbOffsetMs,
          shareToFeed: row.shareToFeed,
          trialGraduation: row.trialGraduation,
        }
      );

      await prisma.reelPublication.updateMany({
        where: { id: row.id, status: "CREATING_CONTAINER" },
        data: {
          status: "PROCESSING",
          containerId: container.id,
          claimedAt: null,
          lastError: null,
        },
      });
      result.containersCreated++;
    } catch (error) {
      const attempts = row.attempts + 1;
      const retry =
        error instanceof RateLimitError && attempts < MAX_PUBLISH_ATTEMPTS;
      await prisma.reelPublication.updateMany({
        where: { id: row.id, status: "CREATING_CONTAINER" },
        data: {
          status: retry ? "SCHEDULED" : "FAILED",
          claimedAt: null,
          attempts,
          lastError: errorMessage(error),
        },
      });
      if (!retry) {
        result.failed++;
        await logEvent(row.workspaceId, "ERROR", "Reel container creation failed", {
          publicationId: row.id,
          error: errorMessage(error),
          tokenExpired: error instanceof TokenExpiredError,
        });
      }
    }
  }
}

// ─── Step 2: publish containers that finished processing ───────────────────────

async function advanceProcessing(now: Date, result: ReelSweepResult) {
  const rows = await prisma.reelPublication.findMany({
    where: { status: "PROCESSING", containerId: { not: null } },
    orderBy: { scheduledFor: "asc" },
    take: 20,
    include: { instagramAccount: { select: accountSelect } },
  });

  for (const row of rows) {
    const containerId = row.containerId!;
    let token: string;
    let status: string;
    try {
      token = metaToken(row.instagramAccount);
      status = (await getContainerStatus(token, containerId)).status_code;
    } catch (error) {
      await prisma.reelPublication.updateMany({
        where: { id: row.id, status: "PROCESSING" },
        data: { lastError: errorMessage(error) },
      });
      continue;
    }

    if (status === "IN_PROGRESS") continue;

    if (status === "ERROR" || status === "EXPIRED") {
      await prisma.reelPublication.updateMany({
        where: { id: row.id, status: "PROCESSING" },
        data: { status: "FAILED", lastError: `Container ${status}` },
      });
      result.failed++;
      await logEvent(row.workspaceId, "ERROR", `Reel container ${status}`, {
        publicationId: row.id,
        containerId,
      });
      continue;
    }

    if (status === "PUBLISHED") {
      // Published by an earlier attempt whose response we never recorded.
      await prisma.reelPublication.updateMany({
        where: { id: row.id, status: "PROCESSING" },
        data: {
          status: "NEEDS_REVIEW",
          lastError:
            "Container already PUBLISHED but no media id was recorded; check the profile",
        },
      });
      result.needsReview++;
      await logEvent(row.workspaceId, "WARNING", "Reel published without media id", {
        publicationId: row.id,
        containerId,
      });
      continue;
    }

    if (status !== "FINISHED") continue;

    if (row.attempts >= MAX_PUBLISH_ATTEMPTS) {
      await prisma.reelPublication.updateMany({
        where: { id: row.id, status: "PROCESSING" },
        data: { status: "FAILED" },
      });
      result.failed++;
      continue;
    }

    const claim = await prisma.reelPublication.updateMany({
      where: { id: row.id, status: "PROCESSING", containerId },
      data: { status: "PUBLISHING", claimedAt: now, attempts: { increment: 1 } },
    });
    if (claim.count !== 1) continue;

    try {
      const media = await publishMediaContainer(
        token,
        row.instagramAccount.instagramId,
        containerId
      );
      let permalink: string | null = null;
      try {
        permalink = await getMediaPermalink(token, media.id);
      } catch {}
      await prisma.reelPublication.updateMany({
        where: { id: row.id, status: "PUBLISHING" },
        data: {
          status: "PUBLISHED",
          mediaId: media.id,
          permalink,
          publishedAt: new Date(),
          claimedAt: null,
          lastError: null,
        },
      });
      result.published++;
      await logEvent(row.workspaceId, "INFO", "Reel published", {
        publicationId: row.id,
        mediaId: media.id,
        trial: row.trialGraduation,
      });
    } catch (error) {
      // Back to PROCESSING: the next sweep re-reads status_code, so a publish
      // that actually went through lands in NEEDS_REVIEW, never a second post.
      await prisma.reelPublication.updateMany({
        where: { id: row.id, status: "PUBLISHING" },
        data: {
          status: "PROCESSING",
          claimedAt: null,
          lastError: errorMessage(error),
        },
      });
    }
  }
}

// ─── Step 3: recover claims left behind by a crash ─────────────────────────────

async function recoverStaleClaims(now: Date) {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS);

  // No container id was saved, so nothing can be published from it; an
  // orphaned container on Meta's side simply expires after 24h.
  await prisma.reelPublication.updateMany({
    where: {
      status: "CREATING_CONTAINER",
      containerId: null,
      claimedAt: { lt: cutoff },
    },
    data: { status: "SCHEDULED", claimedAt: null },
  });

  // Hand back to PROCESSING, which re-reads status_code before publishing.
  await prisma.reelPublication.updateMany({
    where: { status: "PUBLISHING", claimedAt: { lt: cutoff } },
    data: { status: "PROCESSING", claimedAt: null },
  });
}

// ─── Step 4: insights at fixed checkpoints ─────────────────────────────────────

export function dueInsightCheckpoints(
  publishedAt: Date,
  now: Date,
  collected: number[]
): number[] {
  const elapsedHours = (now.getTime() - publishedAt.getTime()) / 3_600_000;
  return INSIGHT_CHECKPOINTS_HOURS.filter(
    (hours) =>
      elapsedHours >= hours &&
      elapsedHours < hours + INSIGHT_WINDOW_HOURS &&
      !collected.includes(hours)
  );
}

async function collectInsights(now: Date, result: ReelSweepResult) {
  const maxHours =
    Math.max(...INSIGHT_CHECKPOINTS_HOURS) + INSIGHT_WINDOW_HOURS;
  const rows = await prisma.reelPublication.findMany({
    where: {
      status: "PUBLISHED",
      mediaId: { not: null },
      publishedAt: { gte: new Date(now.getTime() - maxHours * 3_600_000) },
    },
    include: {
      instagramAccount: { select: accountSelect },
      insightSnapshots: { select: { hoursAfter: true } },
    },
  });

  for (const row of rows) {
    const due = dueInsightCheckpoints(
      row.publishedAt!,
      now,
      row.insightSnapshots.map((s) => s.hoursAfter)
    );
    if (due.length === 0) continue;

    try {
      const token = metaToken(row.instagramAccount);
      const metrics = await getMediaInsights(
        token,
        row.mediaId!,
        REEL_INSIGHT_METRICS
      );
      for (const hoursAfter of due) {
        await prisma.reelInsightSnapshot.upsert({
          where: {
            publicationId_hoursAfter: { publicationId: row.id, hoursAfter },
          },
          create: { publicationId: row.id, hoursAfter, metrics: { ...metrics } as Prisma.InputJsonObject },
          update: {},
        });
        result.insightsCollected++;
      }
    } catch (error) {
      await logEvent(row.workspaceId, "WARNING", "Reel insights unavailable", {
        publicationId: row.id,
        error: errorMessage(error),
      });
    }
  }
}

export async function processReelPublications(
  now: Date = new Date()
): Promise<ReelSweepResult> {
  const result = emptyResult();
  await recoverStaleClaims(now);
  await startDuePublications(now, result);
  await advanceProcessing(now, result);
  await collectInsights(now, result);
  return result;
}
