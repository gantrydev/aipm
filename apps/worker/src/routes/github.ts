import { verifyWebhook } from "@aipm/adapter-github";
import { NOTES_MARKER } from "@aipm/core";
import { Hono } from "hono";
import type { Env } from "../env.js";
import { memberGate } from "../members.js";

export const githubRoutes = new Hono<{ Bindings: Env }>();

interface GithubWebhookBody {
  action?: string;
  installation?: { id?: number };
  comment?: { body?: string };
  /** The user whose action fired this webhook — drives the member-trigger gate. */
  sender?: { login?: string };
}

githubRoutes.post("/", async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header("x-hub-signature-256") ?? null;
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || !(await verifyWebhook(secret, raw, sig))) {
    return c.json({ error: "bad signature" }, 401);
  }

  // Delivery-id dedupe in KV (DESIGN §6/§9).
  const delivery = c.req.header("x-github-delivery") ?? undefined;
  if (delivery && (await c.env.DELIVERY_DEDUPE.get(`gh:${delivery}`))) {
    return c.json({ ok: true, deduped: true });
  }

  // Carry the discriminators the engine needs: event name (header — the only
  // reliable classifier), action, delivery id, and installation id (for token).
  const body = JSON.parse(raw) as GithubWebhookBody;

  // Ignore the bot's own sticky-note comment edits — otherwise editing the note
  // fires issue_comment events that re-ingest and re-edit it in a loop.
  if (
    c.req.header("x-github-event") === "issue_comment" &&
    body.comment?.body?.includes(NOTES_MARKER)
  ) {
    if (delivery) await c.env.DELIVERY_DEDUPE.put(`gh:${delivery}`, "1", { expirationTtl: 86_400 });
    return c.json({ ok: true, ignored: "own-comment" });
  }

  // Member-trigger gate: drop events fired by non-members before any spend
  // (queue/DO/LLM), so a public repo's strangers — or a comment loop — can't run
  // up the bill. Default on; bypass with REQUIRE_MEMBER_TRIGGER="false".
  if (!(await memberGate(c.env).allows("github", body.sender?.login))) {
    if (delivery) await c.env.DELIVERY_DEDUPE.put(`gh:${delivery}`, "1", { expirationTtl: 86_400 });
    return c.json({ ok: true, ignored: "non-member" });
  }

  await c.env.INGEST_QUEUE.send({
    platform: "github",
    event: c.req.header("x-github-event") ?? undefined,
    action: body.action,
    deliveryId: delivery,
    installationId: body.installation?.id,
    payload: body,
  });

  // Mark delivered only after a successful enqueue, so an enqueue failure (which
  // returns 5xx and is retried by GitHub) can't permanently drop the event.
  if (delivery) await c.env.DELIVERY_DEDUPE.put(`gh:${delivery}`, "1", { expirationTtl: 86_400 });
  return c.json({ ok: true });
});
