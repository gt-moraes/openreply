import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { createInstagramContext } from "@/lib/instagram/context";
import { discoverProspectingConversations, readProspectingMessages } from "@/lib/prospecting/meta-read";
import { authorizeProspecting, readProspectingThread, ProspectingReadError } from "@/lib/prospecting/read";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

// POST carries a read selector in the body, avoiding prospect handles in URL logs.
// This route never sends a message or changes an automation.
export async function POST(request: Request) {
  try {
    const scope = authorizeProspecting(request.headers.get("authorization"));
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      throw new ProspectingReadError(415, "JSON required.");
    }
    const reader = request.body?.getReader();
    if (!reader) throw new ProspectingReadError(400, "JSON required.");
    let text = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 512) {
          await reader.cancel();
          throw new ProspectingReadError(413, "Request too large.");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    let body;
    try { body = JSON.parse(text); }
    catch { throw new ProspectingReadError(400, "Invalid JSON."); }
    const data = await readProspectingThread(body, scope, {
      findAccount: (id, workspaceId) => prisma.instagramAccount.findFirst({ where: { id, workspaceId } }),
      conversations: async account => {
        const stored = await prisma.instagramAccount.findFirst({ where: { id: account.id, workspaceId: account.workspaceId, instagramId: account.instagramId, username: "gteodoro.ia", provider: "META" } });
        if (!stored) throw new ProspectingReadError(503, "Account changed.");
        const context = await createInstagramContext(stored);
        if (context.provider !== "META") throw new ProspectingReadError(503, "Meta required.");
        return discoverProspectingConversations(context.accessToken, stored.instagramId);
      },
      messages: async (account, conversationId) => {
        const stored = await prisma.instagramAccount.findFirst({ where: { id: account.id, workspaceId: account.workspaceId, instagramId: account.instagramId, username: "gteodoro.ia", provider: "META" } });
        if (!stored) throw new ProspectingReadError(503, "Account changed.");
        const context = await createInstagramContext(stored);
        if (context.provider !== "META") throw new ProspectingReadError(503, "Meta required.");
        return readProspectingMessages(context.accessToken, conversationId);
      },
    });
    return NextResponse.json({ success: true, data }, { headers });
  } catch (error) {
    const known = error instanceof ProspectingReadError;
    // Provider exceptions may contain URLs or tokens. Do not serialize or log them.
    return NextResponse.json({ success: false, error: known ? error.message : "Instagram read failed." }, { status: known ? error.status : 502, headers });
  }
}
