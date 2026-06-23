import { describe, expect, it } from "vitest";
import { fixedClock } from "./clock.js";
import type { EngineConfig, SignalConfig } from "./config.js";
import type { Identity, Nudge, Preference, Signal, SignalKind, Thread } from "./domain.js";
import type { Platform } from "./platform.js";
import { route, type EngineContext } from "./pipeline.js";
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
const config = (shadow: boolean, maxEscalations = 3): EngineConfig => ({
  calendar: { timezone: "UTC", workingDays: [1, 2, 3, 4, 5] },
  signals: Object.fromEntries(
    KINDS.map((k) => [
      k,
      k === "blocker_cleared"
        ? ({ quietPeriodHours: 0, maxEscalations: 1, enabled: true } as SignalConfig)
        : ({ quietPeriodHours: 24, maxEscalations, enabled: true } as SignalConfig),
    ]),
  ) as Record<SignalKind, SignalConfig>,
  shadow: { global: shadow, capabilities: {} },
  botAccounts: [],
  platforms: {},
});

const thread: Thread = {
  platform: "github",
  nativeId: "o/r#1",
  type: "pr",
  title: "PR",
  state: "open",
  participants: [],
  meta: { repo: "o/r" },
  timeline: [],
};

const signal = (owedBy: string, kind: SignalKind = "review_requested"): Signal => ({
  id: `o/r#1:${kind}:${owedBy}`,
  threadId: "o/r#1",
  kind,
  owedBy,
  detectedAt: ago(30),
});

function fakeStore(
  opts: {
    identities?: Identity[];
    prefs?: Record<string, Preference[]>;
    nudges?: Record<string, Nudge>;
  } = {},
) {
  const ids = new Map((opts.identities ?? []).map((i) => [i.id, i]));
  const nudges = new Map(Object.entries(opts.nudges ?? {}));
  const store = {
    async getIdentity(id: string) {
      return ids.get(id);
    },
    async upsertIdentity(i: Identity) {
      ids.set(i.id, i);
    },
    async setIdentityHandle(id: string, platform: string, handle: string) {
      const i = ids.get(id);
      if (i) ids.set(id, { ...i, handles: { ...i.handles, [platform]: handle } });
    },
    async getPreferences(person: string) {
      return opts.prefs?.[person] ?? [];
    },
    async getNudgeByDedupeKey(key: string) {
      return nudges.get(key);
    },
    async upsertNudge(n: Nudge) {
      nudges.set(n.dedupeKey, n);
    },
    async tryClaimNudge(n: Nudge) {
      const existing = nudges.get(n.dedupeKey);
      const ownedByOther = existing !== undefined && existing.state !== "shadow";
      if (ownedByOther) return false;
      nudges.set(n.dedupeKey, n);
      return true;
    },
  } as unknown as Store;
  return { store, nudges };
}

function fakeSlack(resolve?: string) {
  const sent: string[] = [];
  const platform = {
    id: "slack",
    async notifyPerson(identity: Identity, body: string) {
      sent.push(`${identity.handles.slack}:${body}`);
    },
    async resolvePerson(identity: Identity) {
      return resolve ?? identity.handles.slack;
    },
  } as unknown as Platform;
  return { platform, sent };
}

function ctx(store: Store, slack: Platform, shadow = false, maxEscalations = 3): EngineContext {
  return {
    store,
    platforms: new Map([["slack", slack]]),
    identities: { list: async () => [], resolve: async () => undefined },
    llm: { complete: async (p) => p },
    config: config(shadow, maxEscalations),
    clock: fixedClock(NOW),
  };
}

