import { Err, Ok, Result } from "./result.js";
import { businessHoursBetween, type Clock } from "./clock.js";
import { isShadowed, type EngineConfig } from "./config.js";
import { detectors, isTerminal, type ActiveSignal, type DetectorContext } from "./detectors.js";
import type { Cluster, Identity, Nudge, Preference, Signal, SignalKind, Thread } from "./domain.js";
import type { PlatformId } from "./domain.js";
import { ensureIdentityForHandle } from "./identity-source.js";
import { judgeUnansweredMentions } from "./judge.js";
import { buildNudgeMessage, chooseChannel, signalLabel } from "./nudge.js";
import { dedupeKey } from "./cluster.js";
import { asyncForEach, asyncMap, groupBy, unwrap } from "./common.helper.js";
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

export async function ingest(
  ctx: EngineContext,
  event: RawEvent,
): Promise<Result<Thread | undefined, Error>> {
  const platform = ctx.platforms.get(event.platform);
  if (!platform) return Err(new Error(`No adapter for platform: ${event.platform}`));

  const normalized = Result.fromSync(() => platform.normalizeEvent(event));
  if (!normalized.ok) return normalized;
  const ref = normalized.data;
  if (!ref) return Ok(undefined); // ignored event kind

  // Adapter returns participants/owner as platform handles (see Platform docs);
  // resolve them to canonical Identity ids and persist the rows.
  const fetched = await platform.getThread(ref.nativeId, ref.type);
  if (!fetched.ok) return fetched;
  const ingested = await ingestThread(ctx, fetched.data);
  if (!ingested.ok) return ingested;
  return Ok(ingested.data);
}

export async function ingestThread(
  ctx: EngineContext,
  thread: Thread,
): Promise<Result<Thread, Error>> {
  const platform = ctx.platforms.get(thread.platform);
  if (!platform) return Err(new Error(`No adapter for platform: ${thread.platform}`));

  const resolvedResult = await resolveThreadIdentities(ctx, thread);
  if (!resolvedResult.ok) return resolvedResult;
  const resolved = resolvedResult.data;

  const upsertedThread = await ctx.store.upsertThread(resolved);
  if (!upsertedThread.ok) return upsertedThread;

  const links = await platform.discoverLinks(resolved);
  if (!links.ok) return links;
  const outgoingLinks = links.data.flatMap((link) =>
    link.from === resolved.nativeId ? [link] : [],
  );
  const replacedLinks = await ctx.store.replaceLinksFrom(resolved.nativeId, outgoingLinks);
  if (!replacedLinks.ok) return replacedLinks;

  return Ok(resolved);
}

/**
 * Map every platform handle on a thread to a canonical Identity id: participants,
 * owner, meta.author, meta.assignees, and per-timeline-event actor + the person
 * fields in `data` (target, assignee, mentions). Resolves each distinct handle
 * once so the persisted Thread is uniformly in the Identity-id namespace, which
 * the detectors (DESIGN §7) rely on for matching owed-by against repliers.
 */
async function resolveThreadIdentities(
  ctx: EngineContext,
  thread: Thread,
): Promise<Result<Thread, Error>> {
  const author = strField(thread.meta.author);
  const assignees = strArray(thread.meta.assignees);
  const timelineHandles = thread.timeline.flatMap((e) => {
    const actor = e.actor ? [e.actor] : [];
    const target = strField(e.data.target);
    const assignee = strField(e.data.assignee);
    const mentions = strArray(e.data.mentions);
    return [...actor, ...(target ? [target] : []), ...(assignee ? [assignee] : []), ...mentions];
  });
  const handles = new Set<string>([
    ...thread.participants,
    ...(thread.owner ? [thread.owner] : []),
    ...(author ? [author] : []),
    ...assignees,
    ...timelineHandles,
  ]);

  const handleEntriesResult = await Result.from(() =>
    asyncMap([...handles], async (handle) => {
      const id = unwrap(
        await ensureIdentityForHandle(ctx.store, ctx.identities, thread.platform, handle),
      );
      return [handle, id] as const;
    }),
  );
  if (!handleEntriesResult.ok) return handleEntriesResult;
  const map = new Map<string, string>(handleEntriesResult.data);
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

  return Ok({
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
  });
}

