import { describe, expect, it } from "vitest";
import { fixedClock } from "./clock.js";
import type { EngineConfig, SignalConfig } from "./config.js";
import {
  draftPrAged,
  mentionedNoResponse,
  prNoReviewer,
  reviewRequested,
  unaddressedReviewComments,
  type DetectorContext,
} from "./detectors.js";
import type { SignalKind, Thread, TimelineEvent } from "./domain.js";

const NOW = "2026-01-10T00:00:00.000Z";
const ago = (hours: number) => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

const sig = (quietPeriodHours: number): SignalConfig => ({
  quietPeriodHours,
  maxEscalations: 3,
  enabled: true,
});

const KINDS: SignalKind[] = [
  "mentioned_no_response",
  "review_requested",
  "unaddressed_review_comments",
  "pr_no_reviewer",
  "draft_pr_aged",
  "in_progress_stale",
  "blocker_cleared",
];

function ctx(overrides: Partial<Record<SignalKind, number>> = {}): DetectorContext {
  const signals = Object.fromEntries(KINDS.map((k) => [k, sig(overrides[k] ?? 24)])) as Record<
    SignalKind,
    SignalConfig
  >;
  const config: EngineConfig = {
    calendar: { timezone: "UTC", workingDays: [1, 2, 3, 4, 5] },
    signals,
    shadow: { global: false, capabilities: {} },
    botAccounts: [],
    platforms: {},
  };
  return { config, clock: fixedClock(NOW) };
}

const pr = (over: Partial<Thread> = {}): Thread => ({
  platform: "github",
  nativeId: "o/r#1",
  type: "pr",
  state: "open",
  participants: [],
  meta: { author: "u-author", createdAt: ago(48) },
  timeline: [],
  ...over,
});

const ev = (e: Partial<TimelineEvent>): TimelineEvent => ({
  kind: "comment",
  at: ago(48),
  data: {},
  ...e,
});

describe("prNoReviewer", () => {
  it("fires for an old open PR with no reviewer", () => {
    expect(prNoReviewer.detect(pr(), ctx({ pr_no_reviewer: 4 }))).toEqual([
      { kind: "pr_no_reviewer", owedBy: "u-author" },
    ]);
  });
  it("does not fire before the quiet period", () => {
    expect(
      prNoReviewer.detect(
        pr({ meta: { author: "u-author", createdAt: ago(2) } }),
        ctx({ pr_no_reviewer: 4 }),
      ),
    ).toEqual([]);
  });
  it("clears once a reviewer is requested", () => {
    const t = pr({
      timeline: [ev({ kind: "review_request", data: { target: "u-r" }, at: ago(1) })],
    });
    expect(prNoReviewer.detect(t, ctx({ pr_no_reviewer: 4 }))).toEqual([]);
  });
});

describe("reviewRequested", () => {
  it("fires for a reviewer who hasn't reviewed within the quiet period", () => {
    const t = pr({
      timeline: [ev({ kind: "review_request", data: { target: "u-r" }, at: ago(30) })],
    });
    expect(reviewRequested.detect(t, ctx())).toEqual([{ kind: "review_requested", owedBy: "u-r" }]);
  });
  it("clears when that reviewer submits a review", () => {
    const t = pr({
      timeline: [
        ev({ kind: "review_request", data: { target: "u-r" }, at: ago(30) }),
        ev({ kind: "review", actor: "u-r", at: ago(1), data: { state: "APPROVED" } }),
      ],
    });
    expect(reviewRequested.detect(t, ctx())).toEqual([]);
  });
  it("clears when the request is removed", () => {
    const t = pr({
      timeline: [
        ev({ kind: "review_request", data: { target: "u-r" }, at: ago(30) }),
        ev({ kind: "review_request", data: { target: "u-r", removed: true }, at: ago(2) }),
      ],
    });
    expect(reviewRequested.detect(t, ctx())).toEqual([]);
  });

  it("still fires on a draft PR (reviews are requested on drafts too)", () => {
    const t = pr({
      state: "draft",
      timeline: [ev({ kind: "review_request", data: { target: "u-r" }, at: ago(30) })],
    });
    expect(reviewRequested.detect(t, ctx())).toEqual([{ kind: "review_requested", owedBy: "u-r" }]);
  });

  it("is NOT cleared by a COMMENTED review (does not satisfy the request)", () => {
    const t = pr({
      timeline: [
        ev({ kind: "review_request", data: { target: "u-r" }, at: ago(30) }),
        ev({ kind: "review", actor: "u-r", at: ago(1), data: { state: "COMMENTED" } }),
      ],
    });
    expect(reviewRequested.detect(t, ctx())).toEqual([{ kind: "review_requested", owedBy: "u-r" }]);
  });

  it("does not fire on a merged PR", () => {
    const t = pr({
      state: "merged",
      timeline: [ev({ kind: "review_request", data: { target: "u-r" }, at: ago(30) })],
    });
    expect(reviewRequested.detect(t, ctx())).toEqual([]);
  });
});

