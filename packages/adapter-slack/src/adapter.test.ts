import { describe, expect, it } from "vitest";
import { SlackAdapter } from "./adapter.js";

function scriptedFetch(responses: Array<{ ok: boolean; [k: string]: unknown }>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(responses[i++]), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("SlackAdapter.notifyPerson", () => {
  it("opens a DM then posts the message", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { ok: true, channel: { id: "D123" } },
      { ok: true },
    ]);
    const slack = new SlackAdapter({ botToken: "xoxb", fetchImpl });
    const r = await slack.notifyPerson({ id: "u1", handles: { slack: "U1" } }, "hi there");
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;

    expect(calls[0]).toMatchObject({
      url: "https://slack.com/api/conversations.open",
      body: { users: "U1" },
    });
    expect(calls[1]).toMatchObject({
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "D123", text: "hi there" },
    });
  });

  it("returns an Err without a resolved Slack id", async () => {
    const { fetchImpl } = scriptedFetch([]);
    const slack = new SlackAdapter({ botToken: "xoxb", fetchImpl });
    const r = await slack.notifyPerson({ id: "u1", handles: {} }, "hi");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/no Slack id/);
  });
});

describe("SlackAdapter.postMessage", () => {
  it("posts directly to a channel when meta.channelId is provided", async () => {
    const { fetchImpl, calls } = scriptedFetch([{ ok: true, ts: "1782220000.000100" }]);
    const slack = new SlackAdapter({ botToken: "xoxb", fetchImpl });
    const res = await slack.postMessage({ meta: { channelId: "C123" } }, "daily pulse");

    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    expect(res.data).toEqual({ id: "C123/1782220000.000100" });
    expect(calls[0]).toMatchObject({
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "C123", text: "daily pulse" },
    });
  });
});

describe("SlackAdapter slack-as-thread", () => {
  it("normalizeEvent maps a thread_message to a slack_thread ref", () => {
    const slack = new SlackAdapter({ botToken: "x" });
    expect(
      slack.normalizeEvent({
        platform: "slack",
        event: "thread_message",
        payload: { channel: "C1", threadTs: "1700.0001" },
      }),
    ).toEqual({ nativeId: "C1/1700.0001", type: "slack_thread" });
  });

  it("getThread builds a Thread from conversations.replies (bots excluded from participants)", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        ok: true,
        messages: [
          { user: "U1", text: "see gantrydev/aipm#3", ts: "1700.0001" },
          { user: "U2", text: "<@U1> on it", ts: "1700.0002" },
          { bot_id: "B9", text: "🤖 note", ts: "1700.0003" },
        ],
      },
    ]);
    const slack = new SlackAdapter({ botToken: "x", fetchImpl });
    const r = await slack.getThread("C1/1700.0001");
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    const t = r.data;
    expect(t).toMatchObject({ platform: "slack", type: "slack_thread", nativeId: "C1/1700.0001" });
    expect(t.participants.sort()).toEqual(["U1", "U2"]); // bot excluded
    expect(t.timeline[1]?.data.mentions).toEqual(["U1"]);
  });

  it("discoverLinks cross-references GitHub issues/PRs mentioned in the thread", async () => {
    const slack = new SlackAdapter({ botToken: "x" });
    const r = await slack.discoverLinks({
      platform: "slack",
      nativeId: "C1/1700.0001",
      type: "slack_thread",
      state: "open",
      participants: [],
      meta: {},
      timeline: [
        {
          kind: "comment",
          at: "2026-01-01T00:00:00Z",
          data: {
            body: "fixes gantrydev/aipm#3 and https://github.com/acme-corp/web-frontend/issues/2317",
          },
        },
        {
          kind: "comment",
          at: "2026-01-01T00:01:00Z",
          data: {
            body: "related PR https://github.com/acme-corp/web-backend/pull/4200 and duplicate gantrydev/aipm#3",
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    const links = r.data;
    expect(links).toEqual([
      { from: "C1/1700.0001", to: "gantrydev/aipm#3", kind: "cross_ref" },
      { from: "C1/1700.0001", to: "acme-corp/web-frontend#2317", kind: "cross_ref" },
      { from: "C1/1700.0001", to: "acme-corp/web-backend#4200", kind: "cross_ref" },
    ]);
  });
});

describe("SlackAdapter.resolvePerson", () => {
  it("returns a cached U… id without an API call", async () => {
    const { fetchImpl, calls } = scriptedFetch([]);
    const slack = new SlackAdapter({ botToken: "xoxb", fetchImpl });
    const r = await slack.resolvePerson({ id: "u1", handles: { slack: "U01ALICE" } });
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.data).toBe("U01ALICE");
    expect(calls).toHaveLength(0);
  });

  it("resolves a roster-supplied username (not a U… id) via the API", async () => {
    const { fetchImpl } = scriptedFetch([
      { ok: true, members: [{ id: "U01ALICE", name: "alice" }] },
    ]);
    const slack = new SlackAdapter({ botToken: "xoxb", fetchImpl });
    const r = await slack.resolvePerson({ id: "u1", handles: { slack: "alice" } });
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.data).toBe("U01ALICE");
  });

  it("looks up by email when the Slack id is unknown", async () => {
    const { fetchImpl } = scriptedFetch([{ ok: true, user: { id: "U7" } }]);
    const slack = new SlackAdapter({ botToken: "xoxb", fetchImpl });
    const r = await slack.resolvePerson({ id: "u1", handles: { github: "g" }, email: "a@x.com" });
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.data).toBe("U7");
  });
});
