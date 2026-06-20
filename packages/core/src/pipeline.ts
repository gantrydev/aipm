import type { Clock } from "./clock.js";
import { isShadowed, type EngineConfig } from "./config.js";
import { detectors, isTerminal, type DetectorContext } from "./detectors.js";
import type { Nudge, PlatformId, Signal, Thread } from "./domain.js";
import { ensureIdentityForHandle } from "./identity-source.js";
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
 * Map every platform handle on a thread (participants, owner, and each timeline
 * actor — a superset of participants) to a canonical Identity id. Resolves each
 * distinct handle once and reuses the map, so the persisted Thread is uniformly
 * in the Identity-id namespace (domain.ts contract for actor/owner/participants).
 */
async function resolveThreadIdentities(ctx: EngineContext, thread: Thread): Promise<Thread> {
  const handles = new Set<string>(thread.participants);
  if (thread.owner) handles.add(thread.owner);
  for (const e of thread.timeline) if (e.actor) handles.add(e.actor);

  const map = new Map<string, string>();
  await Promise.all(
    [...handles].map(async (h) =>
      map.set(h, await ensureIdentityForHandle(ctx.store, ctx.identities, thread.platform, h)),
    ),
  );

  const idOf = (h: string) => map.get(h) ?? h;
  return {
    ...thread,
    participants: [...new Set(thread.participants.map(idOf))],
    owner: thread.owner ? idOf(thread.owner) : undefined,
    timeline: thread.timeline.map((e) => (e.actor ? { ...e, actor: idOf(e.actor) } : e)),
  };
}

// --- Evaluate -----------------------------------------------------------------
// Run deterministic detectors over the thread. No LLM. Emit/clear Signals.

export async function evaluate(ctx: EngineContext, thread: Thread): Promise<Signal[]> {
  const openSignals = await ctx.store.getOpenSignals(thread.nativeId);
  const dctx: DetectorContext = { config: ctx.config, clock: ctx.clock, openSignals };

  // Universal stop condition: terminal thread clears all signals.
  if (isTerminal(thread)) {
    const at = ctx.clock.now().toISOString();
    for (const sig of openSignals) await ctx.store.clearSignal(sig.id, at);
    return [];
  }

  // TODO(phase-3): persist opened/cleared signals from detector results.
  for (const d of detectors) {
    if (!ctx.config.signals[d.kind]?.enabled) continue;
    d.detect(thread, dctx);
  }
  return ctx.store.getOpenSignals(thread.nativeId);
}

// --- Synthesize (LLM) ---------------------------------------------------------
// Update WorkingNotes; re-post only when contentHash changes.

export async function synthesize(ctx: EngineContext, thread: Thread): Promise<void> {
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

  // Idempotency hash is over the INPUTS, not the (nondeterministic) LLM prose —
  // so identical inputs never re-post even if the model jitters (DESIGN §11).
  const parts = { thread, links, linkedStates, ownerHandle };
  const contentHash = stableHash(notesInputDigest(parts));

  const stored = await ctx.store.getWorkingNotes("thread", thread.nativeId);
  const shadow = isShadowed(ctx.config, "workingNotes");

  // Up to date: in shadow, "computed" is enough; live also needs it actually posted.
  if (stored?.contentHash === contentHash && (shadow || stored.externalRef)) return;

  // Only call the LLM when something changed (bounds cost incl. in shadow).
  const summaryMarkdown = await ctx.llm.complete(buildNotesPrompt(thread), {
    cacheKey: `notes:${thread.nativeId}:${contentHash}`,
    temperature: 0,
  });
  const content = renderWorkingNotes({ ...parts, summaryMarkdown }, contentHash);

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
    try {
      await platform.editMessage(externalRef, content);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      externalRef = undefined; // comment was deleted → fall through to re-post
    }
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

/** A deleted-comment HTTP error (status attached by the adapter's REST client). */
function isNotFound(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status;
  return status === 404 || status === 410;
}

// --- Route --------------------------------------------------------------------
// Open Signals -> Nudges: prefs, channel-by-priority, dedupe/backoff.

export async function route(ctx: EngineContext, signals: Signal[]): Promise<Nudge[]> {
  // TODO(phase-3): apply Preferences, dedupe by key + quiet period, escalate,
  // LLM only for wording, respect shadow.capabilities.nudges.
  void ctx;
  void signals;
  return [];
}

// --- Aggregate ----------------------------------------------------------------
// Per-person digests + cluster-notes rollup.

export async function aggregate(ctx: EngineContext): Promise<void> {
  // TODO(phase-4/5): build per-person digest + org rollup over cluster notes.
  void ctx;
}
