import { verifySlackRequest } from "@aipm/adapter-slack";
import { Ok, Result } from "@aipm/core";
import { Hono } from "hono";
import { markDelivered } from "../dedupe.js";
import type { Env } from "../env.js";
import { memberGate } from "../members.js";

export const slackRoutes = new Hono<{ Bindings: Env }>();

slackRoutes.post("/", async (c) => {
  const raw = await Result.from(() => c.req.text());
  if (!raw.ok) return c.json({ error: "bad request" }, 400);

  const secret = c.env.SLACK_SIGNING_SECRET;
  const verified = await (async () => {
    if (!secret) return Ok(false);
    return verifySlackRequest(
      secret,
      raw.data,
      c.req.header("x-slack-signature") ?? null,
      c.req.header("x-slack-request-timestamp") ?? null,
    );
  })();
  if (!verified.ok) throw verified.error;
  if (!verified.data) return c.json({ error: "bad signature" }, 401);

  const parsed = Result.fromSync(() => JSON.parse(raw.data));
  if (!parsed.ok) return c.json({ error: "invalid json" }, 400);
  if (!isSlackEnvelope(parsed.data)) return c.json({ error: "invalid payload" }, 400);
  const body = parsed.data;
  // Slack Events API URL verification handshake.
  if (body.type === "url_verification") return c.json({ challenge: body.challenge });

  // Event dedupe — Slack retries deliveries (DESIGN §6 delivery-id dedupe).
  const dedupe = await (async () => {
    if (!body.event_id) return Ok(null);
    return Result.from(() => c.env.DELIVERY_DEDUPE.get(`sl:${body.event_id}`));
  })();
  if (!dedupe.ok) throw dedupe.error;
  if (dedupe.data) {
    return c.json({ ok: true });
  }

  const e = body.event;
  const subject = slackMessageSubject(e);
  let enqueued = false;
  if (!subject) {
    console.info("slack event ignored", slackEventLog(body, "no_subject"));
  } else {
    const gate = memberGate(c.env);
    if (!gate.ok) throw gate.error;
    const allowed = await gate.data.allows("slack", subject.user);
    if (!allowed) {
      console.info("slack event ignored", slackEventLog(body, "not_roster_member", subject));
    } else if (subject.channelType === "im" && subject.text) {
      const queued = await Result.from(() =>
        c.env.INGEST_QUEUE.send({
          platform: "slack",
          event: "preference",
          deliveryId: body.event_id,
          payload: { slackUserId: subject.user, text: subject.text },
        }),
      );
      if (!queued.ok) throw queued.error;
      enqueued = true;
      console.info("slack event enqueued", slackEventLog(body, "preference", subject));
    } else if (subject.channelType === "channel" || subject.channelType === "group") {
      const queued = await Result.from(() =>
        c.env.INGEST_QUEUE.send({
          platform: "slack",
          event: "thread_message",
          deliveryId: body.event_id,
          payload: { channel: subject.channel, threadTs: subject.threadTs },
        }),
      );
      if (!queued.ok) throw queued.error;
      enqueued = true;
      console.info("slack event enqueued", slackEventLog(body, "thread_message", subject));
    } else {
      console.info("slack event ignored", slackEventLog(body, "unsupported_channel", subject));
    }
  }
  // Mark delivered only after a successful enqueue so ignored events can be
  // redelivered after config fixes such as a corrected identity roster.
  const deliveredKey = body.event_id && enqueued ? `sl:${body.event_id}` : null;
  const delivered = await markDelivered(c.env.DELIVERY_DEDUPE, deliveredKey);
  if (!delivered.ok) throw delivered.error;
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
  const isObject = typeof value === "object";
  return isObject && value !== null;
};

const isOptionalString = (value: unknown) => {
  return value === undefined || typeof value === "string";
};

const isOptionalReplies = (value: unknown) => {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (!isRecord(item)) return false;
    const validUser = isOptionalString(item.user);
    const validTs = isOptionalString(item.ts);
    return validUser && validTs;
  });
};

const isOptionalSlackMessage = (value: unknown) => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const validChannel = isOptionalString(value.channel);
  const validBotId = isOptionalString(value.bot_id);
  const validUser = isOptionalString(value.user);
  const validText = isOptionalString(value.text);
  const validTs = isOptionalString(value.ts);
  const validThreadTs = isOptionalString(value.thread_ts);
  const validReplies = isOptionalReplies(value.replies);
  return (
    validChannel && validBotId && validUser && validText && validTs && validThreadTs && validReplies
  );
};

const isOptionalSlackEvent = (value: unknown) => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const validType = isOptionalString(value.type);
  const validChannelType = isOptionalString(value.channel_type);
  const validChannel = isOptionalString(value.channel);
  const validBotId = isOptionalString(value.bot_id);
  const validSubtype = isOptionalString(value.subtype);
  const validUser = isOptionalString(value.user);
  const validText = isOptionalString(value.text);
  const validTs = isOptionalString(value.ts);
  const validThreadTs = isOptionalString(value.thread_ts);
  const validMessage = isOptionalSlackMessage(value.message);
  return (
    validType &&
    validChannelType &&
    validChannel &&
    validBotId &&
    validSubtype &&
    validUser &&
    validText &&
    validTs &&
    validThreadTs &&
    validMessage
  );
};

const isSlackEnvelope = (value: unknown): value is SlackEnvelope => {
  if (!isRecord(value)) return false;
  const validType = isOptionalString(value.type);
  const validChallenge = isOptionalString(value.challenge);
  const validEventId = isOptionalString(value.event_id);
  const validEvent = isOptionalSlackEvent(value.event);
  return validType && validChallenge && validEventId && validEvent;
};
