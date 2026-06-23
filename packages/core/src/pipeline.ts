import { Result } from "./result.js";
import { businessHoursBetween, type Clock } from "./clock.js";
import { isShadowed, type EngineConfig } from "./config.js";
import { detectors, isTerminal, type ActiveSignal, type DetectorContext } from "./detectors.js";
import type { Cluster, Nudge, Preference, Signal, SignalKind, Thread } from "./domain.js";
import type { PlatformId } from "./domain.js";
import { ensureIdentityForHandle } from "./identity-source.js";
import { judgeUnansweredMentions } from "./judge.js";
import { buildNudgeMessage, chooseChannel, signalLabel } from "./nudge.js";
import { dedupeKey } from "./cluster.js";
import {
  buildNotesPrompt,
  NOTES_MARKER,
  notesInputDigest,
  renderWorkingNotes,
  stableHash,
} from "./notes.js";
import type { IdentitySource, LlmAdapter, Platform, RawEvent } from "./platform.js";
import type { Store } from "./store.js";

/**
 * Everything a pipeline stage needs. Assembled once per Worker request /
 * queue batch and threaded through the stages (DESIGN §6).
 */
export interface EngineContext {
  store: Store;
  platforms: Map<PlatformId, Platform>;
  identities: IdentitySource;
  llm: LlmAdapter;
  config: EngineConfig;
  clock: Clock;
}

// --- Ingest -------------------------------------------------------------------
// webhook or sweep -> adapter normalizes -> upsert Thread/Link/participants.

export async function ingest(ctx: EngineContext, event: RawEvent): Promise<Thread | undefined> {
  const platform = ctx.platforms.get(event.platform);
  if (!platform) throw new Error(`No adapter for platform: ${event.platform}`);

  const ref = platform.normalizeEvent(event);
  if (!ref) return undefined; // ignored event kind

  // Adapter returns participants/owner as platform handles (see Platform docs);
  // resolve them to canonical Identity ids and persist the rows.
  const thread = await platform.getThread(ref.nativeId, ref.type);
  const resolved = await resolveThreadIdentities(ctx, thread);

  await ctx.store.upsertThread(resolved);

  const links = await platform.discoverLinks(resolved);
  await ctx.store.upsertLinks(links);

  return resolved;
}

/**
 * Map every platform handle on a thread to a canonical Identity id: participants,
 * owner, meta.author, meta.assignees, and per-timeline-event actor + the person
 * fields in `data` (target, assignee, mentions). Resolves each distinct handle
 * once so the persisted Thread is uniformly in the Identity-id namespace, which
 * the detectors (DESIGN §7) rely on for matching owed-by against repliers.
 */
async function resolveThreadIdentities(ctx: EngineContext, thread: Thread): Promise<Thread> {
  const handles = new Set<string>(thread.participants);
  const author = strField(thread.meta.author);
  const assignees = strArray(thread.meta.assignees);
  if (thread.owner) handles.add(thread.owner);
  if (author) handles.add(author);
  for (const a of assignees) handles.add(a);
  for (const e of thread.timeline) {
    if (e.actor) handles.add(e.actor);
    const t = strField(e.data.target);
    const as = strField(e.data.assignee);
    if (t) handles.add(t);
    if (as) handles.add(as);
    for (const m of strArray(e.data.mentions)) handles.add(m);
  }

  const map = new Map<string, string>();
  await Promise.all(
    [...handles].map(async (h) =>
      map.set(h, await ensureIdentityForHandle(ctx.store, ctx.identities, thread.platform, h)),
    ),
  );
  const idOf = (h: string) => map.get(h) ?? h;
  const remapData = (data: Record<string, unknown>): Record<string, unknown> => {
    const t = strField(data.target);
    const as = strField(data.assignee);
    const ms = strArray(data.mentions);
    if (!t && !as && !ms.length) return data;
    return {
      ...data,
      ...(t ? { target: idOf(t) } : {}),
      ...(as ? { assignee: idOf(as) } : {}),
      ...(ms.length ? { mentions: ms.map(idOf) } : {}),
    };
  };

  return {
    ...thread,
    participants: [...new Set(thread.participants.map(idOf))],
    owner: thread.owner ? idOf(thread.owner) : undefined,
    meta: {
      ...thread.meta,
      ...(author ? { author: idOf(author) } : {}),
      ...(assignees.length ? { assignees: assignees.map(idOf) } : {}),
    },
    timeline: thread.timeline.map((e) => ({
      ...e,
      ...(e.actor ? { actor: idOf(e.actor) } : {}),
      data: remapData(e.data),
    })),
  };
}

