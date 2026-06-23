import { verifySlackRequest } from "@aipm/adapter-slack";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { memberGate } from "../members.js";

export const slackRoutes = new Hono<{ Bindings: Env }>();

slackRoutes.post("/", async (c) => {
  const raw = await c.req.text();
  const secret = c.env.SLACK_SIGNING_SECRET;
  const ok =
    !!secret &&
    (await verifySlackRequest(
      secret,
      raw,
      c.req.header("x-slack-signature") ?? null,
      c.req.header("x-slack-request-timestamp") ?? null,
    ));
  if (!ok) return c.json({ error: "bad signature" }, 401);

  const body = JSON.parse(raw) as SlackEnvelope;
  // Slack Events API URL verification handshake.
  if (body.type === "url_verification") return c.json({ challenge: body.challenge });

  // Event dedupe — Slack retries deliveries (DESIGN §6 delivery-id dedupe).
  if (body.event_id && (await c.env.DELIVERY_DEDUPE.get(`sl:${body.event_id}`))) {
    return c.json({ ok: true });
  }

  const e = body.event;
  const subject = slackMessageSubject(e);
  let enqueued = false;
  if (!subject) {
    console.info("slack event ignored", slackEventLog(body, "no_subject"));
  } else if (!(await memberGate(c.env).allows("slack", subject.user))) {
    console.info("slack event ignored", slackEventLog(body, "not_roster_member", subject));
  } else {
    if (subject.channelType === "im" && subject.text) {
      await c.env.INGEST_QUEUE.send({
        platform: "slack",
        event: "preference",
        deliveryId: body.event_id,
        payload: { slackUserId: subject.user, text: subject.text },
      });
      enqueued = true;
      console.info("slack event enqueued", slackEventLog(body, "preference", subject));
    } else if (subject.channelType === "channel" || subject.channelType === "group") {
      await c.env.INGEST_QUEUE.send({
        platform: "slack",
        event: "thread_message",
        deliveryId: body.event_id,
        payload: { channel: subject.channel, threadTs: subject.threadTs },
      });
      enqueued = true;
      console.info("slack event enqueued", slackEventLog(body, "thread_message", subject));
    } else {
      console.info("slack event ignored", slackEventLog(body, "unsupported_channel", subject));
    }
  }
  // Mark delivered only after a successful enqueue so ignored events can be
  // redelivered after config fixes such as a corrected identity roster.
  if (body.event_id && enqueued) {
    await c.env.DELIVERY_DEDUPE.put(`sl:${body.event_id}`, "1", { expirationTtl: 86_400 });
  }
  return c.json({ ok: true });
});

interface SlackEnvelope {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type?: string;
    channel_type?: string;
    channel?: string;
    bot_id?: string;
    subtype?: string;
    user?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    message?: {
      channel?: string;
      bot_id?: string;
      user?: string;
      text?: string;
      ts?: string;
      thread_ts?: string;
      replies?: Array<{ user?: string; ts?: string }>;
    };
  };
}

export interface SlackMessageSubject {
  channel: string;
  channelType: "channel" | "group" | "im";
  user: string;
  text?: string;
  threadTs: string;
}

export function slackMessageSubject(
  e: SlackEnvelope["event"] | undefined,
): SlackMessageSubject | undefined {
  if (e?.type !== "message" && e?.type !== "app_mention") return undefined;
  if (e.bot_id) return undefined;

  const channel = e.channel ?? e.message?.channel;
  const channelType = normalizeChannelType(e.channel_type, channel);
  if (!channel || !channelType) return undefined;

  if (!e.subtype) {
    if (!e.user || !e.ts) return undefined;
    return {
      channel,
      channelType,
      user: e.user,
      text: e.text,
      threadTs: e.thread_ts ?? e.ts,
    };
  }

  if (e.subtype !== "message_replied") return undefined;
  if (e.message?.bot_id) return undefined;

  const reply = e.message?.replies?.at(-1);
  const user = reply?.user ?? e.message?.user;
  const threadTs = e.message?.thread_ts ?? e.message?.ts;
  if (!user || !threadTs) return undefined;
  return {
    channel,
    channelType,
    user,
    text: e.message?.text,
    threadTs,
  };
}

function normalizeChannelType(
  channelType: string | undefined,
  channel: string | undefined,
): SlackMessageSubject["channelType"] | undefined {
  if (channelType === "channel" || channelType === "group" || channelType === "im") {
    return channelType;
  }
  if (!channel) return undefined;
  if (channel.startsWith("C")) return "channel";
  if (channel.startsWith("G")) return "group";
  if (channel.startsWith("D")) return "im";
  return undefined;
}

function slackEventLog(
  body: SlackEnvelope,
  decision: string,
  subject?: SlackMessageSubject,
): Record<string, string | undefined> {
  return {
    decision,
    eventId: body.event_id,
    type: body.event?.type,
    subtype: body.event?.subtype,
    channelType: body.event?.channel_type,
    channel: subject?.channel ?? body.event?.channel ?? body.event?.message?.channel,
    threadTs: subject?.threadTs,
    user: subject?.user ?? body.event?.user,
  };
}
