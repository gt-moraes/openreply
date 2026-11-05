import { prisma } from "@/lib/db/client";
import { createInstagramContext } from "@/lib/instagram/context";
import { ProspectingReadError, PROSPECTING_USERNAME, type authorizeProspecting } from "./read";

export type ProspectingScope = ReturnType<typeof authorizeProspecting>;
export const privateHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export async function scopedMeta(scope: ProspectingScope) {
  const account = await prisma.instagramAccount.findFirst({ where: { id: scope.accountId, workspaceId: scope.workspaceId } });
  if (!account || account.username !== PROSPECTING_USERNAME || account.provider !== "META" || !account.instagramId) throw new ProspectingReadError(503, "Expected account unavailable.");
  const context = await createInstagramContext(account);
  if (context.provider !== "META") throw new ProspectingReadError(503, "Meta required.");
  return { account, accessToken: context.accessToken };
}

export async function privateJson(request: Request, limit = 8192): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ProspectingReadError(415, "JSON required.");
  const reader = request.body?.getReader();
  if (!reader) throw new ProspectingReadError(400, "JSON required.");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new ProspectingReadError(413, "Request too large."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ProspectingReadError(400, "Invalid JSON."); }
}
