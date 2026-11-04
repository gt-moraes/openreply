-- CreateEnum
CREATE TYPE "ReelPublicationStatus" AS ENUM ('SCHEDULED', 'CREATING_CONTAINER', 'PROCESSING', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'NEEDS_REVIEW', 'CANCELED');

-- CreateEnum
CREATE TYPE "ReelTrialGraduation" AS ENUM ('MANUAL', 'SS_PERFORMANCE');

-- CreateTable
CREATE TABLE "ReelPublication" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "label" TEXT,
    "videoUrl" TEXT NOT NULL,
    "videoUrlExpiresAt" TIMESTAMP(3),
    "caption" TEXT,
    "coverUrl" TEXT,
    "thumbOffsetMs" INTEGER,
    "shareToFeed" BOOLEAN NOT NULL DEFAULT true,
    "trialGraduation" "ReelTrialGraduation",
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "ReelPublicationStatus" NOT NULL DEFAULT 'SCHEDULED',
    "containerId" TEXT,
    "mediaId" TEXT,
    "permalink" TEXT,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReelPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReelInsightSnapshot" (
    "id" TEXT NOT NULL,
    "publicationId" TEXT NOT NULL,
    "hoursAfter" INTEGER NOT NULL,
    "metrics" JSONB NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReelInsightSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReelPublication_instagramAccountId_externalId_key" ON "ReelPublication"("instagramAccountId", "externalId");

-- CreateIndex
CREATE INDEX "ReelPublication_status_scheduledFor_idx" ON "ReelPublication"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "ReelPublication_workspaceId_createdAt_idx" ON "ReelPublication"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReelInsightSnapshot_publicationId_hoursAfter_key" ON "ReelInsightSnapshot"("publicationId", "hoursAfter");

-- AddForeignKey
ALTER TABLE "ReelPublication" ADD CONSTRAINT "ReelPublication_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReelPublication" ADD CONSTRAINT "ReelPublication_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReelInsightSnapshot" ADD CONSTRAINT "ReelInsightSnapshot_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "ReelPublication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
