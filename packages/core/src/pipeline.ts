import type { Clock } from "./clock.js";
import type { EngineConfig } from "./config.js";
import { detectors, isTerminal, type DetectorContext } from "./detectors.js";
import type { Nudge, PlatformId, Signal, Thread } from "./domain.js";
import { ensureIdentityForHandle } from "./identity-source.js";
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
  // TODO(phase-2): build notes via ctx.llm, hash, compare to stored hash,
  // edit sticky comment only on change. Respect shadow.capabilities.workingNotes.
  void ctx;
  void thread;
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
