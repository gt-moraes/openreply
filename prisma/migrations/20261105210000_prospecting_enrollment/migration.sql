CREATE TABLE "ProspectingEnrollment" (
 "id" TEXT NOT NULL PRIMARY KEY, "instagramId" TEXT NOT NULL, "workspaceId" TEXT NOT NULL,
 "handle" TEXT NOT NULL, "campaignId" TEXT NOT NULL, "conversationId" TEXT NOT NULL,
 "openingMessageId" TEXT NOT NULL, "openingHash" TEXT NOT NULL,
 "contactedAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ProspectingEnrollment_instagramId_handle_key" ON "ProspectingEnrollment"("instagramId","handle");
CREATE UNIQUE INDEX "ProspectingEnrollment_instagramId_conversationId_key" ON "ProspectingEnrollment"("instagramId","conversationId");