describe("route", () => {
  it("DMs a person with a known Slack id", async () => {
    const { store, nudges } = fakeStore({
      identities: [{ id: "u-r", handles: { github: "r", slack: "U0ROUTE1" } }],
    });
    const { platform, sent } = fakeSlack();
    const out = await route(ctx(store, platform), thread, [signal("u-r")]);
    expect(sent).toHaveLength(1);
    expect(out[0]).toMatchObject({ channel: "dm", state: "sent", person: "u-r" });
    expect(nudges.get("u-r:o/r#1:review_requested")?.state).toBe("sent");
  });

  it("backs off within the quiet period", async () => {
    const { store } = fakeStore({
      identities: [{ id: "u-r", handles: { slack: "U0ROUTE1" } }],
      nudges: {
        "u-r:o/r#1:review_requested": {
          person: "u-r",
          signalId: "x",
          channel: "dm",
          dedupeKey: "u-r:o/r#1:review_requested",
          sentAt: ago(1),
          state: "sent",
          escalations: 1,
        },
      },
    });
    const { platform, sent } = fakeSlack();
    const out = await route(ctx(store, platform), thread, [signal("u-r")]);
    expect(sent).toHaveLength(0);
    expect(out).toHaveLength(0);
  });

  it("drops to digest after max escalations", async () => {
    const { store } = fakeStore({
      identities: [{ id: "u-r", handles: { slack: "U0ROUTE1" } }],
      nudges: {
        "u-r:o/r#1:review_requested": {
          person: "u-r",
          signalId: "x",
          channel: "dm",
          dedupeKey: "u-r:o/r#1:review_requested",
          sentAt: ago(48),
          state: "sent",
          escalations: 3,
        },
      },
    });
    const { platform, sent } = fakeSlack();
    const out = await route(ctx(store, platform, false, 3), thread, [signal("u-r")]);
    expect(sent).toHaveLength(0);
    expect(out[0]).toMatchObject({ channel: "digest", state: "pending", escalations: 4 });
  });

  it("mute preference suppresses the nudge", async () => {
    const { store } = fakeStore({
      identities: [{ id: "u-r", handles: { slack: "U0ROUTE1" } }],
      prefs: { "u-r": [{ person: "u-r", rule: "mute", selector: { repo: "o/r" } }] },
    });
    const { platform, sent } = fakeSlack();
    const out = await route(ctx(store, platform), thread, [signal("u-r")]);
    expect(sent).toHaveLength(0);
    expect(out).toHaveLength(0);
  });

  it("falls back to digest when no Slack id resolves", async () => {
    const { store } = fakeStore({ identities: [{ id: "u-r", handles: { github: "r" } }] });
    const { platform, sent } = fakeSlack(undefined);
    const out = await route(ctx(store, platform), thread, [signal("u-r")]);
    expect(sent).toHaveLength(0);
    expect(out[0]).toMatchObject({ channel: "digest", state: "pending" });
  });

  it("caches a resolved Slack id back onto the identity", async () => {
    const { store } = fakeStore({ identities: [{ id: "u-r", handles: { github: "r" } }] });
    const { platform, sent } = fakeSlack("U0ROUTE9");
    await route(ctx(store, platform), thread, [signal("u-r")]);
    expect((await store.getIdentity("u-r"))?.handles.slack).toBe("U0ROUTE9");
    expect(sent[0]).toContain("U0ROUTE9:");
  });

  it("falls back to digest when a roster username does not resolve to a Slack id", async () => {
    const { store, nudges } = fakeStore({
      identities: [{ id: "u-r", handles: { slack: "john.doe" } }],
    });
    const { platform, sent } = fakeSlack("john.doe");
    const out = await route(ctx(store, platform), thread, [signal("u-r")]);
    expect(sent).toHaveLength(0);
    expect(out[0]).toMatchObject({ channel: "digest", state: "pending" });
    expect(nudges.get("u-r:o/r#1:review_requested")?.state).toBe("pending");
  });

  it("shadow mode computes but never sends; going live then sends the first DM", async () => {
    const { store, nudges } = fakeStore({
      identities: [{ id: "u-r", handles: { slack: "U0ROUTE1" } }],
    });
    const { platform, sent } = fakeSlack();
    const shadowOut = await route(ctx(store, platform, true), thread, [signal("u-r")]);
    expect(sent).toHaveLength(0);
    expect(shadowOut[0]).toMatchObject({ state: "shadow", channel: "dm" });

    // Flip live: the shadow row must not throttle the first real send.
    const liveOut = await route(ctx(store, platform, false), thread, [signal("u-r")]);
    expect(sent).toHaveLength(1);
    expect(liveOut[0]).toMatchObject({ state: "sent", escalations: 1 });
    expect(nudges.get("u-r:o/r#1:review_requested")?.state).toBe("sent");
  });

  it("downgrades to digest when no Slack adapter is registered", async () => {
    const { store } = fakeStore({ identities: [{ id: "u-r", handles: { slack: "U0ROUTE1" } }] });
    const ctxNoSlack: EngineContext = {
      store,
      platforms: new Map(),
      identities: { list: async () => [], resolve: async () => undefined },
      llm: { complete: async (p) => p },
      config: config(false),
      clock: fixedClock(NOW),
    };
    const out = await route(ctxNoSlack, thread, [signal("u-r")]);
    expect(out[0]).toMatchObject({ channel: "digest", state: "pending" });
  });

  it("blocker_cleared fires exactly once (quiet 0)", async () => {
    const { store } = fakeStore({ identities: [{ id: "u-o", handles: { slack: "U0ROUTE1" } }] });
    const { platform, sent } = fakeSlack();
    const sig = signal("u-o", "blocker_cleared");
    const first = await route(ctx(store, platform), thread, [sig]);
    expect(first[0]).toMatchObject({ channel: "dm", state: "sent" });
    expect(sent).toHaveLength(1);
    // Re-evaluated next event while still active: must not DM again.
    const second = await route(ctx(store, platform), thread, [sig]);
    expect(second).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  it("elevates a digest-default signal to a DM via an 'I care … high-pri' preference", async () => {
    const { store } = fakeStore({
      identities: [{ id: "u-a", handles: { slack: "U0ROUTE1" } }],
      prefs: {
        "u-a": [{ person: "u-a", rule: "route", selector: { repo: "o/r", priority: "high" } }],
      },
    });
    const { platform, sent } = fakeSlack();
    const out = await route(ctx(store, platform), thread, [signal("u-a", "draft_pr_aged")]);
    expect(out[0]).toMatchObject({ channel: "dm", state: "sent" });
    expect(sent).toHaveLength(1);
  });

  it("never nudges a bot", async () => {
    const { store } = fakeStore({
      identities: [{ id: "github:dependabot[bot]", handles: { github: "dependabot[bot]" } }],
    });
    const { platform, sent } = fakeSlack("U0ROUTE1");
    const out = await route(ctx(store, platform), thread, [signal("github:dependabot[bot]")]);
    expect(sent).toHaveLength(0);
    expect(out).toHaveLength(0);
  });
});
