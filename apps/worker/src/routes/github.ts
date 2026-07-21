import { verifyWebhook } from "@aipm/adapter-github";
import { NOTES_MARKER, Ok, Result, type RawEvent } from "@aipm/core";
import { LEGACY_WORKSPACE_ID } from "@aipm/db";
import { Hono } from "hono";
import { markDelivered } from "../dedupe.js";
import type { Env } from "../env.js";
import { createWorkspaceIngestMessage } from "../messages.js";
import { workspaceActorGate } from "../tenancy/actors.js";
import { workspaceAudit } from "../tenancy/audit.js";
import { consumeWorkspaceRateBudget } from "../tenancy/budgets.js";
import {
  installationWorkspaceId,
  requireEnabledRepositoryUnlessLegacy,
  resolveWorkspaceInstallationOrLegacy,
} from "../tenancy/guards.js";
import { workspaceDeliveryDedupe, workspaceLog } from "../tenancy/index.js";
import { deliveryKey } from "../tenancy/keys.js";
import {
  handleGithubInstallationLifecycle,
  isInstallationLifecycleEvent,
  type InstallationLifecyclePayload,
} from "../tenancy/lifecycle.js";

export const githubRoutes = new Hono<{ Bindings: Env }>();

interface GithubWebhookBody extends InstallationLifecyclePayload {
  comment?: { body?: string };
  repository?: { id?: number; full_name?: string; name?: string };
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

  const parsed = Result.fromSync(() => JSON.parse(raw.data) as unknown);
  if (!parsed.ok) return c.json({ error: "invalid json" }, 400);
  if (!isGithubWebhookBody(parsed.data)) return c.json({ error: "invalid payload" }, 400);
  const body = parsed.data;
  const eventName = c.req.header("x-github-event") ?? undefined;
  const delivery = c.req.header("x-github-delivery") ?? undefined;

  if (eventName !== undefined && isInstallationLifecycleEvent(eventName)) {
    const handled = await handleGithubInstallationLifecycle(c.env, eventName, body);
    if (!handled.ok) {
      console.error("installation lifecycle failed:", handled.error);
      throw handled.error;
    }
    const dedupe = workspaceDeliveryDedupe(c.env, handled.data.workspaceId);
    const delivered = await markDelivered(
      c.env.DELIVERY_DEDUPE,
      delivery ? dedupe.key(githubDeliverySuffix(delivery)) : null,
    );
    if (!delivered.ok) throw delivered.error;
    return c.json({ ok: true, handled: handled.data.handled });
  }

  const workspace = await resolveWorkspaceInstallationOrLegacy(c.env, body.installation?.id);
  if (!workspace.ok) {
    await markRejectedDelivery(c.env, body.installation?.id, delivery);
    return c.json({ ok: true, ignored: workspace.error.message });
  }

  const rate = await consumeWorkspaceRateBudget(c.env, workspace.data.workspaceId);
  if (!rate.ok) throw rate.error;
  if (!rate.data.allowed) {
    const key = delivery
      ? deliveryKey(workspace.data.workspaceId, githubDeliverySuffix(delivery))
      : null;
    const delivered = await markDelivered(c.env.DELIVERY_DEDUPE, key);
    if (!delivered.ok) throw delivered.error;
    const audited = await workspaceAudit(c.env, workspace.data.workspaceId).append({
      action: "github.ingress",
      outcome: "skipped",
      actor: {
        source: "github",
        kind: "installation",
        ...(body.installation?.id === undefined ? {} : { id: String(body.installation.id) }),
      },
      detail: { reason: "safety_ceiling", exhausted: rate.data.exhausted },
    });
    if (!audited.ok) throw audited.error;
    workspaceLog(
      workspace.data.workspaceId,
      "info",
      `github event skipped: ${rate.data.exhausted ?? "unknown"} rate ceiling`,
    );
    return c.json({ ok: true, ignored: "safety-ceiling" });
  }

  const dedupeKv = workspaceDeliveryDedupe(c.env, workspace.data.workspaceId);
  const deliverySuffix = delivery ? githubDeliverySuffix(delivery) : null;
  const dedupe = await (async () => {
    if (!deliverySuffix) return Ok(null);
    return Result.from(() => dedupeKv.get(deliverySuffix));
  })();
  if (!dedupe.ok) throw dedupe.error;
  if (dedupe.data) {
    return c.json({ ok: true, deduped: true });
  }