const strField = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
export const platformForNativeId = (nativeId: string): PlatformId =>
  nativeId.includes("#") ? "github" : "slack";

// Web URL for a thread nativeId, when one can be derived. GitHub nativeIds are
// `owner/repo#number`; /issues/N redirects to /pull/N for PRs, so it covers both.
export const nativeIdWebUrl = (nativeId: string): string | undefined => {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(nativeId);
  return m ? `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}` : undefined;
};

// Slack mrkdwn ref: a clickable link when we can derive a URL, else inline code.
export const digestRefMrkdwn = (nativeId: string): string => {
  const url = nativeIdWebUrl(nativeId);
  return url ? `<${url}|${nativeId}>` : `\`${nativeId}\``;
};

// --- Evaluate -----------------------------------------------------------------
// Run deterministic detectors over the thread. No LLM. Open/clear Signals by
// reconciling the currently-owed set against the open rows in D1.

const signalKey = (s: { kind: SignalKind; owedBy?: string }) => `${s.kind}:${s.owedBy ?? ""}`;

export async function evaluate(
  ctx: EngineContext,
  thread: Thread,
): Promise<Result<Signal[], Error>> {
  const openSignals = await ctx.store.getOpenSignals(thread.nativeId);
  if (!openSignals.ok) return openSignals;
  const open = openSignals.data;
  const now = ctx.clock.now().toISOString();

  // Universal stop condition: terminal thread clears all signals (DESIGN §7).
  if (isTerminal(thread)) {
    const cleared = await Result.from(() =>
      asyncForEach(open, async (s) => {
        unwrap(await ctx.store.clearSignal(s.id, now));
      }),
    );
    if (!cleared.ok) return cleared;
    return Ok([]);
  }

  const dctx: DetectorContext = { config: ctx.config, clock: ctx.clock };
  const active: ActiveSignal[] = detectors.flatMap((d) => {
    const enabled = ctx.config.signals[d.kind]?.enabled;
    return enabled ? d.detect(thread, dctx) : [];
  });
  if (ctx.config.signals.blocker_cleared?.enabled) {
    const blockerCleared = await detectBlockerCleared(ctx, thread);
    if (!blockerCleared.ok) return blockerCleared;
    active.push(...blockerCleared.data);
  }
  if (ctx.config.llmJudge && ctx.config.signals.mentioned_no_response?.enabled) {
    const judgedMentions = await judgeUnansweredMentions(ctx, thread);
    if (!judgedMentions.ok) return judgedMentions;
    active.push(...judgedMentions.data);
  }

  // Reconcile: clear open signals no longer active; open newly-active ones.
  const activeKeys = new Set(active.map(signalKey));
  const reconciledClear = await Result.from(() =>
    asyncForEach(open, async (s) => {
      if (activeKeys.has(signalKey(s))) return;
      unwrap(await ctx.store.clearSignal(s.id, now));
    }),
  );
  if (!reconciledClear.ok) return reconciledClear;

  const openKeys = new Set(open.map(signalKey));
  const opened = await Result.from(() =>
    asyncForEach(active, async (s) => {
      if (openKeys.has(signalKey(s))) return; // already open; preserve detectedAt
      unwrap(
        await ctx.store.upsertSignal({
          id: `${thread.nativeId}:${s.kind}:${s.owedBy ?? ""}`,
          threadId: thread.nativeId,
          kind: s.kind,
          owedBy: s.owedBy,
          detectedAt: now,
        }),
      );
    }),
  );
  if (!opened.ok) return opened;
  const currentOpen = await ctx.store.getOpenSignals(thread.nativeId);
  if (!currentOpen.ok) return currentOpen;
  return Ok(currentOpen.data);
}

/**
 * Cross-thread `blocker_cleared` (DESIGN §7): if every thread this one is
 * blocked_by has reached a terminal state, the blocked thread's owner is owed a
 * heads-up. Lives here (not a pure detector) because it reads the blockers'
 * states from the store.
 */
