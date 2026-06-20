import type { RawEvent } from "@aipm/core";
import { describe, expect, it } from "vitest";
import {
  normalizeIssueGraphql,
  normalizePrGraphql,
  normalizeWebhookEvent,
  prState,
} from "./normalize.js";

const wh = (event: string, payload: unknown): RawEvent => ({ platform: "github", event, payload });

describe("normalizeWebhookEvent", () => {
  it("classifies by the event header, not action", () => {
    const r = normalizeWebhookEvent(
      wh("issues", { action: "closed", repository: { full_name: "o/r" }, issue: { number: 7 } }),
    );
    expect(r).toEqual({ nativeId: "o/r#7", type: "issue" });
  });

  it("issue_comment on a PR resolves to type pr (the trap)", () => {
    const r = normalizeWebhookEvent(
      wh("issue_comment", {
        repository: { full_name: "o/r" },
        issue: { number: 9, pull_request: { url: "..." } },
      }),
    );
    expect(r).toEqual({ nativeId: "o/r#9", type: "pr" });
  });

  it("issue_comment on an issue resolves to type issue", () => {
    const r = normalizeWebhookEvent(
      wh("issue_comment", { repository: { full_name: "o/r" }, issue: { number: 9 } }),
    );
    expect(r?.type).toBe("issue");
  });

  it("pull_request_review routes by pull_request.number", () => {
    const r = normalizeWebhookEvent(
      wh("pull_request_review", { repository: { full_name: "o/r" }, pull_request: { number: 3 } }),
    );
    expect(r).toEqual({ nativeId: "o/r#3", type: "pr" });
  });

  it("ignores unmapped events and missing repo", () => {
    expect(normalizeWebhookEvent(wh("push", { repository: { full_name: "o/r" } }))).toBeUndefined();
    expect(normalizeWebhookEvent(wh("issues", { issue: { number: 1 } }))).toBeUndefined();
  });

  it("handles synthetic sweep events", () => {
    expect(
      normalizeWebhookEvent({
        platform: "github",
        event: "sweep",
        payload: { nativeId: "o/r#5", type: "pr" },
      }),
    ).toEqual({ nativeId: "o/r#5", type: "pr" });
  });
});

describe("prState", () => {
  it("merged beats closed beats draft beats open", () => {
    expect(prState({ state: "CLOSED", mergedAt: "2026-01-01T00:00:00Z" })).toBe("merged");
    expect(prState({ state: "CLOSED" })).toBe("closed");
    expect(prState({ state: "OPEN", isDraft: true })).toBe("draft");
    expect(prState({ state: "OPEN" })).toBe("open");
  });
});

describe("normalizeIssueGraphql", () => {
  const issueNode = {
    number: 12,
    title: "Bug",
    body: "broken",
    state: "CLOSED",
    stateReason: "NOT_PLANNED",
    author: { login: "alice" },
    assignees: { nodes: [{ login: "bob" }] },
    labels: { nodes: [{ name: "bug" }, { name: "p1" }] },
    timelineItems: {
      nodes: [
        {
          __typename: "IssueComment",
          author: { login: "carol" },
          createdAt: "2026-01-02T00:00:00Z",
          body: "hi",
        },
        {
          __typename: "IssueComment",
          author: { login: "dependabot[bot]" },
          createdAt: "2026-01-03T00:00:00Z",
          body: "bump",
        },
        {
          __typename: "LabeledEvent",
          actor: { login: "alice" },
          createdAt: "2026-01-02T01:00:00Z",
          label: { name: "p1" },
        },
      ],
    },
  };

  it("normalizes state, meta, participants (bot-excluded) and timeline", () => {
    const t = normalizeIssueGraphql(issueNode, "o/r");
    expect(t.state).toBe("closed");
    expect(t.meta.stateReason).toBe("NOT_PLANNED");
    expect(t.meta.labels).toEqual(["bug", "p1"]);
    expect(t.participants.sort()).toEqual(["alice", "bob", "carol"]); // dependabot[bot] excluded
    expect(t.timeline.map((e) => e.kind)).toEqual(["comment", "comment", "label"]);
  });
});

describe("normalizePrGraphql", () => {
  it("derives draft state and maps a review timeline event with a Team reviewer", () => {
    const prNode = {
      number: 4,
      title: "Feature",
      state: "OPEN",
      isDraft: true,
      author: { login: "alice" },
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Team", slug: "core-team" } }] },
      timelineItems: {
        nodes: [
          {
            __typename: "ReviewRequestedEvent",
            actor: { login: "alice" },
            createdAt: "2026-01-02T00:00:00Z",
            requestedReviewer: { __typename: "Team", slug: "core-team" },
          },
          {
            __typename: "PullRequestReview",
            author: { login: "bob" },
            submittedAt: "2026-01-03T00:00:00Z",
            state: "CHANGES_REQUESTED",
          },
        ],
      },
    };
    const t = normalizePrGraphql(prNode, "o/r");
    expect(t.state).toBe("draft");
    expect(t.timeline[0]).toMatchObject({ kind: "review_request", data: { target: "core-team" } });
    expect(t.timeline[1]).toMatchObject({
      kind: "review",
      actor: "bob",
      data: { state: "CHANGES_REQUESTED" },
    });
  });
});
