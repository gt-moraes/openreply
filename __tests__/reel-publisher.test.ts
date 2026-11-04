/**
 * Reel publisher — Unit Tests
 *
 * The one call that cannot be undone is media_publish, so most of these tests
 * pin down when it is and is not made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPrisma,
  mockCreateReelContainer,
  mockGetContainerStatus,
  mockPublishMediaContainer,
  mockGetContentPublishingLimit,
  mockGetMediaInsights,
  mockGetMediaPermalink,
} = vi.hoisted(() => ({
  mockPrisma: {
    reelPublication: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    reelInsightSnapshot: { upsert: vi.fn() },
    instagramAccount: { findFirst: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  mockCreateReelContainer: vi.fn(),
  mockGetContainerStatus: vi.fn(),
  mockPublishMediaContainer: vi.fn(),
  mockGetContentPublishingLimit: vi.fn(),
  mockGetMediaInsights: vi.fn(),
  mockGetMediaPermalink: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (t: string) => `plain:${t}` }));
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/client")>();
  return {
    ...actual,
    createReelContainer: mockCreateReelContainer,
    getContainerStatus: mockGetContainerStatus,
    publishMediaContainer: mockPublishMediaContainer,
    getContentPublishingLimit: mockGetContentPublishingLimit,
    getMediaInsights: mockGetMediaInsights,
    getMediaPermalink: mockGetMediaPermalink,
  };
});

import {
  dueInsightCheckpoints,
  processReelPublications,
} from "@/lib/publishing/reel-publisher";
import { buildReelContainerBody, RateLimitError } from "@/lib/meta/client";
import { checkPublishingToken } from "@/lib/publishing/api-auth";
import { scheduleReel, ScheduleError } from "@/lib/publishing/schedule";

const NOW = new Date("2026-11-01T12:00:00Z");
const account = { instagramId: "ig-1", accessToken: "enc", provider: "META" };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "pub-1",
    workspaceId: "ws-1",
    instagramAccountId: "acct-1",
    videoUrl: "https://cdn.example.com/v.mp4",
    videoUrlExpiresAt: null,
    caption: "legenda",
    coverUrl: null,
    thumbOffsetMs: null,
    shareToFeed: true,
    trialGraduation: "MANUAL",
    scheduledFor: new Date("2026-11-01T11:59:00Z"),
    status: "SCHEDULED",
    containerId: null,
    attempts: 0,
    instagramAccount: account,
    ...overrides,
  };
}

// findMany is called once per step: due, processing, insights.
function stepRows(due: unknown[], processing: unknown[], insights: unknown[] = []) {
  mockPrisma.reelPublication.findMany
    .mockResolvedValueOnce(due)
    .mockResolvedValueOnce(processing)
    .mockResolvedValueOnce(insights);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.reelPublication.updateMany.mockResolvedValue({ count: 1 });
  mockGetContentPublishingLimit.mockResolvedValue({ quotaUsage: 0, quotaTotal: 100 });
  mockGetMediaPermalink.mockResolvedValue("https://instagram.com/reel/x");
});

describe("buildReelContainerBody", () => {
  it("adds trial_params only for trial reels", () => {
    expect(
      buildReelContainerBody({ videoUrl: "https://v", trialGraduation: "SS_PERFORMANCE" })
    ).toMatchObject({
      media_type: "REELS",
      video_url: "https://v",
      trial_params: { graduation_strategy: "SS_PERFORMANCE" },
    });
    expect(buildReelContainerBody({ videoUrl: "https://v" })).not.toHaveProperty(
      "trial_params"
    );
  });

  it("prefers cover_url over thumb_offset", () => {
    const body = buildReelContainerBody({
      videoUrl: "https://v",
      coverUrl: "https://c.jpg",
      thumbOffsetMs: 1200,
    });
    expect(body.cover_url).toBe("https://c.jpg");
    expect(body).not.toHaveProperty("thumb_offset");
  });
});

describe("processReelPublications: container creation", () => {
  it("creates a container for a due row and moves it to PROCESSING", async () => {
    stepRows([row()], []);
    mockCreateReelContainer.mockResolvedValue({ id: "cont-1" });

    const result = await processReelPublications(NOW);

    expect(mockCreateReelContainer).toHaveBeenCalledWith(
      "plain:enc",
      "ig-1",
      expect.objectContaining({ trialGraduation: "MANUAL" })
    );
    expect(mockPrisma.reelPublication.updateMany).toHaveBeenCalledWith({
      where: { id: "pub-1", status: "CREATING_CONTAINER" },
      data: expect.objectContaining({ status: "PROCESSING", containerId: "cont-1" }),
    });
    expect(result.containersCreated).toBe(1);
  });

  it("does nothing when another sweep already claimed the row", async () => {
    stepRows([row()], []);
    mockPrisma.reelPublication.updateMany.mockImplementation(async (args) =>
      args.where.status === "SCHEDULED" && args.where.id ? { count: 0 } : { count: 1 }
    );

    await processReelPublications(NOW);

    expect(mockCreateReelContainer).not.toHaveBeenCalled();
  });

  it("fails a row whose video URL is about to expire", async () => {
    stepRows([row({ videoUrlExpiresAt: new Date("2026-11-01T12:05:00Z") })], []);

    const result = await processReelPublications(NOW);

    expect(mockCreateReelContainer).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
  });

  it("puts the row back when the publishing quota is used up", async () => {
    stepRows([row()], []);
    mockGetContentPublishingLimit.mockResolvedValue({ quotaUsage: 100, quotaTotal: 100 });

    await processReelPublications(NOW);

    expect(mockCreateReelContainer).not.toHaveBeenCalled();
    expect(mockPrisma.reelPublication.updateMany).toHaveBeenCalledWith({
      where: { id: "pub-1", status: "CREATING_CONTAINER" },
      data: expect.objectContaining({ status: "SCHEDULED" }),
    });
  });

  it("retries on rate limit instead of failing", async () => {
    stepRows([row()], []);
    mockCreateReelContainer.mockRejectedValue(new RateLimitError("slow down"));

    const result = await processReelPublications(NOW);

    expect(result.failed).toBe(0);
    expect(mockPrisma.reelPublication.updateMany).toHaveBeenCalledWith({
      where: { id: "pub-1", status: "CREATING_CONTAINER" },
      data: expect.objectContaining({ status: "SCHEDULED", attempts: 1 }),
    });
  });
});

describe("processReelPublications: publishing", () => {
  const processing = () => row({ status: "PROCESSING", containerId: "cont-1" });

  it("publishes a FINISHED container exactly once", async () => {
    stepRows([], [processing()]);
    mockGetContainerStatus.mockResolvedValue({ status_code: "FINISHED" });
    mockPublishMediaContainer.mockResolvedValue({ id: "media-1" });

    const result = await processReelPublications(NOW);

    expect(mockPublishMediaContainer).toHaveBeenCalledTimes(1);
    expect(mockPublishMediaContainer).toHaveBeenCalledWith("plain:enc", "ig-1", "cont-1");
    expect(mockPrisma.reelPublication.updateMany).toHaveBeenCalledWith({
      where: { id: "pub-1", status: "PUBLISHING" },
      data: expect.objectContaining({ status: "PUBLISHED", mediaId: "media-1" }),
    });
    expect(result.published).toBe(1);
  });

  it("waits while the container is still processing", async () => {
    stepRows([], [processing()]);
    mockGetContainerStatus.mockResolvedValue({ status_code: "IN_PROGRESS" });

    await processReelPublications(NOW);

    expect(mockPublishMediaContainer).not.toHaveBeenCalled();
  });

  it("never republishes a container Meta reports as PUBLISHED", async () => {
    stepRows([], [processing()]);
    mockGetContainerStatus.mockResolvedValue({ status_code: "PUBLISHED" });

    const result = await processReelPublications(NOW);

    expect(mockPublishMediaContainer).not.toHaveBeenCalled();
    expect(result.needsReview).toBe(1);
  });

  it("does not publish when the PUBLISHING claim is lost", async () => {
    stepRows([], [processing()]);
    mockGetContainerStatus.mockResolvedValue({ status_code: "FINISHED" });
    mockPrisma.reelPublication.updateMany.mockImplementation(async (args) =>
      args.data?.status === "PUBLISHING" ? { count: 0 } : { count: 1 }
    );

    await processReelPublications(NOW);

    expect(mockPublishMediaContainer).not.toHaveBeenCalled();
  });

  it("returns a failed publish to PROCESSING so status is re-read first", async () => {
    stepRows([], [processing()]);
    mockGetContainerStatus.mockResolvedValue({ status_code: "FINISHED" });
    mockPublishMediaContainer.mockRejectedValue(new Error("timeout"));

    await processReelPublications(NOW);

    expect(mockPrisma.reelPublication.updateMany).toHaveBeenCalledWith({
      where: { id: "pub-1", status: "PUBLISHING" },
      data: expect.objectContaining({ status: "PROCESSING", lastError: "timeout" }),
    });
  });

  it("fails an ERROR container", async () => {
    stepRows([], [processing()]);
    mockGetContainerStatus.mockResolvedValue({ status_code: "ERROR" });

    const result = await processReelPublications(NOW);

    expect(result.failed).toBe(1);
    expect(mockPublishMediaContainer).not.toHaveBeenCalled();
  });
});

describe("insights", () => {
  it("returns only checkpoints inside their window and not yet collected", () => {
    const published = new Date("2026-11-01T00:00:00Z");
    expect(dueInsightCheckpoints(published, new Date("2026-11-01T23:00:00Z"), [])).toEqual([]);
    expect(dueInsightCheckpoints(published, new Date("2026-11-02T01:00:00Z"), [])).toEqual([24]);
    expect(dueInsightCheckpoints(published, new Date("2026-11-02T01:00:00Z"), [24])).toEqual([]);
    // 24h checkpoint missed by more than the window: skipped, not recorded late.
    expect(dueInsightCheckpoints(published, new Date("2026-11-03T01:00:00Z"), [])).toEqual([48]);
  });

  it("stores a snapshot with skip rate and watch time", async () => {
    stepRows([], [], [
      row({
        status: "PUBLISHED",
        mediaId: "media-1",
        publishedAt: new Date("2026-10-31T11:00:00Z"),
        insightSnapshots: [],
      }),
    ]);
    mockGetMediaInsights.mockResolvedValue({
      views: 900,
      reels_skip_rate: 41.2,
      ig_reels_avg_watch_time: 5400,
    });

    const result = await processReelPublications(NOW);

    expect(mockGetMediaInsights).toHaveBeenCalledWith(
      "plain:enc",
      "media-1",
      expect.arrayContaining(["reels_skip_rate", "ig_reels_avg_watch_time"])
    );
    expect(mockPrisma.reelInsightSnapshot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ hoursAfter: 24 }),
      })
    );
    expect(result.insightsCollected).toBe(1);
  });
});

describe("checkPublishingToken", () => {
  const token = "x".repeat(40);

  it("is closed when no token is configured", () => {
    delete process.env.PUBLISHING_API_TOKEN;
    expect(checkPublishingToken(`Bearer ${token}`)).toBe(503);
  });

  it("accepts only the exact bearer token", () => {
    process.env.PUBLISHING_API_TOKEN = token;
    expect(checkPublishingToken(`Bearer ${token}`)).toBeNull();
    expect(checkPublishingToken(`Bearer ${token}y`)).toBe(401);
    expect(checkPublishingToken(null)).toBe(401);
  });
});

describe("scheduleReel", () => {
  const input = {
    account: "@gteodoro.ia",
    externalId: "md5-abcdef123456",
    videoUrl: "https://cdn.example.com/v.mp4",
    shareToFeed: true,
    trialGraduation: "MANUAL" as const,
  };

  it("returns the existing row for a repeated idempotency key", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "acct-1", workspaceId: "ws-1" });
    mockPrisma.reelPublication.findUnique.mockResolvedValue({ id: "pub-1" });

    const result = await scheduleReel(input, NOW);

    expect(result).toEqual({ publication: { id: "pub-1" }, created: false });
    expect(mockPrisma.reelPublication.create).not.toHaveBeenCalled();
    expect(mockPrisma.instagramAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: "gteodoro.ia", provider: "META" } })
    );
  });

  it("rejects a video URL that expires before the scheduled time", async () => {
    mockPrisma.instagramAccount.findFirst.mockResolvedValue({ id: "acct-1", workspaceId: "ws-1" });

    await expect(
      scheduleReel(
        {
          ...input,
          scheduledFor: "2026-11-05T12:00:00Z",
          videoUrlExpiresAt: "2026-11-02T12:00:00Z",
        },
        NOW
      )
    ).rejects.toBeInstanceOf(ScheduleError);
  });
});
