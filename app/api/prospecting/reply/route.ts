import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { getMetaGraphApiVersion } from "@/lib/env";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { ProspectingReadError, readProspectingThread } from "@/lib/prospecting/read";
import { discoverProspectingConversations, readProspectingMessages } from "@/lib/prospecting/meta-read";
import { authorizeReply, executeProspectingReply, validateReplyCommand } from "@/lib/prospecting/reply";
import { privateHeaders, privateJson, scopedMeta } from "@/lib/prospecting/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const scope = authorizeReply(request.headers.get("authorization"));
    const command = validateReplyCommand(await privateJson(request), scope.allowedHandles, process.env.PROSPECTING_WHATSAPP_URL);
    const { account, accessToken } = await scopedMeta(scope);
    let discoveryCache: Awaited<ReturnType<typeof discoverProspectingConversations>> | null = null;
    const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
    const data = await executeProspectingReply(command, {
      instagramId: account.instagramId,
      findClaim: id => prisma.prospectingReply.findUnique({ where: { id } }),
      claim: async (id, textHash, c) => prisma.$transaction(async tx => {
        const locks = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext(${`prospecting:${account.instagramId}`})) AS locked`;
        if (!locks[0]?.locked) throw new ProspectingReadError(409, "Another reply reservation is running.");
        if (await tx.prospectingReply.findUnique({ where: { id } })) throw new ProspectingReadError(409, "Reply already reserved.");
        const last = await tx.prospectingReply.findFirst({ where: { instagramId: account.instagramId }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
        if (last && Date.now() - last.createdAt.getTime() < 300000) throw new ProspectingReadError(429, "Wait five minutes between reply reservations.");
        if (await tx.prospectingReply.count({ where: { instagramId: account.instagramId, dayKey } }) >= 30) throw new ProspectingReadError(429, "Daily reply limit reached.");
        return tx.prospectingReply.create({ data: { id, instagramId: account.instagramId, conversationId: c.conversationId, inboundMessageId: c.inboundMessageId, textHash, status: "SENDING", dayKey } });
      }),
      settle: async (id, status, messageId, errorCode) => {
        const result = await prisma.prospectingReply.updateMany({ where: { id, status: "SENDING" }, data: { status, messageId, errorCode } });
        if (result.count !== 1) throw new ProspectingReadError(409, "Reply state requires review.");
      },
      load: async handle => {
        const rows = discoveryCache ?? (discoveryCache = await discoverProspectingConversations(accessToken, account.instagramId));
        const thread = await readProspectingThread({ handle }, scope, {
          findAccount: async () => account,
          conversations: async () => rows,
          messages: async (_account, id) => readProspectingMessages(accessToken, id),
        });
        const row = rows.find(c => c.id === thread.conversationId);
        const recipientId = row?.participants?.data.find(p => p.id !== account.instagramId)?.id ?? "";
        return { thread, recipientId };
      },
      conflicts: async text => {
        const automations = await prisma.automation.findMany({ where: { instagramAccountId: account.id, workspaceId: account.workspaceId, isActive: true, dmTriggerEnabled: true }, select: { matchAnyWord: true, keywords: true, wholeWordMatch: true } });
        return automations.some(a => a.matchAnyWord || matchKeywords(text, a.keywords, a.wholeWordMatch).matched);
      },
      send: async (recipientId, text) => {
        const url = new URL(`https://graph.instagram.com/${getMetaGraphApiVersion()}/${encodeURIComponent(account.instagramId)}/messages`);
        const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }) });
        if (!response.ok) throw new Error("Provider rejected or outcome unknown.");
        const result = await response.json();
        if (typeof result.message_id !== "string" || !result.message_id || result.recipient_id !== recipientId) throw new Error("Send acknowledgement unavailable.");
        return { messageId: result.message_id };
      },
    });
    return NextResponse.json({ success: true, data: { account: account.username, ...data } }, { headers: privateHeaders });
  } catch (error) {
    const known = error instanceof ProspectingReadError;
    return NextResponse.json({ success: false, error: known ? error.message : "Reply failed; check the journal before any retry." }, { status: known ? error.status : 502, headers: privateHeaders });
  }
}
