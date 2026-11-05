import { createHash, timingSafeEqual } from "node:crypto";
import type { InstagramConversation, InstagramMessage } from "@/lib/meta/client";

type Account = { id: string; workspaceId: string; username: string; instagramId: string; provider: string };
type Dependencies = {
  findAccount: (id: string, workspaceId: string) => Promise<Account | null>;
  conversations: (account: Account) => Promise<InstagramConversation[]>;
  messages: (account: Account, conversationId: string) => Promise<InstagramMessage[]>;
};

export class ProspectingReadError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const PROSPECTING_USERNAME = "eugteodoro";

const normalize = (value: string) => value.replace(/^@/, "").toLowerCase();
const handlePattern = /^[a-z0-9._]{1,30}$/;
const denied = new Set(["nutribrunanogs", "levonshape", "renanjacobi", "gteodoro.ia", PROSPECTING_USERNAME]);
const digest = (value: string) => createHash("sha256").update(value).digest();

// Dedicated read-only credential. Never accept publishing tokens or browser cookies.
export function authorizeProspecting(authorization: string | null, env: Record<string, string | undefined> = process.env) {
  const token = env.PROSPECTING_API_TOKEN ?? "";
  const accountId = env.PROSPECTING_ACCOUNT_ID ?? "";
  const workspaceId = env.PROSPECTING_WORKSPACE_ID ?? "";
  const handles = (env.PROSPECTING_ALLOWED_HANDLES ?? "").split(",").map(v => normalize(v.trim()));
  if (token.length < 32 || token.length > 512 || !accountId || !workspaceId || !handles.length || handles.length > 100 || handles.some(h => !handlePattern.test(h) || denied.has(h))) {
    throw new ProspectingReadError(503, "Prospecting reader is not configured.");
  }
  if (!authorization || authorization.length > 520 || !authorization.startsWith("Bearer ") || !timingSafeEqual(digest(authorization.slice(7)), digest(token))) {
    throw new ProspectingReadError(401, "Unauthorized");
  }
  return { accountId, workspaceId, allowedHandles: new Set(handles) };
}

export async function readProspectingThread(
  body: unknown,
  scope: ReturnType<typeof authorizeProspecting>,
  deps: Dependencies,
) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("handle" in body) || typeof body.handle !== "string") {
    throw new ProspectingReadError(400, "Provide only a prospect handle.");
  }
  const handle = normalize(body.handle);
  if (!handlePattern.test(handle) || denied.has(handle) || !scope.allowedHandles.has(handle)) {
    throw new ProspectingReadError(403, "Prospect is not allowed.");
  }
  const account = await deps.findAccount(scope.accountId, scope.workspaceId);
  if (!account || account.id !== scope.accountId || account.workspaceId !== scope.workspaceId || account.username !== PROSPECTING_USERNAME || account.provider !== "META" || !account.instagramId) {
    throw new ProspectingReadError(503, "Expected Meta account is unavailable.");
  }
  const conversations = await deps.conversations(account);
  const matches = conversations.filter(c => {
    const p = c.participants?.data ?? [];
    return !c.detailsUnavailable && p.length === 2 && p.some(v => v.id === account.instagramId) && p.some(v => v.id && v.id !== account.instagramId && normalize(v.username ?? "") === handle);
  });
  if (matches.length !== 1) {
    throw new ProspectingReadError(409, "A unique recent conversation could not be confirmed.");
  }
  const conversation = matches[0];
  const contact = conversation.participants!.data.find(p => p.id !== account.instagramId)!;
  const raw = await deps.messages(account, conversation.id);
  const seen = new Set<string>();
  const messages = raw.slice(0, 40).map(message => {
    if (!message.id || seen.has(message.id)) throw new ProspectingReadError(502, "Message identity could not be confirmed.");
    seen.add(message.id);
    const author = message.from?.id === account.instagramId ? "self" : message.from?.id === contact.id ? "lead" : "unknown";
    const text = message.message ?? "";
    return {
      id: message.id, author, authorConfirmed: author !== "unknown",
      text: text.slice(0, 4000), truncated: text.length > 4000,
      createdAt: message.created_time && Number.isFinite(Date.parse(message.created_time)) ? new Date(message.created_time).toISOString() : null,
    };
  }).reverse();
  return {
    account: PROSPECTING_USERNAME, handle, conversationId: conversation.id,
    source: "instagram_api", observedAt: new Date().toISOString(),
    limited: true, directionKnown: messages.every(m => m.authorConfirmed),
    messages, messagesSent: 0,
  };
}
