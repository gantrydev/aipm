import { describe, expect, it } from "vitest";
import { fixedClock } from "./clock.js";
import type { EngineConfig, SignalConfig } from "./config.js";
import type { Link, Signal, SignalKind, Thread } from "./domain.js";
import { evaluate, type EngineContext } from "./pipeline.js";
import { Ok } from "./result.js";
import type { Store } from "./store.js";

const NOW = "2026-01-10T00:00:00.000Z";
const ago = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

const KINDS: SignalKind[] = [
  "mentioned_no_response",
  "review_requested",
  "unaddressed_review_comments",
  "pr_no_reviewer",
  "draft_pr_aged",
  "in_progress_stale",
  "blocker_cleared",
];
const config = (): EngineConfig => ({
  calendar: { timezone: "UTC", workingDays: [1, 2, 3, 4, 5] },
  signals: Object.fromEntries(
    KINDS.map((k) => [
      k,
      { quietPeriodHours: 4, maxEscalations: 3, enabled: true } as SignalConfig,
    ]),
  ) as Record<SignalKind, SignalConfig>,
  shadow: { global: false, capabilities: {} },
  botAccounts: [],
  platforms: {},
});

function fakeStore(
  opts: { signals?: Signal[]; links?: Link[]; threads?: Record<string, Thread> } = {},
) {
  const open = new Map<string, Signal>((opts.signals ?? []).map((s) => [s.id, { ...s }]));
  const store = {
    async getOpenSignals(tid: string) {
      return Ok([...open.values()].filter((s) => s.threadId === tid && !s.clearedAt));
    },
    async upsertSignal(s: Signal) {
      open.set(s.id, { ...s });
      return Ok(undefined);
    },
    async clearSignal(id: string, at: string) {
      const s = open.get(id);
      if (s) s.clearedAt = at;
      return Ok(undefined);
    },
    async getLinks() {
      return Ok(opts.links ?? []);
    },
    async getThread(_p: string, nid: string) {
      return Ok(opts.threads?.[nid]);
    },
  } as unknown as Store;
  return { store, open };
}

const ctx = (store: Store): EngineContext => ({
  store,
  platforms: new Map(),
  identities: { list: async () => [], resolve: async () => undefined },
  llm: { complete: async (p) => p },
  config: config(),
  clock: fixedClock(NOW),
});

const prNoReviewerThread: Thread = {
  platform: "github",
  nativeId: "o/r#1",
  type: "pr",
  state: "open",
  participants: [],
  meta: { author: "u-author", createdAt: ago(48) },
  timeline: [],
};

describe("evaluate", () => {
  it("opens a newly-active signal", async () => {
    const { store, open } = fakeStore();
    const result = await evaluate(ctx(store), prNoReviewerThread);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data.map((s) => s.kind)).toContain("pr_no_reviewer");
    expect(open.get("o/r#1:pr_no_reviewer:u-author")?.detectedAt).toBe(NOW);
  });

  it("clears signals once no longer active (reviewer added)", async () => {
    const existing: Signal = {
      id: "o/r#1:pr_no_reviewer:u-author",
      threadId: "o/r#1",
      kind: "pr_no_reviewer",
      owedBy: "u-author",
      detectedAt: ago(10),
    };
    const withReviewer: Thread = {
      ...prNoReviewerThread,
      timeline: [{ kind: "review_request", at: ago(1), data: { target: "u-r" } }],
    };
    const { store, open } = fakeStore({ signals: [existing] });
    const result = await evaluate(ctx(store), withReviewer);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data).toEqual([]);
    expect(open.get(existing.id)?.clearedAt).toBe(NOW);
  });

  it("terminal thread clears all open signals (universal stop)", async () => {
    const existing: Signal = {
      id: "o/r#1:review_requested:u-r",
      threadId: "o/r#1",
      kind: "review_requested",
      owedBy: "u-r",
      detectedAt: ago(10),
    };
    const { store, open } = fakeStore({ signals: [existing] });
    const result = await evaluate(ctx(store), { ...prNoReviewerThread, state: "merged" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data).toEqual([]);
    expect(open.get(existing.id)?.clearedAt).toBe(NOW);
  });

  it("fires blocker_cleared when the blocking thread is terminal", async () => {
    const blocked: Thread = {
      platform: "github",
      nativeId: "o/r#2",
      type: "issue",
      state: "open",
      participants: [],
      meta: { author: "u-owner" },
      timeline: [],
    };
    const links: Link[] = [{ from: "o/r#2", to: "o/r#9", kind: "blocked_by" }];
    const threads = {
      "o/r#9": { ...blocked, nativeId: "o/r#9", state: "closed" },
    };
    const { store } = fakeStore({ links, threads });
    const result = await evaluate(ctx(store), blocked);
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.data.find((s) => s.kind === "blocker_cleared")?.owedBy).toBe("u-owner");
  });
});
