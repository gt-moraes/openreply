import { describe, it, expect, vi, beforeEach } from "vitest";
import { authorizeProspecting, readProspectingThread } from "@/lib/prospecting/read";

const env = { PROSPECTING_API_TOKEN: "fictitious-read-only-token-12345678901234567890", PROSPECTING_ACCOUNT_ID: "account", PROSPECTING_WORKSPACE_ID: "workspace", PROSPECTING_ALLOWED_HANDLES: "nutri.fixture" };
const account = { id: "account", workspaceId: "workspace", username: "eugteodoro", instagramId: "self", provider: "META" };
const thread = { id: "conversation", participants: { data: [{ id: "self" }, { id: "lead", username: "nutri.fixture" }] } };
const scope = () => authorizeProspecting(`Bearer ${env.PROSPECTING_API_TOKEN}`, env);
const deps = () => ({
  findAccount: vi.fn().mockResolvedValue(account),
  conversations: vi.fn().mockResolvedValue([thread]),
  messages: vi.fn().mockResolvedValue([
    { id: "new", message: "Quero ganhar tempo", from: { id: "lead" }, created_time: "2026-11-03T12:00:00Z" },
    { id: "old", message: "O que mudaria?", from: { id: "self" } },
  ]),
});

describe("dedicated read authorization", () => {
  it("denies absent, incorrect, oversized and cookie-only credentials", () => {
    for (const value of [null, "Cookie session", "Bearer wrong", `Bearer ${"a".repeat(600)}`]) expect(() => authorizeProspecting(value, env)).toThrow("Unauthorized");
  });
  it("fails closed on missing or unsafe deployment configuration", () => {
    for (const fields of [{ PROSPECTING_API_TOKEN: "short" }, { PROSPECTING_WORKSPACE_ID: "" }, { PROSPECTING_ALLOWED_HANDLES: "" }, { PROSPECTING_ALLOWED_HANDLES: "renanjacobi" }, { PROSPECTING_ALLOWED_HANDLES: "eugteodoro" }, { PROSPECTING_ALLOWED_HANDLES: "gteodoro.ia" }]) expect(() => authorizeProspecting(`Bearer ${env.PROSPECTING_API_TOKEN}`, { ...env, ...fields })).toThrow("not configured");
  });
});

describe("bounded known-prospect reads", () => {
  it("attributes authors by immutable sender ID and preserves chronological order", async () => {
    const d = deps();
    const result = await readProspectingThread({ handle: "@Nutri.Fixture" }, scope(), d);
    expect(result.messages.map(m => [m.id, m.author, m.authorConfirmed])).toEqual([["old", "self", true], ["new", "lead", true]]);
    expect(result).toMatchObject({ account: "eugteodoro", handle: "nutri.fixture", source: "instagram_api", messagesSent: 0, limited: true });
    expect(JSON.stringify(result)).not.toContain(env.PROSPECTING_API_TOKEN);
    expect(JSON.stringify(result)).not.toContain("workspace");
  });
  it("does not classify unknown senders as prospects", async () => {
    const d = deps(); d.messages.mockResolvedValue([{ id: "m", message: "from lead", from: { id: "stranger" } }, { id: "m2", message: "no sender" }]);
    const result = await readProspectingThread({ handle: "nutri.fixture" }, scope(), d);
    expect(result.directionKnown).toBe(false);
    expect(result.messages.every(m => m.author === "unknown" && !m.authorConfirmed)).toBe(true);
  });
  it("rejects blocked, unlisted, malformed and extra selectors before calling the provider", async () => {
    const d = deps();
    for (const body of [{ handle: "renanjacobi" }, { handle: "personal.friend" }, { handle: "../id" }, { handle: "nutri.fixture", conversationId: "foreign" }, null]) await expect(readProspectingThread(body, scope(), d)).rejects.toThrow();
    expect(d.findAccount).not.toHaveBeenCalled();
  });
  it("rejects another workspace, account, provider or username", async () => {
    for (const changed of [{ workspaceId: "foreign" }, { id: "foreign" }, { provider: "ZERNIO" }, { username: "foreign" }, { username: "gteodoro.ia" }]) {
      const d = deps(); d.findAccount.mockResolvedValue({ ...account, ...changed });
      await expect(readProspectingThread({ handle: "nutri.fixture" }, scope(), d)).rejects.toThrow("unavailable");
      expect(d.conversations).not.toHaveBeenCalled();
    }
  });
  it("denies missing, ambiguous, group, incomplete and foreign-account conversations", async () => {
    for (const rows of [[], [thread, thread], [{ ...thread, detailsUnavailable: true }], [{ ...thread, participants: { data: [...thread.participants.data, { id: "third" }] } }], [{ ...thread, participants: { data: [{ id: "foreign" }, { id: "lead", username: "nutri.fixture" }] } }]]) {
      const d = deps(); d.conversations.mockResolvedValue(rows);
      await expect(readProspectingThread({ handle: "nutri.fixture" }, scope(), d)).rejects.toThrow("confirmed");
      expect(d.messages).not.toHaveBeenCalled();
    }
  });
  it("bounds message history and text, and rejects unstable message IDs", async () => {
    const d = deps();
    d.messages.mockResolvedValue(Array.from({ length: 45 }, (_, i) => ({ id: String(i), message: "a".repeat(4500) })));
    const r = await readProspectingThread({ handle: "nutri.fixture" }, scope(), d);
    expect(r.messages).toHaveLength(40); expect(r.messages.every(m => m.text.length === 4000 && m.truncated)).toBe(true);
    d.messages.mockResolvedValue([{ id: "same" }, { id: "same" }]);
    await expect(readProspectingThread({ handle: "nutri.fixture" }, scope(), d)).rejects.toThrow("identity");
  });
});

vi.mock("@/lib/db/client", () => ({ prisma: { instagramAccount: { findFirst: vi.fn() } } }));
vi.mock("@/lib/instagram/context", () => ({ createInstagramContext: vi.fn() }));

describe("read HTTP boundary", () => {
  beforeEach(() => { vi.unstubAllEnvs(); for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value); });
  it("does not expose GET or a send handler", async () => {
    const route = await import("@/app/api/prospecting/read/route");
    expect(route).not.toHaveProperty("GET"); expect(route).not.toHaveProperty("PUT");
  });
  it("rejects unauthorized reads and disables caching", async () => {
    const { POST } = await import("@/app/api/prospecting/read/route");
    const response = await POST(new Request("https://example.test/api/prospecting/read", { method: "POST" }));
    expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("rejects oversized, malformed and non-JSON payloads", async () => {
    const { POST } = await import("@/app/api/prospecting/read/route");
    for (const [body, type, status] of [["a".repeat(513), "application/json", 413], ["{", "application/json", 400], ["{}", "text/plain", 415]] as const) {
      const response = await POST(new Request("https://example.test/api/prospecting/read", { method: "POST", headers: { authorization: `Bearer ${env.PROSPECTING_API_TOKEN}`, "content-type": type }, body }));
      expect(response.status).toBe(status);
    }
  });
  it("redacts upstream exceptions", async () => {
    const { prisma } = await import("@/lib/db/client");
    vi.mocked(prisma.instagramAccount.findFirst).mockRejectedValueOnce(new Error("access_token=secret"));
    const { POST } = await import("@/app/api/prospecting/read/route");
    const response = await POST(new Request("https://example.test/api/prospecting/read", { method: "POST", headers: { authorization: `Bearer ${env.PROSPECTING_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ handle: "nutri.fixture" }) }));
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("secret");
  });
});