async function detectBlockerCleared(
  ctx: EngineContext,
  thread: Thread,
): Promise<Result<ActiveSignal[], Error>> {
  const linksResult = await ctx.store.getLinks(thread.nativeId);
  if (!linksResult.ok) return linksResult;
  const links = linksResult.data;
  const blockers = links
    .filter((l) => l.kind === "blocked_by" && l.from === thread.nativeId)
    .map((l) => l.to);
  if (!blockers.length) return Ok([]);

  const blockerThreadsResult = await Result.from(() =>
    asyncMap(blockers, async (nativeId) => {
      return unwrap(await ctx.store.getThread(thread.platform, nativeId));
    }),
  );
  if (!blockerThreadsResult.ok) return blockerThreadsResult;
  const present = blockerThreadsResult.data.flatMap((t) => (t ? [t] : []));
  if (present.length === 0) return Ok([]); // we don't have the blockers' states yet
  const anyStillOpen = present.some((t) => !isTerminal(t));
  if (anyStillOpen) return Ok([]); // still blocked by an open thread

  const person =
    thread.owner ?? (typeof thread.meta.author === "string" ? thread.meta.author : undefined);
  return Ok(person ? [{ kind: "blocker_cleared", owedBy: person }] : []);
}

// --- Synthesize (LLM) ---------------------------------------------------------
// Update WorkingNotes; re-post only when contentHash changes.

export async function synthesize(
  ctx: EngineContext,
  thread: Thread,
  cluster?: Cluster,
): Promise<Result<void, Error>> {
  const platform = ctx.platforms.get(thread.platform);
  if (!platform) return Ok(undefined);

  // Linked work + the linked threads' states (best effort, from our store).
  const linksResult = await ctx.store.getLinks(thread.nativeId);
  if (!linksResult.ok) return linksResult;
  const links = linksResult.data;
  const counterparts = new Set(links.map((l) => (l.from === thread.nativeId ? l.to : l.from)));
  const counterpartStatesResult = await Result.from(() =>
    asyncMap([...counterparts], async (nid) => {
      const lt = unwrap(await ctx.store.getThread(platformForNativeId(nid), nid));
      return lt ? ([nid, lt.state] as const) : null;
    }),
  );
  if (!counterpartStatesResult.ok) return counterpartStatesResult;
  const presentStates = counterpartStatesResult.data.flatMap((entry) => (entry ? [entry] : []));
  const linkedStates = new Map(presentStates);

  // Owner display handle (owner is a resolved Identity id).
  const identity = thread.owner ? await ctx.store.getIdentity(thread.owner) : Ok(undefined);
  if (!identity.ok) return identity;
  const ownerHandle = (() => {
    if (!thread.owner) return undefined;
    const id = identity.data;
    return id?.handles[thread.platform] ?? id?.handles.github;
  })();

  // Fold in the cluster's cross-thread summary (e.g. a linked Slack discussion)
  // so the issue note shows the shared picture, not just its own timeline.
  let related: string | undefined;
  let clusterHash = "";
  if (cluster && cluster.threadIds.length > 1) {
    const clusterNotes = await ctx.store.getWorkingNotes("cluster", cluster.id);
    if (!clusterNotes.ok) return clusterNotes;
    const cn = clusterNotes.data;
    if (cn) {
      related = clusterSummaryFor(cn.content);
      clusterHash = cn.contentHash;
    }
  }

  // Idempotency hash is over the INPUTS, not the (nondeterministic) LLM prose —
  // so identical inputs never re-post even if the model jitters (DESIGN §11).
  const parts = { thread, links, linkedStates, ownerHandle };
  const contentHash = stableHash(`${notesInputDigest(parts)}|cluster:${clusterHash}`);

  const storedNotes = await ctx.store.getWorkingNotes("thread", thread.nativeId);
  if (!storedNotes.ok) return storedNotes;
  const stored = storedNotes.data;
  const shadow = isShadowed(ctx.config, "workingNotes");

  // Up to date: in shadow, "computed" is enough; live also needs it actually posted.
  if (stored?.contentHash === contentHash && (shadow || stored.externalRef)) return Ok(undefined);

  // Only call the LLM when something changed (bounds cost incl. in shadow).
  const completed = await ctx.llm.complete(buildNotesPrompt(thread), {
    cacheKey: `notes:${thread.nativeId}:${contentHash}`,
    temperature: 0,
  });
  if (!completed.ok) return completed;
  const summaryMarkdown = completed.data;
  // A transient empty LLM result must not overwrite a good note; retry next event.
  if (!summaryMarkdown.trim()) return Ok(undefined);
  const content = renderWorkingNotes({ ...parts, summaryMarkdown, related }, contentHash);

  if (shadow) {
    // Compute + persist the would-be note (no externalRef = not posted), so a
    // later live run still posts the first real comment, and unchanged events
    // short-circuit above.
    const upserted = await ctx.store.upsertWorkingNotes({
      scope: "thread",
      targetId: thread.nativeId,
      content,
      contentHash,
      provenance: `${thread.platform}:shadow`,
    });
    if (!upserted.ok) return upserted;
    return Ok(undefined);
  }

  // Edit-or-create exactly one sticky comment. Recover the id from the marker if
  // it wasn't persisted (retry after a partial post) or D1 lost it.
  let externalRef = stored?.externalRef;
  if (!externalRef) {
    const stickyComment = await platform.findStickyComment(thread.nativeId, NOTES_MARKER);
    if (!stickyComment.ok) return stickyComment;
    externalRef = stickyComment.data;
  }
  if (externalRef) {
    const ref = externalRef;
    const edited = await platform.editMessage(ref, content);
    if (!edited.ok && !isNotFound(edited.error)) return edited; // propagate non-404
    if (!edited.ok) externalRef = undefined; // 404/410 → re-post below
  }
  if (!externalRef) {
    const posted = await platform.postMessage({ threadNativeId: thread.nativeId }, content);
    if (!posted.ok) return posted;
    externalRef = posted.data.id;
  }

  const upserted = await ctx.store.upsertWorkingNotes({
    scope: "thread",
    targetId: thread.nativeId,
    content,
    contentHash,
    provenance: `${thread.platform}:sticky`,
    externalRef,
  });
  if (!upserted.ok) return upserted;
  return Ok(undefined);
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
  if (typeof e !== "object") return false;
  if (e === null) return false;
  if (!("status" in e)) return false;
  const status = e.status;
  return status === 404 || status === 410;
}

