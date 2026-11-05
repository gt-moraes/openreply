import { describe, it, expect, vi } from "vitest";
import { authorizeReply, executeProspectingReply, threadFingerprint, validateReplyCommand, type ReplyClaim, type Thread } from "@/lib/prospecting/reply";
import { selectProspectingUpdates } from "@/lib/prospecting/updates";

const env = { PROSPECTING_API_TOKEN: "read-token-" + "r".repeat(40), PROSPECTING_REPLY_TOKEN: "reply-token-" + "w".repeat(40), PROSPECTING_REPLIES_ENABLED: "true", PROSPECTING_ACCOUNT_ID: "a", PROSPECTING_WORKSPACE_ID: "w", PROSPECTING_ALLOWED_HANDLES: "nutri.fixture" };
const scope = () => authorizeReply(`Bearer ${env.PROSPECTING_REPLY_TOKEN}`, env);
const stamp = Date.parse("2026-11-05T14:00:00Z");
const thread = (): Thread => ({ account: "eugteodoro", handle: "nutri.fixture", conversationId: "c", source: "instagram_api", observedAt: new Date(stamp).toISOString(), limited: true, directionKnown: true, messagesSent: 0, messages: [{ id: "inbound", author: "lead", authorConfirmed: true, text: "Levo três horas editando.", truncated: false, createdAt: new Date(stamp - 60000).toISOString() }] });
function fixture() {
  const rows = new Map<string, ReplyClaim>(); let current = thread(); let sent = 0;
  const command = { handle: "nutri.fixture", conversationId: "c", inboundMessageId: "inbound", fingerprint: threadFingerprint(current), text: "E o que mudaria na tua rotina?", kind: "continue" as const };
  const deps = {
    instagramId: "self", now: () => stamp,
    findClaim: async (id: string) => rows.get(id) ?? null,
    claim: vi.fn(async (id: string, textHash: string) => { if (rows.has(id)) throw Error("duplicate"); const row = { id, textHash, status: "SENDING", messageId: null }; rows.set(id, row); return row; }),
    settle: vi.fn(async (id: string, status: string, messageId: string | null) => { rows.set(id, { ...rows.get(id)!, status, messageId }); }),
    load: vi.fn(async () => ({ thread: current, recipientId: "lead-id" })),
    conflicts: vi.fn(async () => false),
    send: vi.fn(async () => { sent++; return { messageId: "sent-1" }; }),
  };
  return { rows, command, deps, change: (c: Thread) => { current = c; }, sent: () => sent };
}

describe("dedicated reply boundary", () => {
  it("requires the new credential and explicit feature enablement", () => {
    expect(() => authorizeReply(`Bearer ${env.PROSPECTING_API_TOKEN}`, env)).toThrow("Unauthorized");
    expect(() => authorizeReply(`Bearer ${env.PROSPECTING_REPLY_TOKEN}`, { ...env, PROSPECTING_REPLIES_ENABLED: "false" })).toThrow("disabled");
    expect(scope().allowedHandles.has("nutri.fixture")).toBe(true);
    expect(() => authorizeReply(`Bearer ${env.PROSPECTING_API_TOKEN}`, { ...env, PROSPECTING_REPLY_TOKEN: env.PROSPECTING_API_TOKEN })).toThrow("separate");
  });
  it("allows the exact approved handoff only, bounded text and one question", () => {
    const { command } = fixture();
    expect(validateReplyCommand(command, scope().allowedHandles, undefined)).toEqual(command);
    for (const change of [{ handle: "renanjacobi" }, { text: "Qual? Quando?" }, { text: "R$ 100" }, { text: "https://foreign.test" }, { text: "á".repeat(501) }, { recipientId: "foreign" }]) expect(() => validateReplyCommand({ ...command, ...change }, scope().allowedHandles, undefined)).toThrow();
    const url = "https://wa.me/5511999999999";
    const handoff = { ...command, kind: "handoff", text: `Podemos continuar pelo WhatsApp? Me passa teu número que eu te chamo por lá ou me manda um oi pelo link abaixo que a gente continua:\n\n${url}` };
    expect(validateReplyCommand(handoff, scope().allowedHandles, url).kind).toBe("handoff");
    expect(() => validateReplyCommand({ ...handoff, text: handoff.text + " outro" }, scope().allowedHandles, url)).toThrow();
  });
});

