import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { authorizeProspecting, ProspectingReadError } from "@/lib/prospecting/read";
import { discoverProspectingConversations } from "@/lib/prospecting/meta-read";
import { privateHeaders, privateJson, scopedMeta } from "@/lib/prospecting/service";
import { selectProspectingUpdates } from "@/lib/prospecting/updates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export async function POST(request: Request) {
  try {
    const scope = authorizeProspecting(request.headers.get("authorization"));
    const body = await privateJson(request);
    // Validate before any provider call; an empty discovery suffices for validation.
    selectProspectingUpdates(body, scope, "validation", []);
    const { account, accessToken } = await scopedMeta(scope);
    // Metadata polling also proves the durable send journal exists in this deployment's DB.
    await prisma.prospectingReply.count({ where: { instagramId: account.instagramId, dayKey: "readiness-probe" } });
    const rows = await discoverProspectingConversations(accessToken, account.instagramId);
    return NextResponse.json({ success: true, data: { ...selectProspectingUpdates(body, scope, account.instagramId, rows), replyJournalReady: true, repliesEnabled: process.env.PROSPECTING_REPLIES_ENABLED === "true" } }, { headers: privateHeaders });
  } catch (error) {
    const known = error instanceof ProspectingReadError;
    return NextResponse.json({ success: false, error: known ? error.message : "Instagram updates unavailable." }, { status: known ? error.status : 502, headers: privateHeaders });
  }
}
