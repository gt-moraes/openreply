-- Additive, independent journal. Reconnecting an Instagram account must not erase it.
CREATE TABLE "ProspectingReply" (
    "id" TEXT NOT NULL,
    "instagramId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "inboundMessageId" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "messageId" TEXT,
    "errorCode" TEXT,
    "dayKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProspectingReply_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProspectingReply_inbound_key" ON "ProspectingReply"("instagramId", "conversationId", "inboundMessageId");
CREATE INDEX "ProspectingReply_day_key" ON "ProspectingReply"("instagramId", "dayKey");