describe("unaddressedReviewComments", () => {
  const changesReq = ev({
    kind: "review",
    actor: "u-r",
    at: ago(30),
    data: { state: "CHANGES_REQUESTED" },
  });
  it("fires when the author hasn't replied to changes requested", () => {
    expect(unaddressedReviewComments.detect(pr({ timeline: [changesReq] }), ctx())).toEqual([
      { kind: "unaddressed_review_comments", owedBy: "u-author" },
    ]);
  });
  it("clears once the author responds", () => {
    const t = pr({ timeline: [changesReq, ev({ actor: "u-author", at: ago(1) })] });
    expect(unaddressedReviewComments.detect(t, ctx())).toEqual([]);
  });

  it("is NOT cleared by an author status event (ready_for_review) without a reply", () => {
    const t = pr({
      timeline: [
        changesReq,
        ev({ kind: "status", actor: "u-author", at: ago(1), data: { state: "ready_for_review" } }),
      ],
    });
    expect(unaddressedReviewComments.detect(t, ctx())).toEqual([
      { kind: "unaddressed_review_comments", owedBy: "u-author" },
    ]);
  });
});

describe("mentionedNoResponse", () => {
  it("fires when a mentioned person hasn't replied", () => {
    const t = pr({ timeline: [ev({ actor: "u-x", at: ago(30), data: { mentions: ["u-m"] } })] });
    expect(mentionedNoResponse.detect(t, ctx())).toEqual([
      { kind: "mentioned_no_response", owedBy: "u-m" },
    ]);
  });
  it("clears when the mentioned person comments afterwards", () => {
    const t = pr({
      timeline: [
        ev({ actor: "u-x", at: ago(30), data: { mentions: ["u-m"] } }),
        ev({ actor: "u-m", at: ago(1) }),
      ],
    });
    expect(mentionedNoResponse.detect(t, ctx())).toEqual([]);
  });
  it("ignores self-mentions", () => {
    const t = pr({ timeline: [ev({ actor: "u-m", at: ago(30), data: { mentions: ["u-m"] } })] });
    expect(mentionedNoResponse.detect(t, ctx())).toEqual([]);
  });

  it("fires for a mention on a draft PR", () => {
    const t = pr({
      state: "draft",
      timeline: [ev({ actor: "u-x", at: ago(30), data: { mentions: ["u-m"] } })],
    });
    expect(mentionedNoResponse.detect(t, ctx())).toEqual([
      { kind: "mentioned_no_response", owedBy: "u-m" },
    ]);
  });
});

describe("draftPrAged", () => {
  it("fires for a draft older than the threshold", () => {
    const t = pr({ state: "draft", meta: { author: "u-author", createdAt: ago(8 * 24) } });
    expect(draftPrAged.detect(t, ctx({ draft_pr_aged: 7 * 24 }))).toEqual([
      { kind: "draft_pr_aged", owedBy: "u-author" },
    ]);
  });
  it("does not fire for a fresh draft", () => {
    const t = pr({ state: "draft", meta: { author: "u-author", createdAt: ago(24) } });
    expect(draftPrAged.detect(t, ctx({ draft_pr_aged: 7 * 24 }))).toEqual([]);
  });
});