describe("durable one-shot reply", () => {
  it("confirms once and returns the same acknowledgement on a duplicate request", async () => {
    const f = fixture(); const first = await executeProspectingReply(f.command, f.deps);
    const second = await executeProspectingReply(f.command, f.deps);
    expect(first.messageId).toBe("sent-1"); expect(second.duplicate).toBe(true); expect(f.sent()).toBe(1);
    expect(f.deps.load).toHaveBeenCalledTimes(2);
  });
  it("parallel requests cannot send twice", async () => {
    const f = fixture(); const results = await Promise.allSettled([executeProspectingReply(f.command, f.deps), executeProspectingReply(f.command, f.deps)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(f.sent()).toBe(1);
  });
  it("refuses expired, missing, future, own or unknown inbound context without claiming", async () => {
    for (const change of [{ createdAt: new Date(stamp - 86400000).toISOString() }, { createdAt: null }, { createdAt: new Date(stamp + 1000).toISOString() }, { author: "self" }, { author: "unknown", authorConfirmed: false }, { truncated: true }]) {
      const f = fixture(), c = thread(); Object.assign(c.messages[0], change); f.change(c); f.command.fingerprint = threadFingerprint(c);
      await expect(executeProspectingReply(f.command, f.deps)).rejects.toThrow(); expect(f.sent()).toBe(0); expect(f.deps.claim).not.toHaveBeenCalled();
    }
  });
  it("denies changed context, opt-out and conflicts with existing automations", async () => {
    for (const mode of ["context", "optout", "conflict"]) {
      const f = fixture();
      if (mode === "context") { const c = thread(); c.messages[0].text = "Mudou"; f.change(c); }
      if (mode === "optout") { const c = thread(); c.messages[0].text = "Não tenho interesse"; f.change(c); f.command.fingerprint = threadFingerprint(c); }
      if (mode === "conflict") f.deps.conflicts.mockResolvedValue(true);
      await expect(executeProspectingReply(f.command, f.deps)).rejects.toThrow(); expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.sent()).toBe(0);
    }
  });
  it("cancels if context changes after the reservation and before send", async () => {
    const f = fixture(); let reads = 0;
    f.deps.load.mockImplementation(async () => { const c = thread(); if (++reads === 2) c.messages[0].text = "Nova resposta"; return { thread: c, recipientId: "lead-id" }; });
    await expect(executeProspectingReply(f.command, f.deps)).rejects.toThrow("Context changed");
    expect([...f.rows.values()][0].status).toBe("CANCELED"); expect(f.sent()).toBe(0);
  });
  it("lost transport is uncertain and cannot be retried", async () => {
    const f = fixture(); f.deps.send.mockRejectedValue(new Error("secret token must not escape"));
    await expect(executeProspectingReply(f.command, f.deps)).rejects.toThrow("uncertain");
    expect([...f.rows.values()][0].status).toBe("UNCERTAIN");
    await expect(executeProspectingReply(f.command, f.deps)).rejects.toThrow("already claimed"); expect(f.deps.send).toHaveBeenCalledTimes(1);
  });
  it("failure saving acknowledgement leaves the durable claim and never repeats", async () => {
    const f = fixture(); f.deps.settle.mockRejectedValue(new Error("storage down"));
    await expect(executeProspectingReply(f.command, f.deps)).rejects.toThrow(); expect(f.sent()).toBe(1);
    expect([...f.rows.values()][0].status).toBe("SENDING");
    await expect(executeProspectingReply(f.command, f.deps)).rejects.toThrow("already claimed"); expect(f.sent()).toBe(1);
  });
  it("opt-out anywhere in the inbound burst blocks the reply", async () => {
    const f = fixture(), c = thread();
    c.messages.unshift({ ...c.messages[0], id: "stop-first", text: "Não tenho interesse" });
    c.messages[1].text = "Obrigado"; f.change(c); f.command.fingerprint = threadFingerprint(c);
    await expect(executeProspectingReply(f.command, f.deps)).rejects.toThrow("Opt-out");
    expect(f.deps.claim).not.toHaveBeenCalled(); expect(f.sent()).toBe(0);
  });
  it("expiry during the final read cancels the reservation without sending", async () => {
    const f = fixture(); let calls = 0;
    f.deps.now = () => ++calls === 1 ? stamp : stamp + 86400000;
    await expect(executeProspectingReply(f.command, f.deps)).rejects.toThrow("window closed before send");
    expect([...f.rows.values()][0].status).toBe("CANCELED"); expect(f.sent()).toBe(0);
  });
});

it("metadata discovery returns only allowed identities and timestamps, never previews", () => {
  const rows = [{ id: "c", updated_time: new Date(stamp).toISOString(), participants: { data: [{ id: "self" }, { id: "lead", username: "nutri.fixture" }] }, messages: { data: [{ id: "m", message: "private preview" }] } }, { id: "personal", participants: { data: [{ id: "self" }, { id: "other", username: "personal.friend" }] } }];
  const result = selectProspectingUpdates({ handles: ["nutri.fixture"] }, scope(), "self", rows);
  expect(result.conversations).toHaveLength(1); expect(JSON.stringify(result)).not.toContain("private preview"); expect(JSON.stringify(result)).not.toContain("personal.friend");
  expect(() => selectProspectingUpdates({ handles: ["personal.friend"] }, scope(), "self", rows)).toThrow();
});
