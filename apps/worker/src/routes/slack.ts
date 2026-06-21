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

  // Ignore the bot's own messages and edits/joins (subtypes) to avoid loops.
  // Member-trigger gate: only roster members drive work, so a stray guest or a
  // message loop can't run up LLM spend (default on; REQUIRE_MEMBER_TRIGGER).
  const e = body.event;
  if (
    e?.type === "message" &&
    !e.bot_id &&
    !e.subtype &&
    e.user &&
    (await memberGate(c.env).allows("slack", e.user))
  ) {
    if (e.channel_type === "im" && e.text) {
      // A human's DM is a preference command (DESIGN §8).
      await c.env.INGEST_QUEUE.send({
        platform: "slack",
        event: "preference",
        deliveryId: body.event_id,
        payload: { slackUserId: e.user, text: e.text },
      });
    } else if ((e.channel_type === "channel" || e.channel_type === "group") && e.channel) {
      // A channel message → ingest its thread as a first-class Thread (DESIGN §8).
      await c.env.INGEST_QUEUE.send({
        platform: "slack",
        event: "thread_message",
        deliveryId: body.event_id,
        payload: { channel: e.channel, threadTs: e.thread_ts ?? e.ts },
      });
    }
  }
  // Mark delivered only after a successful enqueue so a transient failure (5xx,
  // which Slack retries) can't permanently drop the event.
  if (body.event_id) {
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
  };
}
