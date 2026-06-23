import { describe, expect, it } from "vitest";
import { slackMessageSubject, slackRoutes } from "../src/routes/slack.js";
import type { Env } from "../src/env.js";

describe("slackMessageSubject", () => {
  it("maps root channel messages to their own thread", () => {
    expect(
      slackMessageSubject({
        type: "message",
        channel_type: "channel",
        channel: "C123",
        user: "U123",
        text: "see acme-corp/web-backend#3809",
        ts: "1782220000.000100",
      }),
    ).toEqual({
      channel: "C123",
      channelType: "channel",
      user: "U123",
      text: "see acme-corp/web-backend#3809",
      threadTs: "1782220000.000100",
    });
  });

  it("maps top-level app mentions to their own thread", () => {
    expect(
      slackMessageSubject({
        type: "app_mention",
        channel_type: "channel",
        channel: "C123",
        user: "U123",
        text: "<@UAIPM> see acme-corp/web-backend#3809",
        ts: "1782220000.000100",
      }),
    ).toEqual({
      channel: "C123",
      channelType: "channel",
      user: "U123",
      text: "<@UAIPM> see acme-corp/web-backend#3809",
      threadTs: "1782220000.000100",
    });
  });

  it("maps thread replies delivered as message_replied to the parent thread", () => {
    expect(
      slackMessageSubject({
        type: "message",
        subtype: "message_replied",
        channel: "C123",
        message: {
          user: "UROOT",
          text: "root",
          ts: "1782220000.000100",
          thread_ts: "1782220000.000100",
          replies: [{ user: "U123", ts: "1782220001.000200" }],
        },
      }),
    ).toEqual({
      channel: "C123",
      channelType: "channel",
      user: "U123",
      text: "root",
      threadTs: "1782220000.000100",
    });
  });

  it("ignores bot messages and non-threading subtypes", () => {
    expect(
      slackMessageSubject({
        type: "message",
        channel_type: "channel",
        channel: "C123",
        bot_id: "B123",
        ts: "1782220000.000100",
      }),
    ).toBeUndefined();
    expect(
      slackMessageSubject({
        type: "message",
        subtype: "message_changed",
        channel: "C123",
        ts: "1782220000.000100",
      }),
    ).toBeUndefined();
  });
});

describe("slackRoutes", () => {
  it("does not dedupe ignored events, but dedupes enqueued events", async () => {
    const kv = new Map<string, string>();
    const queued: unknown[] = [];
    const env = {
      SLACK_SIGNING_SECRET: "secret",
      IDENTITY_ROSTER: JSON.stringify([{ github: "alice", slack: "U123" }]),
      DELIVERY_DEDUPE: {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: string) => {
          kv.set(key, value);
        },
      },
      INGEST_QUEUE: {
        send: async (message: unknown) => {
          queued.push(message);
        },
      },
    } as unknown as Env;

    const ignored = {
      type: "event_callback",
      event_id: "EvIgnored",
      event: {
        type: "message",
        channel_type: "channel",
        channel: "C123",
        user: "UNLISTED",
        text: "hello",
        ts: "1782220000.000100",
      },
    };
    expect((await slackRoutes.fetch(await signedRequest(ignored), env)).status).toBe(200);
    expect(await env.DELIVERY_DEDUPE.get("sl:EvIgnored")).toBeNull();

    const accepted = {
      ...ignored,
      event_id: "EvAccepted",
      event: { ...ignored.event, user: "U123" },
    };
    expect((await slackRoutes.fetch(await signedRequest(accepted), env)).status).toBe(200);
    expect(await env.DELIVERY_DEDUPE.get("sl:EvAccepted")).toBe("1");
    expect(queued).toHaveLength(1);
  });
});

async function signedRequest(body: unknown): Promise<Request> {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${raw}`),
  );
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://example.com/", {
    method: "POST",
    body: raw,
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${hex}`,
    },
  });
}
