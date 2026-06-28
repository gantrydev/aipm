import { verifyWebhook } from "@aipm/adapter-github";
import { NOTES_MARKER, Ok, Result } from "@aipm/core";
import { Hono } from "hono";
import { markDelivered } from "../dedupe.js";
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
  const raw = await Result.from(() => c.req.text());
  if (!raw.ok) return c.json({ error: "bad request" }, 400);

  const sig = c.req.header("x-hub-signature-256") ?? null;
  const secret = c.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is not configured");
  const verified = await verifyWebhook(secret, raw.data, sig);
  if (!verified.ok) throw verified.error;
  if (!verified.data) return c.json({ error: "bad signature" }, 401);

  // Delivery-id dedupe in KV (DESIGN §6/§9).
  const delivery = c.req.header("x-github-delivery") ?? undefined;
  const dedupe = await (async () => {
    if (!delivery) return Ok(null);
    return Result.from(() => c.env.DELIVERY_DEDUPE.get(`gh:${delivery}`));
  })();
  if (!dedupe.ok) throw dedupe.error;
  if (dedupe.data) {
    return c.json({ ok: true, deduped: true });
  }

  // Carry the discriminators the engine needs: event name (header — the only
  // reliable classifier), action, delivery id, and installation id (for token).
  const parsed = Result.fromSync(() => JSON.parse(raw.data));
  if (!parsed.ok) return c.json({ error: "invalid json" }, 400);
  if (!isGithubWebhookBody(parsed.data)) return c.json({ error: "invalid payload" }, 400);
  const body = parsed.data;

  // Ignore the bot's own sticky-note comment edits — otherwise editing the note
  // fires issue_comment events that re-ingest and re-edit it in a loop.
  if (
    c.req.header("x-github-event") === "issue_comment" &&
    body.comment?.body?.includes(NOTES_MARKER)
  ) {
    const delivered = await markDelivered(
      c.env.DELIVERY_DEDUPE,
      delivery ? `gh:${delivery}` : null,
    );
    if (!delivered.ok) throw delivered.error;
    return c.json({ ok: true, ignored: "own-comment" });
  }

  // Member-trigger gate: drop events fired by non-members before any spend
  // (queue/DO/LLM), so a public repo's strangers — or a comment loop — can't run
  // up the bill. Default on; bypass with REQUIRE_MEMBER_TRIGGER="false".
  const gate = memberGate(c.env);
  if (!gate.ok) throw gate.error;
  const allowed = await gate.data.allows("github", body.sender?.login);
  if (!allowed) {
    const delivered = await markDelivered(
      c.env.DELIVERY_DEDUPE,
      delivery ? `gh:${delivery}` : null,
    );
    if (!delivered.ok) throw delivered.error;
    return c.json({ ok: true, ignored: "non-member" });
  }

  const queued = await Result.from(() =>
    c.env.INGEST_QUEUE.send({
      platform: "github",
      event: c.req.header("x-github-event") ?? undefined,
      action: body.action,
      deliveryId: delivery,
      installationId: body.installation?.id,
      payload: body,
    }),
  );
  if (!queued.ok) throw queued.error;

  // Mark delivered only after a successful enqueue, so an enqueue failure (which
  // returns 5xx and is retried by GitHub) can't permanently drop the event.
  const delivered = await markDelivered(c.env.DELIVERY_DEDUPE, delivery ? `gh:${delivery}` : null);
  if (!delivered.ok) throw delivered.error;
  return c.json({ ok: true });
});

const isRecord = (value: unknown): value is Record<string, unknown> => {
  const isObject = typeof value === "object";
  return isObject && value !== null;
};

const isOptionalString = (value: unknown) => {
  return value === undefined || typeof value === "string";
};

const isOptionalNumber = (value: unknown) => {
  return value === undefined || typeof value === "number";
};

const isOptionalComment = (value: unknown) => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return isOptionalString(value.body);
};

const isOptionalInstallation = (value: unknown) => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return isOptionalNumber(value.id);
};

const isOptionalSender = (value: unknown) => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return isOptionalString(value.login);
};

const isGithubWebhookBody = (value: unknown): value is GithubWebhookBody => {
  if (!isRecord(value)) return false;
  const validAction = isOptionalString(value.action);
  const validComment = isOptionalComment(value.comment);
  const validInstallation = isOptionalInstallation(value.installation);
  const validSender = isOptionalSender(value.sender);
  return validAction && validComment && validInstallation && validSender;
};