const strField = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// --- Evaluate -----------------------------------------------------------------
// Run deterministic detectors over the thread. No LLM. Open/clear Signals by
// reconciling the currently-owed set against the open rows in D1.

const signalKey = (s: { kind: SignalKind; owedBy?: string }) => `${s.kind}:${s.owedBy ?? ""}`;

export async function evaluate(ctx: EngineContext, thread: Thread): Promise<Signal[]> {
  const open = await ctx.store.getOpenSignals(thread.nativeId);
  const now = ctx.clock.now().toISOString();

  // Universal stop condition: terminal thread clears all signals (DESIGN §7).
  if (isTerminal(thread)) {
    for (const s of open) await ctx.store.clearSignal(s.id, now);
    return [];
  }

  const dctx: DetectorContext = { config: ctx.config, clock: ctx.clock };
  const active: ActiveSignal[] = [];
  for (const d of detectors) {
    if (ctx.config.signals[d.kind]?.enabled) active.push(...d.detect(thread, dctx));
  }
  if (ctx.config.signals.blocker_cleared?.enabled) {
    active.push(...(await detectBlockerCleared(ctx, thread)));
  }
  if (ctx.config.llmJudge && ctx.config.signals.mentioned_no_response?.enabled) {
    active.push(...(await judgeUnansweredMentions(ctx, thread)));
  }

  // Reconcile: clear open signals no longer active; open newly-active ones.
  const activeKeys = new Set(active.map(signalKey));
  for (const s of open) if (!activeKeys.has(signalKey(s))) await ctx.store.clearSignal(s.id, now);

  const openKeys = new Set(open.map(signalKey));
  for (const s of active) {
    if (openKeys.has(signalKey(s))) continue; // already open; preserve detectedAt
    await ctx.store.upsertSignal({
      id: `${thread.nativeId}:${s.kind}:${s.owedBy ?? ""}`,
      threadId: thread.nativeId,
      kind: s.kind,
      owedBy: s.owedBy,
      detectedAt: now,
    });
  }
  return ctx.store.getOpenSignals(thread.nativeId);
}

/**
 * Cross-thread `blocker_cleared` (DESIGN §7): if every thread this one is
 * blocked_by has reached a terminal state, the blocked thread's owner is owed a
 * heads-up. Lives here (not a pure detector) because it reads the blockers'
 * states from the store.
 */
async function detectBlockerCleared(ctx: EngineContext, thread: Thread): Promise<ActiveSignal[]> {
  const links = await ctx.store.getLinks(thread.nativeId);
  const blockers = links
    .filter((l) => l.kind === "blocked_by" && l.from === thread.nativeId)
    .map((l) => l.to);
  if (!blockers.length) return [];

  let known = 0;
  for (const nid of blockers) {
    const t = await ctx.store.getThread(thread.platform, nid);
    if (!t) continue;
    if (!isTerminal(t)) return []; // still blocked by an open thread
    known++;
  }
  if (known === 0) return []; // we don't have the blockers' states yet

  const person =
    thread.owner ?? (typeof thread.meta.author === "string" ? thread.meta.author : undefined);
  return person ? [{ kind: "blocker_cleared", owedBy: person }] : [];
}

// --- Synthesize (LLM) ---------------------------------------------------------
// Update WorkingNotes; re-post only when contentHash changes.

