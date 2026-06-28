import type { Preference } from "./domain.js";
import type { EngineContext } from "./pipeline.js";

export type ParsedPreference = Omit<Preference, "person">;

/**
 * Parse a free-text Slack preference command (DESIGN §8) into a Preference.
 * Deterministic patterns cover the documented commands; freeform LLM parsing is
 * a later enhancement. Returns undefined when nothing matches.
 */
export function parsePreferenceText(text: string, now: Date): ParsedPreference | undefined {
  let m: RegExpExecArray | null;

  // A #N token anywhere after "mute" means a single-thread mute (incl. the
  // "mute repo owner/name#5" phrasing); otherwise "mute repo X" is repo-wide.
  if ((m = /\bmute\b[^]*?(\S+#\d+)/i.exec(text)))
    return { rule: "mute", selector: { threadId: m[1]! } };
  if ((m = /\bmute\s+repo\s+([^\s#]+)/i.exec(text)))
    return { rule: "mute", selector: { repo: m[1]! } };

  if ((m = /\bsnooze\b[^]*?\bfor\s+(\d+)\s*(hour|day)s?/i.exec(text))) {
    const unit = m[2]!.toLowerCase() === "day" ? 86_400 : 3_600;
    return {
      rule: "snooze",
      selector: {},
      until: new Date(now.getTime() + Number(m[1]) * unit * 1000).toISOString(),
    };
  }
  if ((m = /\bsnooze\b[^]*?\b(?:to|until)\s+(\d{4}-\d{2}-\d{2})/i.exec(text)))
    return { rule: "snooze", selector: {}, until: `${m[1]}T00:00:00.000Z` };

  if ((m = /\bcare\s+about\s+repo\s+([^\s#]+)/i.exec(text))) {
    const selector: Record<string, unknown> = { repo: m[1]! };
    if (/high/i.test(text)) selector.priority = "high";
    return { rule: "route", selector };
  }
  if ((m = /\bown\s+(\S+#\d+)/i.exec(text))) return { rule: "own", selector: { threadId: m[1]! } };

  return undefined;
}

export interface CaptureResult {
  ok: boolean;
  reason?: "unknown_user" | "unparsed" | "error";
  preference?: Preference;
}

const describe = (p: ParsedPreference): string => {
  const target = p.selector.repo ?? p.selector.threadId ?? "everything";
  if (p.rule === "snooze") return `snoozed until ${p.until ?? "later"}`;
  if (p.rule === "mute") return `muted ${target}`;
  if (p.rule === "own") return `noted you own ${target}`;
  return `you'll get ${p.selector.priority === "high" ? "high-priority " : ""}routing for ${target}`;
};

/**
 * Resolve the Slack sender to an Identity, parse their message, persist the
 * Preference, and DM a confirmation (DESIGN §8). Preference capture is
 * user-initiated config — not shadow-gated.
 */
export async function capturePreference(
  ctx: EngineContext,
  slackUserId: string,
  text: string,
): Promise<CaptureResult> {
  const identityResult = await ctx.store.findIdentity({ handle: slackUserId });
  if (!identityResult.ok) return { ok: false, reason: "error" };
  const identity = identityResult.data;
  const slack = ctx.platforms.get("slack");
  if (!identity) {
    // We know the Slack id but have no roster mapping — tell them, don't go silent.
    if (slack) {
      await slack.notifyPerson(
        { id: slackUserId, handles: { slack: slackUserId } },
        "I don't recognize you yet — ask an admin to add you to the identity roster.",
      );
    }
    return { ok: false, reason: "unknown_user" };
  }

  const parsed = parsePreferenceText(text, ctx.clock.now());
  if (!parsed) {
    if (slack) {
      await slack.notifyPerson(
        identity,
        "Sorry, I couldn't parse that. Try: `mute repo owner/name`, `snooze me for 2 days`, `I care about repo owner/name high-pri`, or `I own owner/name#12`.",
      );
    }
    return { ok: false, reason: "unparsed" };
  }

  const preference: Preference = { person: identity.id, ...parsed };
  const upserted = await ctx.store.upsertPreference(preference);
  if (!upserted.ok) return { ok: false, reason: "error" };
  if (slack) {
    await slack.notifyPerson(identity, `Got it — ${describe(parsed)}.`);
  }
  return { ok: true, preference };
}
