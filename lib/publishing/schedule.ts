import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { VIDEO_URL_SAFETY_MS } from "@/lib/publishing/reel-publisher";

export const scheduleReelSchema = z.object({
  /** Instagram username of a connected Meta account, without the @. */
  account: z.string().min(1).max(64),
  /** Idempotency key: the same key for the same account never creates a second row. */
  externalId: z.string().min(8).max(128),
  label: z.string().max(200).optional().nullable(),
  videoUrl: z.string().url().startsWith("https://"),
  videoUrlExpiresAt: z.string().datetime().optional().nullable(),
  caption: z.string().max(2200).optional().nullable(),
  coverUrl: z.string().url().startsWith("https://").optional().nullable(),
  thumbOffsetMs: z.number().int().min(0).optional().nullable(),
  shareToFeed: z.boolean().optional().default(true),
  trialGraduation: z.enum(["MANUAL", "SS_PERFORMANCE"]).optional().nullable(),
  /** Omit to publish on the next worker sweep. */
  scheduledFor: z.string().datetime().optional().nullable(),
});

export type ScheduleReelInput = z.infer<typeof scheduleReelSchema>;

export class ScheduleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function scheduleReel(input: ScheduleReelInput, now = new Date()) {
  const username = input.account.replace(/^@/, "");
  const account = await prisma.instagramAccount.findFirst({
    where: { username, provider: "META" },
    select: { id: true, workspaceId: true },
  });
  if (!account) {
    throw new ScheduleError(404, `No Meta-connected account @${username}`);
  }

  const scheduledFor = input.scheduledFor ? new Date(input.scheduledFor) : now;
  const expiresAt = input.videoUrlExpiresAt
    ? new Date(input.videoUrlExpiresAt)
    : null;
  if (
    expiresAt &&
    expiresAt.getTime() - Math.max(scheduledFor.getTime(), now.getTime()) <
      VIDEO_URL_SAFETY_MS
  ) {
    throw new ScheduleError(
      422,
      "videoUrl expires before the scheduled time; upload closer to the date"
    );
  }

  const existing = await prisma.reelPublication.findUnique({
    where: {
      instagramAccountId_externalId: {
        instagramAccountId: account.id,
        externalId: input.externalId,
      },
    },
  });
  if (existing) return { publication: existing, created: false };

  try {
    const publication = await prisma.reelPublication.create({
      data: {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        externalId: input.externalId,
        label: input.label ?? null,
        videoUrl: input.videoUrl,
        videoUrlExpiresAt: expiresAt,
        caption: input.caption ?? null,
        coverUrl: input.coverUrl ?? null,
        thumbOffsetMs: input.thumbOffsetMs ?? null,
        shareToFeed: input.shareToFeed,
        trialGraduation: input.trialGraduation ?? null,
        scheduledFor,
      },
    });
    return { publication, created: true };
  } catch (error) {
    // Lost a race with an identical request: return the winner.
    const winner = await prisma.reelPublication.findUnique({
      where: {
        instagramAccountId_externalId: {
          instagramAccountId: account.id,
          externalId: input.externalId,
        },
      },
    });
    if (winner) return { publication: winner, created: false };
    throw error;
  }
}

/** What the API returns: never the signed video URL, which is a credential. */
export function serializePublication(row: {
  id: string;
  externalId: string;
  label: string | null;
  status: string;
  trialGraduation: string | null;
  scheduledFor: Date;
  containerId: string | null;
  mediaId: string | null;
  permalink: string | null;
  publishedAt: Date | null;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  insightSnapshots?: { hoursAfter: number; metrics: unknown; collectedAt: Date }[];
}) {
  return {
    id: row.id,
    externalId: row.externalId,
    label: row.label,
    status: row.status,
    trialGraduation: row.trialGraduation,
    scheduledFor: row.scheduledFor.toISOString(),
    containerId: row.containerId,
    mediaId: row.mediaId,
    permalink: row.permalink,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    insights: (row.insightSnapshots ?? []).map((s) => ({
      hoursAfter: s.hoursAfter,
      metrics: s.metrics,
      collectedAt: s.collectedAt.toISOString(),
    })),
  };
}