export async function synthesize(
  ctx: EngineContext,
  thread: Thread,
  cluster?: Cluster,
): Promise<void> {
  const platform = ctx.platforms.get(thread.platform);
  if (!platform) return;

  // Linked work + the linked threads' states (best effort, from our store).
  const links = await ctx.store.getLinks(thread.nativeId);
  const counterparts = new Set(links.map((l) => (l.from === thread.nativeId ? l.to : l.from)));
  const linkedStates = new Map<string, string>();
  for (const nid of counterparts) {
    const lt = await ctx.store.getThread(thread.platform, nid);
    if (lt) linkedStates.set(nid, lt.state);
  }

  // Owner display handle (owner is a resolved Identity id).
  let ownerHandle: string | undefined;
  if (thread.owner) {
    const id = await ctx.store.getIdentity(thread.owner);
    ownerHandle = id?.handles[thread.platform] ?? id?.handles.github;
  }

  // Fold in the cluster's cross-thread summary (e.g. a linked Slack discussion)
  // so the issue note shows the shared picture, not just its own timeline.
  let related: string | undefined;
  let clusterHash = "";
  if (cluster && cluster.threadIds.length > 1) {
    const cn = await ctx.store.getWorkingNotes("cluster", cluster.id);
    if (cn) {
      related = clusterSummaryFor(cn.content);
      clusterHash = cn.contentHash;
    }
  }

  // Idempotency hash is over the INPUTS, not the (nondeterministic) LLM prose —
  // so identical inputs never re-post even if the model jitters (DESIGN §11).
  const parts = { thread, links, linkedStates, ownerHandle };
  const contentHash = stableHash(`${notesInputDigest(parts)}|cluster:${clusterHash}`);

  const stored = await ctx.store.getWorkingNotes("thread", thread.nativeId);
  const shadow = isShadowed(ctx.config, "workingNotes");

  // Up to date: in shadow, "computed" is enough; live also needs it actually posted.
  if (stored?.contentHash === contentHash && (shadow || stored.externalRef)) return;

  // Only call the LLM when something changed (bounds cost incl. in shadow).
  const summaryMarkdown = await ctx.llm.complete(buildNotesPrompt(thread), {
    cacheKey: `notes:${thread.nativeId}:${contentHash}`,
    temperature: 0,
  });
  // A transient empty LLM result must not overwrite a good note; retry next event.
  if (!summaryMarkdown.trim()) return;
  const content = renderWorkingNotes({ ...parts, summaryMarkdown, related }, contentHash);

  if (shadow) {
    // Compute + persist the would-be note (no externalRef = not posted), so a
    // later live run still posts the first real comment, and unchanged events
    // short-circuit above.
    await ctx.store.upsertWorkingNotes({
      scope: "thread",
      targetId: thread.nativeId,
      content,
      contentHash,
      provenance: `${thread.platform}:shadow`,
    });
    return;
  }

  // Edit-or-create exactly one sticky comment. Recover the id from the marker if
  // it wasn't persisted (retry after a partial post) or D1 lost it.
  let externalRef =
    stored?.externalRef ?? (await platform.findStickyComment(thread.nativeId, NOTES_MARKER));
  if (externalRef) {
    const ref = externalRef;
    const edited = await Result.from(() => platform.editMessage(ref, content));
    if (!edited.ok && !isNotFound(edited.error)) throw edited.error;
    if (!edited.ok) externalRef = undefined; // comment was deleted → re-post below
  }
  if (!externalRef) {
    externalRef = (await platform.postMessage({ threadNativeId: thread.nativeId }, content)).id;
  }

  await ctx.store.upsertWorkingNotes({
    scope: "thread",
    targetId: thread.nativeId,
    content,
    contentHash,
    provenance: `${thread.platform}:sticky`,
    externalRef,
  });
}

/** Strip the cluster note's hidden marker + hash footer for embedding in an issue note. */
function clusterSummaryFor(content: string): string {
  return content
    .replace(/<!--[^>]*-->/g, "")
    .replace(/<sub>aipm · [0-9a-f]+<\/sub>\s*$/g, "")
    .trim();
}

/** A deleted-comment HTTP error (status attached by the adapter's REST client). */
function isNotFound(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status;
  return status === 404 || status === 410;
}

// --- Route --------------------------------------------------------------------
// Open Signals -> Nudges: apply prefs, choose channel by priority, enforce
// dedupe/backoff + escalation, resolve Slack ids, send DMs (DESIGN §7).

