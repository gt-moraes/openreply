import { getMetaGraphApiVersion } from "@/lib/env";
import type { InstagramConversation, InstagramMessage } from "@/lib/meta/client";

async function readGraph<T>(accessToken: string, objectId: string, fields: string, discovery: boolean): Promise<T> {
  const path = `${encodeURIComponent(objectId)}${discovery ? "/conversations" : ""}`;
  const url = new URL(`https://graph.instagram.com/${getMetaGraphApiVersion()}/${path}`);
  url.searchParams.set("fields", fields);
  if (discovery) { url.searchParams.set("platform", "instagram"); url.searchParams.set("limit", "50"); }
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Instagram read failed.");
  const data = await response.json();
  if (data.error) throw new Error("Instagram read failed.");
  return data;
}

// Discover identities only. Never request previews from unrelated conversations.
export async function discoverProspectingConversations(accessToken: string, instagramId: string): Promise<InstagramConversation[]> {
  const page = await readGraph<{data?: InstagramConversation[]}>(accessToken, instagramId, "id,participants,updated_time", true);
  if (!Array.isArray(page.data)) throw new Error("Instagram discovery unavailable.");
  return page.data.slice(0, 50).map(c => ({ id: c.id, participants: c.participants, updated_time: c.updated_time }));
}

export async function readProspectingMessages(accessToken: string, conversationId: string): Promise<InstagramMessage[]> {
  const page = await readGraph<{messages?: {data?: InstagramMessage[]}}>(accessToken, conversationId, "messages.limit(20){id,created_time,from,message}", false);
  if (!Array.isArray(page.messages?.data)) throw new Error("Instagram message history unavailable.");
  return page.messages.data;
}
