import { createHash, timingSafeEqual } from "node:crypto";
import { authorizeProspecting, ProspectingReadError, type readProspectingThread } from "./read";

export type Thread = Awaited<ReturnType<typeof readProspectingThread>>;
export type ReplyClaim = { id: string; textHash: string; status: string; messageId: string | null };
export type ReplyCommand = { handle: string; conversationId: string; inboundMessageId: string; fingerprint: string; text: string; kind: "continue" | "handoff" };
export const threadFingerprint = (c: Thread) => createHash("sha256").update(JSON.stringify({ account: c.account, handle: c.handle, conversationId: c.conversationId, messages: c.messages })).digest("hex");
const digest = (s: string) => createHash("sha256").update(s).digest();

export function authorizeReply(authorization: string | null, env: Record<string, string | undefined> = process.env) {
  const scope = authorizeProspecting(`Bearer ${env.PROSPECTING_API_TOKEN ?? ""}`, env);
  const token = env.PROSPECTING_REPLY_TOKEN ?? "";
  if (token.length < 32 || token.length > 512 || token === env.PROSPECTING_API_TOKEN) throw new ProspectingReadError(503, "A separate reply credential is required.");
  if (!authorization || authorization.length > 520 || !authorization.startsWith("Bearer ") || !timingSafeEqual(digest(authorization.slice(7)), digest(token))) throw new ProspectingReadError(401, "Unauthorized");
  if (env.PROSPECTING_REPLIES_ENABLED !== "true") throw new ProspectingReadError(503, "Automatic replies are disabled.");
  return scope;
}

export function validateReplyCommand(body: unknown, allowed: Set<string>, whatsappUrl: string | undefined): ReplyCommand {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProspectingReadError(400, "Invalid reply command.");
  const c = body as ReplyCommand;
  if (Object.keys(c).sort().join(",") !== "conversationId,fingerprint,handle,inboundMessageId,kind,text" || !allowed.has(c.handle) || !["continue", "handoff"].includes(c.kind) || ![c.conversationId, c.inboundMessageId].every(s => typeof s === "string" && s.length > 0 && s.length <= 512) || typeof c.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(c.fingerprint) || typeof c.text !== "string" || !c.text.trim() || Buffer.byteLength(c.text, "utf8") > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(c.text) || (c.text.match(/\?/g) ?? []).length > 1) throw new ProspectingReadError(400, "Invalid reply command.");
  if (c.kind === "handoff") {
    const expected = `Podemos continuar pelo WhatsApp? Me passa teu número que eu te chamo por lá ou me manda um oi pelo link abaixo que a gente continua:\n\n${whatsappUrl}`;
    if (!whatsappUrl || !/^https:\/\/wa\.me\/[1-9][0-9]{7,14}$/.test(whatsappUrl) || c.text !== expected) throw new ProspectingReadError(400, "Only the approved WhatsApp invitation is allowed.");
  } else if (/https?:\/\/|www\.|wa\.me|R\$|US\$|\$\s*\d|\b(?:BRL|USD|reais)\b/i.test(c.text)) throw new ProspectingReadError(400, "Prices and links are not allowed in continuation replies.");
  return c;
}

export async function executeProspectingReply(command: ReplyCommand, deps: {
  instagramId: string;
  findClaim: (id: string) => Promise<ReplyClaim | null>;
  claim: (id: string, textHash: string, command: ReplyCommand) => Promise<ReplyClaim>;
  settle: (id: string, status: string, messageId: string | null, reason: string | null) => Promise<void>;
  load: (handle: string) => Promise<{ thread: Thread; recipientId: string }>;
  conflicts: (text: string) => Promise<boolean>;
  send: (recipient: string, text: string) => Promise<{ messageId: string }>;
  now?: () => number;
}) {
  const id = createHash("sha256").update(JSON.stringify([deps.instagramId, command.conversationId, command.inboundMessageId])).digest("hex");
  const textHash = createHash("sha256").update(command.text).digest("hex");
  const previous = await deps.findClaim(id);
  if (previous) {
    if (previous.textHash === textHash && previous.status === "CONFIRMED" && previous.messageId) return { operationId: id, messageId: previous.messageId, duplicate: true };
    throw new ProspectingReadError(409, "Reply already claimed; do not retry.");
  }
  const { thread, recipientId } = await deps.load(command.handle);
  const last = thread.messages.at(-1);
  const now = (deps.now ?? Date.now)();
  const at = last?.createdAt ? Date.parse(last.createdAt) : NaN;
  if (thread.conversationId !== command.conversationId || thread.handle !== command.handle || threadFingerprint(thread) !== command.fingerprint || !last || last.id !== command.inboundMessageId || last.author !== "lead" || !last.authorConfirmed || !last.text.trim() || thread.messages.some(m => !m.authorConfirmed || m.truncated) || !recipientId) throw new ProspectingReadError(409, "Conversation changed or sender is unconfirmed.");
  if (!Number.isFinite(at) || at > now || now - at >= 86400000 - 60000) throw new ProspectingReadError(409, "Reply window is closed.");
  const latestSelf = thread.messages.map(m => m.author).lastIndexOf("self");
  const inboundBurst = thread.messages.slice(latestSelf + 1).filter(m => m.author === "lead").map(m => m.text).join("\n");
  if (/\b(?:n[aã]o (?:tenho interesse|me (?:chame|mande|envie)|quero (?:receber|mensagens|contato))|pare de (?:mandar|enviar)|retire meu contato)\b/iu.test(inboundBurst)) throw new ProspectingReadError(409, "Opt-out; no reply allowed.");
  if (await deps.conflicts(inboundBurst)) throw new ProspectingReadError(409, "An existing messaging automation owns this interaction.");
  // Durable reservation precedes the only call that can send. A crash leaves it claimed.
  const claimed = await deps.claim(id, textHash, command);
  if (claimed.status !== "SENDING") throw new ProspectingReadError(409, "Reply not reserved.");
  let finalContext;
  try { finalContext = await deps.load(command.handle); }
  catch {
    await deps.settle(id, "CANCELED", null, "final_context_unavailable");
    throw new ProspectingReadError(409, "Final context unavailable; no message sent.");
  }
  if (threadFingerprint(finalContext.thread) !== command.fingerprint || finalContext.recipientId !== recipientId) {
    await deps.settle(id, "CANCELED", null, "context_changed_before_send");
    throw new ProspectingReadError(409, "Context changed before send; no message sent.");
  }
  const finalNow = (deps.now ?? Date.now)();
  if (at > finalNow || finalNow - at >= 86400000 - 60000) {
    await deps.settle(id, "CANCELED", null, "window_closed_before_send");
    throw new ProspectingReadError(409, "Reply window closed before send.");
  }
  let sent;
  try { sent = await deps.send(recipientId, command.text); }
  catch {
    await deps.settle(id, "UNCERTAIN", null, "transport_or_ack_failure");
    throw new ProspectingReadError(409, "Reply outcome uncertain; do not retry.");
  }
  if (!sent.messageId) {
    await deps.settle(id, "UNCERTAIN", null, "ack_missing");
    throw new ProspectingReadError(409, "Reply outcome uncertain; do not retry.");
  }
  await deps.settle(id, "CONFIRMED", sent.messageId, null);
  return { operationId: id, messageId: sent.messageId, duplicate: false };
}
