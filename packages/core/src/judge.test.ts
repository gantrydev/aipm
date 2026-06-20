import { describe, expect, it } from "vitest";
import { fixedClock } from "./clock.js";
import type { EngineConfig, SignalConfig } from "./config.js";
import type { Thread, TimelineEvent } from "./domain.js";
import { judgeUnansweredMentions } from "./judge.js";
import type { EngineContext } from "./pipeline.js";
import type { Store } from "./store.js";

const NOW = "2026-01-10T00:00:00.000Z";
const ago = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

function ctx(verdict: string): EngineContext {
  const signals = {
    mentioned_no_response: { quietPeriodHours: 24, maxEscalations: 3, enabled: true },
  };
  return {
    store: {} as Store,
    platforms: new Map(),
    identities: { list: async () => [], resolve: async () => undefined },
    llm: { complete: async () => verdict },
    config: {
      calendar: { timezone: "UTC", workingDays: [1, 2, 3, 4, 5] },
      signals,
    } as unknown as EngineConfig,
    clock: fixedClock(NOW),
  };
}

const ev = (e: Partial<TimelineEvent>): TimelineEvent => ({
  kind: "comment",
  at: ago(48),
  data: {},
  ...e,
});

const thread = (tl: TimelineEvent[]): Thread => ({
  platform: "github",
  nativeId: "o/r#1",
  type: "issue",
  state: "open",
  participants: [],
  meta: {},
  timeline: tl,
});

const mentionThenReply: TimelineEvent[] = [
  ev({
    actor: "u-asker",
    at: ago(40),
    data: { body: "@u-m can you confirm the bucket size?", mentions: ["u-m"] },
  }),
  ev({ actor: "u-m", at: ago(2), data: { body: "thanks, will look later" } }),
];

describe("judgeUnansweredMentions", () => {
  it("keeps the signal when the LLM says the reply did not answer", async () => {
    const out = await judgeUnansweredMentions(ctx("no"), thread(mentionThenReply));
    expect(out).toEqual([{ kind: "mentioned_no_response", owedBy: "u-m" }]);
  });

  it("clears (no signal) when the LLM says it was answered", async () => {
    const out = await judgeUnansweredMentions(ctx("yes"), thread(mentionThenReply));
    expect(out).toEqual([]);
  });

  it("ignores a mention that has no reply yet (deterministic detector owns it)", async () => {
    const tl = [
      ev({ actor: "u-asker", at: ago(40), data: { body: "@u-m ping", mentions: ["u-m"] } }),
    ];
    expect(await judgeUnansweredMentions(ctx("no"), thread(tl))).toEqual([]);
  });

  it("does not judge before the quiet period", async () => {
    const tl = [
      ev({ actor: "u-asker", at: ago(2), data: { body: "@u-m ping", mentions: ["u-m"] } }),
      ev({ actor: "u-m", at: ago(1), data: { body: "k" } }),
    ];
    expect(await judgeUnansweredMentions(ctx("no"), thread(tl))).toEqual([]);
  });
});