// --- Route --------------------------------------------------------------------
// Open Signals -> Nudges: apply prefs, choose channel by priority, enforce
// dedupe/backoff + escalation, resolve Slack ids, send DMs (DESIGN §7).

export async function route(
  ctx: EngineContext,
  thread: Thread,
  signals: Signal[],
): Promise<Result<Nudge[], Error>> {
  const now = ctx.clock.now();
  const shadow = isShadowed(ctx.config, "nudges");
  const out: Nudge[] = [];

  const routed = await Result.from(() =>
    asyncForEach(signals, async (sig) => {
      if (!sig.owedBy) return;
      const person = sig.owedBy;
      const identity = unwrap(await ctx.store.getIdentity(person));

      // Bot exclusion + preferences (mute/snooze) always win (DESIGN §7/§8).
      if (isBotIdentity(person, identity?.handles.github, ctx.config.botAccounts)) return;
      const prefs = unwrap(await ctx.store.getPreferences(person));
      if (isSuppressed(prefs, thread, sig.kind, now)) return;
      const elevated = isElevated(prefs, thread, sig.kind);

      const key = dedupeKey(person, thread.nativeId, sig.kind);
      const existing = unwrap(await ctx.store.getNudgeByDedupeKey(key));
      const sigCfg = ctx.config.signals[sig.kind];
      // Shadow rows are not real deliveries: they neither throttle nor escalate the
      // first live send, so going live posts the first real nudge (DESIGN §8).
      const priorReal = existing && existing.state !== "shadow" ? existing : undefined;

      // Backoff: one nudge per dedupeKey per quiet period; quiet 0 = fire once
      // (e.g. blocker_cleared), suppressed once any real nudge exists (DESIGN §7).
      if (priorReal?.sentAt) {
        const quiet = sigCfg?.quietPeriodHours ?? 0;
        if (quiet === 0) return;
        if (businessHoursBetween(new Date(priorReal.sentAt), now, ctx.config.calendar) < quiet) {
          return;
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
        const slackId = identity
          ? unwrap(await resolveSlackUserId(ctx, slack, identity))
          : undefined;
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
      const claimed = isFirstRealSend ? unwrap(await ctx.store.tryClaimNudge(nudge)) : true;
      if (!claimed) return;
      if (!isFirstRealSend) {
        unwrap(await ctx.store.upsertNudge(nudge));
      }
      if (channel === "dm" && !shadow && slack && dmTarget) {
        unwrap(await slack.notifyPerson(dmTarget, buildNudgeMessage(thread, sig.kind)));
      }
      out.push(nudge);
    }),
  );
  if (!routed.ok) return routed;
  return Ok(out);
}

/** A resolved Slack user id (U…/W…) vs a roster-supplied username to resolve. */
const looksLikeSlackId = (s: string | undefined): s is string =>
  !!s && /^[UW][A-Z0-9]{6,}$/.test(s);

async function resolveSlackUserId(
  ctx: EngineContext,
  slack: Platform | undefined,
  identity: Identity,
): Promise<Result<string | undefined, Error>> {
  const rosterHandle = identity.handles.slack;
  if (looksLikeSlackId(rosterHandle)) return Ok(rosterHandle);
  const resolveFn = slack?.resolvePerson;
  if (!resolveFn) return Ok(undefined);

  const resolvedResult = await resolveFn(identity);
  if (!resolvedResult.ok) return resolvedResult;
  const resolved = resolvedResult.data;
  if (!looksLikeSlackId(resolved)) return Ok(undefined);

  const stored = await ctx.store.setIdentityHandle(identity.id, "slack", resolved);
  if (!stored.ok) return stored;
  return Ok(resolved);
}

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
  return prefs.some((p) => {
    const matches = selectorMatches(p.selector, thread, kind);
    if (!matches) return false;
    if (p.rule === "mute") return true;
    const notExpired = !p.until || Date.parse(p.until) > now.getTime();
    const activeSnooze = p.rule === "snooze" && notExpired;
    return activeSnooze;
  });
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

export async function aggregate(ctx: EngineContext): Promise<Result<void, Error>> {
  const pendingResult = await ctx.store.listPendingDigestNudges();
  if (!pendingResult.ok) return pendingResult;
  const pending = pendingResult.data;
  const slack = ctx.platforms.get("slack");
  const shadow = isShadowed(ctx.config, "digest");
  const now = ctx.clock.now().toISOString();

  const byPerson = groupBy(pending, (n) => n.person);

  const aggregated = await Result.from(() =>
    asyncForEach(Object.entries(byPerson), async ([person, nudges]) => {
      if (!nudges) return;
      const identity = unwrap(await ctx.store.getIdentity(person));

      // Split still-owed vs dead (signal cleared/missing). Dead nudges are reaped
      // regardless of deliverability so they aren't re-scanned by every digest.
      const evaluated = await asyncMap(nudges, async (n) => {
        const sig = unwrap(await ctx.store.getSignal(n.signalId));
        if (sig && !sig.clearedAt) {
          const line = `• ${signalLabel(sig.kind)} — ${digestRefMrkdwn(sig.threadId)}`;
          return { kind: "live" as const, line, nudge: n };
        }
        unwrap(await ctx.store.upsertNudge({ ...n, state: "cleared" }));
        return { kind: "dead" as const };
      });
      const live = evaluated.flatMap((entry) => {
        if (entry.kind !== "live") return [];
        return [{ line: entry.line, nudge: entry.nudge }];
      });
      if (!live.length) return;

      // Can't deliver (shadow / no Slack adapter / no identity): leave live nudges
      // pending so a later digest with a delivery path still sends them.
      if (shadow || !slack || !identity) return;

      const slackId = unwrap(await resolveSlackUserId(ctx, slack, identity));
      if (!slackId) return;

      // Claim before delivery (at-most-once): mark sent first so a cron re-fire or
      // mid-loop crash can't double-DM; a lost send re-digests after the quiet period.
      await asyncForEach(live, async (item) => {
        unwrap(await ctx.store.upsertNudge({ ...item.nudge, state: "sent", sentAt: now }));
      });
      const body = `🗒️ *Your plate* — ${live.length} item(s):\n${live.map((l) => l.line).join("\n")}`;
      unwrap(
        await slack.notifyPerson(
          { ...identity, handles: { ...identity.handles, slack: slackId } },
          body,
        ),
      );
    }),
  );
  if (!aggregated.ok) return aggregated;
  return Ok(undefined);
}
