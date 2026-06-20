import { verifySlackRequest } from "@aipm/adapter-slack";
import { Hono } from "hono";
import type { Env } from "../env.js";

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

  const body = JSON.parse(raw) as { type?: string; challenge?: string };
  // Slack Events API URL verification handshake.
  if (body.type === "url_verification") return c.json({ challenge: body.challenge });

  await c.env.INGEST_QUEUE.send({ platform: "slack", payload: body });
  return c.json({ ok: true });
});