export async function route(
  ctx: EngineContext,
  thread: Thread,
  signals: Signal[],
): Promise<Nudge[]> {
  const now = ctx.clock.now();
  const shadow = isShadowed(ctx.config, "nudges");
  const out: Nudge[] = [];

  for (const sig of signals) {
    if (!sig.owedBy) continue;
    const person = sig.owedBy;
    const identity = await ctx.store.getIdentity(person);

    // Bot exclusion + preferences (mute/snooze) always win (DESIGN §7/§8).
    if (isBotIdentity(person, identity?.handles.github, ctx.config.botAccounts)) continue;
    const prefs = await ctx.store.getPreferences(person);
    if (isSuppressed(prefs, thread, sig.kind, now)) continue;
    const elevated = isElevated(prefs, thread, sig.kind);

    const key = dedupeKey(person, thread.nativeId, sig.kind);
    const existing = await ctx.store.getNudgeByDedupeKey(key);
    const sigCfg = ctx.config.signals[sig.kind];
    // Shadow rows are not real deliveries: they neither throttle nor escalate the
    // first live send, so going live posts the first real nudge (DESIGN §8).
    const priorReal = existing && existing.state !== "shadow" ? existing : undefined;

    // Backoff: one nudge per dedupeKey per quiet period; quiet 0 = fire once
    // (e.g. blocker_cleared), suppressed once any real nudge exists (DESIGN §7).
    if (priorReal?.sentAt) {
      const quiet = sigCfg?.quietPeriodHours ?? 0;
      if (quiet === 0) continue;
      if (businessHoursBetween(new Date(priorReal.sentAt), now, ctx.config.calendar) < quiet) {
        continue;
      }
    }

    const escalations = (priorReal?.escalations ?? 0) + 1;
    let channel = chooseChannel(
      sig.kind,
      thread,
      escalations,
      sigCfg?.maxEscalations ?? Infinity,
      elevated,
    );

    // Resolve the DM target; no Slack id OR no Slack sender → digest (DESIGN §5).
    // handles.slack may be a roster-supplied username (not a U… id) — resolve it.
    const slack = ctx.platforms.get("slack");
    let dmTarget: typeof identity;
    if (channel === "dm") {
      let slackId = identity?.handles.slack;
      if (identity && slack?.resolvePerson && !looksLikeSlackId(slackId)) {
        slackId = await slack.resolvePerson(identity);
        if (slackId) await ctx.store.setIdentityHandle(identity.id, "slack", slackId);
      }
      if (slackId && slack && identity) {
        dmTarget = { ...identity, handles: { ...identity.handles, slack: slackId } };
      } else {
        channel = "digest";
      }
    }

    const nudge: Nudge = {
      person,
      signalId: sig.id,
      channel,
      dedupeKey: key,
      // Decision time drives backoff; state records whether it actually went out.
      sentAt: now.toISOString(),
      state: shadow ? "shadow" : channel === "dm" ? "sent" : "pending",
      escalations,
    };
    // Persist BEFORE the side effect so an at-least-once retry sees the dedupe
    // row and won't re-DM (at-most-once per period; the open signal re-nudges
    // next period if a send was lost).
    const isFirstRealSend = !shadow && !priorReal;
    const claimed = isFirstRealSend ? await ctx.store.tryClaimNudge(nudge) : true;
    if (!claimed) continue;
    if (!isFirstRealSend) await ctx.store.upsertNudge(nudge);
    if (channel === "dm" && !shadow && slack && dmTarget) {
      await slack.notifyPerson(dmTarget, buildNudgeMessage(thread, sig.kind));
    }
    out.push(nudge);
  }
  return out;
}

/** A resolved Slack user id (U…/W…) vs a roster-supplied username to resolve. */
const looksLikeSlackId = (s: string | undefined): boolean => !!s && /^[UW][A-Z0-9]{6,}$/.test(s);

function isBotIdentity(id: string, githubHandle: string | undefined, bots: string[]): boolean {
  if (githubHandle) return githubHandle.endsWith("[bot]") || bots.includes(githubHandle);
  return id.endsWith("[bot]") || bots.some((b) => id === `github:${b}`);
}

const lc = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : undefined);

