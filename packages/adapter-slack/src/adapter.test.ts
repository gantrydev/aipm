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
    await slack.notifyPerson({ id: "u1", handles: { slack: "U1" } }, "hi there");

    expect(calls[0]).toMatchObject({
      url: "https://slack.com/api/conversations.open",
      body: { users: "U1" },
    });
    expect(calls[1]).toMatchObject({
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "D123", text: "hi there" },
    });
  });

  it("throws without a resolved Slack id", async () => {
    const { fetchImpl } = scriptedFetch([]);
    const slack = new SlackAdapter({ botToken: "xoxb", fetchImpl });
    await expect(slack.notifyPerson({ id: "u1", handles: {} }, "hi")).rejects.toThrow(
      /no Slack id/,
    );
  });
});

describe("SlackAdapter.resolvePerson", () => {
  it("returns a cached U… id without an API call", async () => {
    const { fetchImpl, calls } = scriptedFetch([]);
    const slack = new SlackAdapter({ botToken: "xoxb", fetchImpl });
    expect(await slack.resolvePerson({ id: "u1", handles: { slack: "U0BBYPEAXEE" } })).toBe(
      "U0BBYPEAXEE",
    );
    expect(calls).toHaveLength(0);
  });

  it("resolves a roster-supplied username (not a U… id) via the API", async () => {
    const { fetchImpl } = scriptedFetch([
      { ok: true, members: [{ id: "U0BBYPEAXEE", name: "dian" }] },
    ]);
    const slack = new SlackAdapter({ botToken: "xoxb", fetchImpl });
    expect(await slack.resolvePerson({ id: "u1", handles: { slack: "dian" } })).toBe("U0BBYPEAXEE");
  });

  it("looks up by email when the Slack id is unknown", async () => {
    const { fetchImpl } = scriptedFetch([{ ok: true, user: { id: "U7" } }]);
    const slack = new SlackAdapter({ botToken: "xoxb", fetchImpl });
    expect(
      await slack.resolvePerson({ id: "u1", handles: { github: "g" }, email: "a@x.com" }),
    ).toBe("U7");
  });
});
