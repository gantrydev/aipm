import { businessHoursBetween } from "./clock.js";
import { asyncMap, groupBy } from "./common.helper.js";
import { isTerminal, type ActiveSignal } from "./detectors.js";
import type { Thread } from "./domain.js";
import { stableHash } from "./notes.js";
import type { EngineContext } from "./pipeline.js";
import { Ok, Result } from "./result.js";

const ts = (iso: string) => Date.parse(iso);

/**
 * LLM-judged refinement of `mentioned_no_response` (DESIGN §6): the deterministic
 * detector clears the signal as soon as the mentioned person comments again, but
 * a reply isn't always an answer. For each mention that DID get a later reply,
 * ask the model whether the reply actually addressed it; if not, the person is
 * still owed. (No-reply mentions are handled by the deterministic detector.)
 * Bounded: one cached judgment per (mention, reply) pair, only when llmJudge is on.
 */
export async function judgeUnansweredMentions(
  ctx: EngineContext,
  thread: Thread,
): Promise<Result<Array<ActiveSignal>, Error>> {
  if (isTerminal(thread)) return Ok([]);
  const quiet = ctx.config.signals.mentioned_no_response?.quietPeriodHours ?? Infinity;
  const now = ctx.clock.now();

  const msgs = thread.timeline.filter(
    (e) => (e.kind === "comment" || e.kind === "review") && typeof e.data.body === "string",
  );

  // Flatten to (id, mention) events, then keep the latest mention per identity.
  const mentionEvents = msgs.flatMap((e) => {
    const mentions = (Array.isArray(e.data.mentions) ? e.data.mentions : []) as Array<string>;
    return mentions.flatMap((id) => {
      const isSelfMention = id === e.actor;
      if (isSelfMention) return [];
      const text = String(e.data.body);
      return [{ id, at: e.at, text }];
    });
  });
  const byId = groupBy(mentionEvents, (m) => m.id);
  const lastMention = Object.values(byId).flatMap((group) => {
    if (!group) return [];
    const latest = group.reduce((a, b) => {
      const bIsLater = ts(b.at) > ts(a.at);
      return bIsLater ? b : a;
    });
    return [latest];
  });

  // A reply exists but may not answer; no reply → deterministic detector owns it.
  const candidates = lastMention.flatMap((m) => {
    const reply = msgs.find((e) => e.actor === m.id && ts(e.at) > ts(m.at));
    if (!reply) return [];
    const waited = businessHoursBetween(new Date(m.at), now, ctx.config.calendar);
    if (waited < quiet) return [];
    const replyText = String(reply.data.body);
    return [{ id: m.id, mention: m.text, reply: replyText }];
  });
  const judgedResults = await asyncMap(candidates, async (c) => {
    const answeredResult = await judge(ctx, thread.nativeId, c.id, c.mention, c.reply);
    if (!answeredResult.ok) return answeredResult;
    const answered = answeredResult.data;
    if (answered) return Ok(null);
    const signal = { kind: "mentioned_no_response" as const, owedBy: c.id };
    return Ok(signal);
  });
  const judgedErrors = judgedResults.flatMap((it) => (it.ok ? [] : [it]));
  const firstJudgedError = judgedErrors[0];
  if (firstJudgedError) return firstJudgedError;
  const signals = judgedResults.flatMap((it) => {
    if (!it.ok) return [];
    if (!it.data) return [];
    return [it.data];
  });
  return Ok(signals);
}

async function judge(
  ctx: EngineContext,
  nativeId: string,
  who: string,
  mention: string,
  reply: string,
): Promise<Result<boolean, Error>> {
  const prompt = [
    "A teammate was @-mentioned with a question or request, then later replied.",
    'Did their reply actually address it? Answer with only "yes" or "no".',
    "",
    `Mention: ${mention.slice(0, 1500)}`,
    `Reply: ${reply.slice(0, 1500)}`,
  ].join("\n");
  const cacheInput = `${mention}\0${reply}`;
  const verdict = await ctx.llm.complete(prompt, {
    cacheKey: `judge:${nativeId}:${who}:${stableHash(cacheInput)}`,
    temperature: 0,
  });
  if (!verdict.ok) return verdict;
  // Treat anything that isn't a clear "no" as answered, to avoid over-nudging.
  return Ok(!/\bno\b/i.test(verdict.data) || /\byes\b/i.test(verdict.data));
}
