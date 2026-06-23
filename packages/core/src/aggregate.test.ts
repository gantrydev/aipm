import { describe, expect, it } from "vitest";
import { fixedClock } from "./clock.js";
import type { EngineConfig, Identity, Nudge, Signal } from "./index.js";
import type { Platform } from "./platform.js";
import { aggregate, type EngineContext } from "./pipeline.js";
import type { Store } from "./store.js";

const NOW = "2026-01-10T00:00:00.000Z";

// Fake but well-formed Slack user ids — `U` + alphanumerics, matching the
// looksLikeSlackId gate (`/^[UW][A-Z0-9]{6,}$/`) the digest enforces before DMing.
const SLACK_ID = {
  personA: "U0AAAAAA",
  personB: "U0BBBBBB",
  freshlyResolved: "U0RESOLV1",
} as const;
// A raw roster handle (not a U… id): must be resolved or left pending, never DM'd.
const ROSTER_USERNAME = "john.doe";

const nudge = (person: string, signalId: string): Nudge => ({
  person,
  signalId,
  channel: "digest",
  dedupeKey: `${person}:${signalId}`,
  sentAt: NOW,
  state: "pending",
  escalations: 1,
});

function harness(opts: {
  pending: Nudge[];
  identities: Identity[];
  signals: Signal[];
  shadow?: boolean;
  withSlack?: boolean;
  resolver?: string;
}) {
  const nudges = new Map(opts.pending.map((n) => [n.dedupeKey, { ...n }]));
  const ids = new Map(opts.identities.map((i) => [i.id, i]));
  const sigs = new Map(opts.signals.map((s) => [s.id, s]));
  const dms: Array<{ to: string; body: string }> = [];
  const store = {
    async listPendingDigestNudges() {
      return [...nudges.values()].filter((n) => n.state === "pending");
    },
    async getIdentity(id: string) {
      return ids.get(id);
    },
    async getSignal(id: string) {
      return sigs.get(id);
    },
    async upsertNudge(n: Nudge) {
      nudges.set(n.dedupeKey, { ...n });
    },
    async setIdentityHandle(id: string, platform: string, handle: string) {
      const current = ids.get(id);
      if (current) ids.set(id, { ...current, handles: { ...current.handles, [platform]: handle } });
    },
  } as unknown as Store;
  const slack = {
    id: "slack",
    async notifyPerson(i: Identity, body: string) {
      dms.push({ to: i.handles.slack ?? "?", body });
    },
    ...(opts.resolver ? { resolvePerson: async () => opts.resolver } : {}),
  } as unknown as Platform;
  const ctx: EngineContext = {
    store,
    platforms: opts.withSlack === false ? new Map() : new Map([["slack", slack]]),
    identities: { list: async () => [], resolve: async () => undefined },
    llm: { complete: async (p) => p },
    config: { shadow: { global: false, capabilities: { digest: opts.shadow } } } as EngineConfig,
    clock: fixedClock(NOW),
  };
  return { ctx, nudges, dms };
}

const sig = (id: string, kind: Signal["kind"], threadId: string): Signal => ({
  id,
  threadId,
  kind,
  detectedAt: NOW,
});

describe("aggregate (per-person digest)", () => {
  it("DMs one digest per person and marks the nudges sent", async () => {
    const { ctx, nudges, dms } = harness({
      pending: [nudge("u-a", "s1"), nudge("u-a", "s2"), nudge("u-b", "s3")],
      identities: [
        { id: "u-a", handles: { slack: SLACK_ID.personA } },
        { id: "u-b", handles: { slack: SLACK_ID.personB } },
      ],
      signals: [
        sig("s1", "review_requested", "o/r#1"),
        sig("s2", "pr_no_reviewer", "o/r#2"),
        sig("s3", "draft_pr_aged", "o/r#3"),
      ],
    });
    await aggregate(ctx);
    expect(dms).toHaveLength(2);
    const a = dms.find((d) => d.to === SLACK_ID.personA)!;
    expect(a.body).toContain("2 item(s)");
    expect(a.body).toContain("o/r#1");
    expect(a.body).toContain("o/r#2");
    expect([...nudges.values()].every((n) => n.state === "sent")).toBe(true);
  });

  it("leaves nudges pending in shadow mode (computes, sends nothing)", async () => {
    const { ctx, nudges, dms } = harness({
      pending: [nudge("u-a", "s1")],
      identities: [{ id: "u-a", handles: { slack: "UA" } }],
      signals: [sig("s1", "review_requested", "o/r#1")],
      shadow: true,
    });
    await aggregate(ctx);
    expect(dms).toHaveLength(0);
    expect(nudges.get("u-a:s1")?.state).toBe("pending");
  });

  it("leaves nudges pending when the person has no Slack id", async () => {
    const { ctx, nudges, dms } = harness({
      pending: [nudge("u-a", "s1")],
      identities: [{ id: "u-a", handles: { github: "a" } }],
      signals: [sig("s1", "review_requested", "o/r#1")],
    });
    await aggregate(ctx);
    expect(dms).toHaveLength(0);
    expect(nudges.get("u-a:s1")?.state).toBe("pending");
  });

  it("reaps a nudge whose signal was already cleared (no DM, marked cleared)", async () => {
    const { ctx, nudges, dms } = harness({
      pending: [nudge("u-a", "s1")],
      identities: [{ id: "u-a", handles: { slack: "UA" } }],
      signals: [{ ...sig("s1", "review_requested", "o/r#1"), clearedAt: NOW }],
    });
    await aggregate(ctx);
    expect(dms).toHaveLength(0);
    expect(nudges.get("u-a:s1")?.state).toBe("cleared");
  });

  it("never DMs a raw roster username when it can't be resolved (F7)", async () => {
    const { ctx, nudges, dms } = harness({
      pending: [nudge("u-a", "s1")],
      identities: [{ id: "u-a", handles: { slack: ROSTER_USERNAME } }],
      signals: [sig("s1", "review_requested", "o/r#1")],
    });
    await aggregate(ctx);
    expect(dms).toHaveLength(0);
    expect(nudges.get("u-a:s1")?.state).toBe("pending");
  });

  it("resolves a roster username to a real Slack id, then DMs and marks sent", async () => {
    const { ctx, nudges, dms } = harness({
      pending: [nudge("u-a", "s1")],
      identities: [{ id: "u-a", handles: { slack: ROSTER_USERNAME } }],
      signals: [sig("s1", "review_requested", "o/r#1")],
      resolver: SLACK_ID.freshlyResolved,
    });
    await aggregate(ctx);
    expect(dms.map((d) => d.to)).toContain(SLACK_ID.freshlyResolved);
    expect(dms).toHaveLength(1);
    expect(nudges.get("u-a:s1")?.state).toBe("sent");
  });
});