/** Does a preference's selector apply to this thread/signal? Repo + threadId are
 *  matched case-insensitively (GitHub slugs are case-insensitive). */
function selectorMatches(
  selector: Record<string, unknown>,
  thread: Thread,
  kind: SignalKind,
): boolean {
  const repo = lc(thread.meta.repo);
  if (selector.threadId && lc(selector.threadId) !== thread.nativeId.toLowerCase()) return false;
  if (selector.repo && lc(selector.repo) !== repo) return false;
  if (selector.kind && selector.kind !== kind) return false;
  return true;
}

function isSuppressed(prefs: Preference[], thread: Thread, kind: SignalKind, now: Date): boolean {
  for (const p of prefs) {
    if (!selectorMatches(p.selector, thread, kind)) continue;
    if (p.rule === "mute") return true;
    if (p.rule === "snooze" && (!p.until || Date.parse(p.until) > now.getTime())) return true;
  }
  return false;
}

/** "I care about repo X high-pri" / "I own Z" → elevate matching nudges to DM. */
function isElevated(prefs: Preference[], thread: Thread, kind: SignalKind): boolean {
  return prefs.some(
    (p) =>
      (p.rule === "own" || (p.rule === "route" && p.selector.priority === "high")) &&
      selectorMatches(p.selector, thread, kind),
  );
}

// --- Aggregate ----------------------------------------------------------------
// Per-person digest: collect queued digest nudges, DM each person one summary,
// and mark them delivered (DESIGN §8). Org rollup over cluster notes is phase-5.

export async function aggregate(ctx: EngineContext): Promise<void> {
  const pending = await ctx.store.listPendingDigestNudges();
  const slack = ctx.platforms.get("slack");
  const shadow = isShadowed(ctx.config, "digest");
  const now = ctx.clock.now().toISOString();

  const byPerson = new Map<string, typeof pending>();
  for (const n of pending)
    (byPerson.get(n.person) ?? byPerson.set(n.person, []).get(n.person)!).push(n);

  for (const [person, nudges] of byPerson) {
    const identity = await ctx.store.getIdentity(person);

    // Split still-owed vs dead (signal cleared/missing). Dead nudges are reaped
    // regardless of deliverability so they aren't re-scanned by every digest.
    const live: { line: string; nudge: (typeof nudges)[number] }[] = [];
    for (const n of nudges) {
      const sig = await ctx.store.getSignal(n.signalId);
      if (sig && !sig.clearedAt) {
        live.push({ line: `• ${signalLabel(sig.kind)} — \`${sig.threadId}\``, nudge: n });
      } else {
        await ctx.store.upsertNudge({ ...n, state: "cleared" });
      }
    }
    if (!live.length) continue;

    // Can't deliver (shadow / no Slack adapter / no identity): leave live nudges
    // pending so a later digest with a delivery path still sends them.
    if (shadow || !slack || !identity) continue;

    // A roster handle may be a username, not a real U…/W… id. Resolve it (as
    // route does), cache the resolution, and deliver only to a real id — never a
    // raw handle, which can collide with a different real user.
    const rosterHandle = identity.handles.slack;
    const resolver = slack.resolvePerson;
    const handleIsSlackId = looksLikeSlackId(rosterHandle);
    const slackId = await (async () => {
      if (handleIsSlackId) return rosterHandle;
      if (!resolver) return undefined;
      const resolved = await resolver(identity);
      if (resolved) await ctx.store.setIdentityHandle(identity.id, "slack", resolved);
      return resolved;
    })();

    const isDeliverable = looksLikeSlackId(slackId);
    if (!isDeliverable) continue;

    // Claim before delivery (at-most-once): mark sent first so a cron re-fire or
    // mid-loop crash can't double-DM; a lost send re-digests after the quiet period.
    for (const { nudge } of live)
      await ctx.store.upsertNudge({ ...nudge, state: "sent", sentAt: now });
    const body = `🗒️ *Your plate* — ${live.length} item(s):\n${live.map((l) => l.line).join("\n")}`;
    await slack.notifyPerson(
      { ...identity, handles: { ...identity.handles, slack: slackId } },
      body,
    );
  }
}
