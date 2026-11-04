import { afterEach, expect, it, vi } from "vitest";
import { discoverProspectingConversations, readProspectingMessages } from "@/lib/prospecting/meta-read";
afterEach(() => vi.unstubAllGlobals());

it("discovery never requests or returns message previews from other conversations", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [{ id: "thread", participants: { data: [] }, messages: { data: [{ message: "personal" }] } }] }));
  vi.stubGlobal("fetch", fetcher);
  const data = await discoverProspectingConversations("fictitious-token", "self");
  const [url, options] = fetcher.mock.calls[0];
  expect(url.hostname).toBe("graph.instagram.com");
  expect(url.searchParams.get("fields")).toBe("id,participants,updated_time");
  expect(url.searchParams.has("access_token")).toBe(false);
  expect(options.headers.Authorization).toBe("Bearer fictitious-token");
  expect(options.redirect).toBe("error");
  expect(JSON.stringify(data)).not.toContain("personal");
});

it("message reader uses a bounded selected conversation and bearer auth", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ messages: { data: [{ id: "m", from: { id: "lead" } }] } }));
  vi.stubGlobal("fetch", fetcher);
  expect(await readProspectingMessages("fictitious-token", "selected-thread")).toHaveLength(1);
  const [url] = fetcher.mock.calls[0];
  expect(url.pathname.endsWith("/selected-thread")).toBe(true);
  expect(url.searchParams.get("fields")).toBe("messages.limit(20){id,created_time,from,message}");
  expect(url.searchParams.has("access_token")).toBe(false);
});

it("upstream error messages and tokens never enter errors, and missing data is not an empty success", async () => {
  for (const response of [new Response("private", { status: 401 }), Response.json({error: {message: "secret"}}), Response.json({})]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(discoverProspectingConversations("fictitious-token", "self")).rejects.not.toThrow(/private|secret|fictitious-token/);
  }
});
