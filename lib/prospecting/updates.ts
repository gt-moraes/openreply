import type { InstagramConversation } from "@/lib/meta/client";
import { ProspectingReadError, PROSPECTING_USERNAME } from "./read";
import type { ProspectingScope } from "./service";

export function selectProspectingUpdates(body: unknown, scope: ProspectingScope, instagramId: string, rows: InstagramConversation[]) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("handles" in body) || !Array.isArray(body.handles) || body.handles.length > 100 || body.handles.some(h => typeof h !== "string" || !scope.allowedHandles.has(h))) throw new ProspectingReadError(403, "Only allowed prospects may be monitored.");
  const handles: string[] = [...new Set(body.handles)];
  const conversations = handles.flatMap(handle => {
    const matches = rows.filter(row => {
      const p = row.participants?.data ?? [];
      return !row.detailsUnavailable && p.length === 2 && p.some(v => v.id === instagramId) && p.some(v => v.id && v.id !== instagramId && v.username?.replace(/^@/, "").toLowerCase() === handle);
    });
    if (matches.length !== 1) return [];
    const row = matches[0];
    const binding=scope.enrollments?.get(handle);
    if(binding&&(row.id!==binding.conversationId||!row.updated_time||Date.parse(row.updated_time)<binding.contactedAt.getTime()))return [];
    if (!row.id || !row.updated_time || !Number.isFinite(Date.parse(row.updated_time))) return [];
    return [{ handle, conversationId: row.id, updatedAt: new Date(row.updated_time).toISOString() }];
  });
  return { account: PROSPECTING_USERNAME, observedAt: new Date().toISOString(), limited: true, conversations };
}