  // Ignore the bot's own sticky-note comment edits — otherwise editing the note
  // fires issue_comment events that re-ingest and re-edit it in a loop.
  if (eventName === "issue_comment" && body.comment?.body?.includes(NOTES_MARKER)) {
    const delivered = await markDelivered(
      c.env.DELIVERY_DEDUPE,
      deliverySuffix ? dedupeKv.key(deliverySuffix) : null,
    );
    if (!delivered.ok) throw delivered.error;
    return c.json({ ok: true, ignored: "own-comment" });
  }

  const enabledRepo = await requireEnabledRepositoryUnlessLegacy(
    c.env,
    workspace.data,
    body.repository?.id,
  );
  if (!enabledRepo.ok) {
    const delivered = await markDelivered(
      c.env.DELIVERY_DEDUPE,
      deliverySuffix ? dedupeKv.key(deliverySuffix) : null,
    );
    if (!delivered.ok) throw delivered.error;
    return c.json({ ok: true, ignored: "repository-disabled" });
  }

  // Member-trigger gate: drop events fired by non-members before any spend
  // (queue/DO/LLM). Managed workspaces use membership; legacy uses IDENTITY_ROSTER.
  const gate = workspaceActorGate(c.env, workspace.data.workspaceId);
  if (!gate.ok) throw gate.error;
  const allowed = await gate.data.allows("github", body.sender?.login);
  if (!allowed) {
    const delivered = await markDelivered(
      c.env.DELIVERY_DEDUPE,
      deliverySuffix ? dedupeKv.key(deliverySuffix) : null,
    );
    if (!delivered.ok) throw delivered.error;
    return c.json({ ok: true, ignored: "non-member" });
  }

  const event: RawEvent = {
    platform: "github",
    event: eventName,
    action: body.action,
    deliveryId: delivery,
    installationId: body.installation?.id,
    payload: body,
  };
  const message = createWorkspaceIngestMessage(workspace.data, event);
  const queued = await Result.from(() => c.env.INGEST_QUEUE.send(message));
  if (!queued.ok) throw queued.error;

  // Mark delivered only after a successful enqueue, so an enqueue failure (which
  // returns 5xx and is retried by GitHub) can't permanently drop the event.
  const delivered = await markDelivered(
    c.env.DELIVERY_DEDUPE,
    deliverySuffix ? dedupeKv.key(deliverySuffix) : null,
  );
  if (!delivered.ok) throw delivered.error;
  workspaceLog(workspace.data.workspaceId, "info", `enqueued github ${eventName ?? "event"}`);
  return c.json({ ok: true });
});

const githubDeliverySuffix = (delivery: string): string => `gh:${delivery}`;

const markRejectedDelivery = async (
  env: Env,
  installationId: number | undefined,
  delivery: string | undefined,
): Promise<void> => {
  if (!delivery) return;
  const workspaceId = await (async () => {
    if (installationId === undefined) return LEGACY_WORKSPACE_ID;
    const record = await installationWorkspaceId(env, installationId);
    if (!record.ok) throw record.error;
    return record.data ?? LEGACY_WORKSPACE_ID;
  })();
  const key = deliveryKey(workspaceId, githubDeliverySuffix(delivery));
  const delivered = await markDelivered(env.DELIVERY_DEDUPE, key);
  if (!delivered.ok) throw delivered.error;
};

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
  const account = value.account;
  if (account === undefined) return isOptionalNumber(value.id);
  if (!isRecord(account)) return false;
  return (
    isOptionalNumber(value.id) &&
    isOptionalNumber(account.id) &&
    isOptionalString(account.login) &&
    isOptionalString(account.type)
  );
};

const isOptionalSender = (value: unknown) => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return isOptionalString(value.login) && isOptionalNumber(value.id);
};

const isOptionalRepository = (value: unknown) => {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    isOptionalNumber(value.id) && isOptionalString(value.full_name) && isOptionalString(value.name)
  );
};

const isGithubWebhookBody = (value: unknown): value is GithubWebhookBody => {
  if (!isRecord(value)) return false;
  const validAction = isOptionalString(value.action);
  const validComment = isOptionalComment(value.comment);
  const validInstallation = isOptionalInstallation(value.installation);
  const validSender = isOptionalSender(value.sender);
  const validRepository = isOptionalRepository(value.repository);
  return validAction && validComment && validInstallation && validSender && validRepository;
};
