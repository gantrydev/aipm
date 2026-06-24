import { describe, expect, it } from "vitest";
import { systemClock } from "./clock.js";
import { aggregateOrg, synthesizeCluster } from "./clusters.js";
import type { EngineConfig, Cluster, Identity, Signal, Thread, WorkingNotes } from "./index.js";
import type { Platform } from "./platform.js";
import { type EngineContext } from "./pipeline.js";
import type { Store } from "./store.js";

function fakeStore(
  opts: {
    threads?: Record<string, Thread>;
    notes?: WorkingNotes[];
    signals?: Signal[];
    identities?: Identity[];
  } = {},
) {
  const notes = new Map<string, WorkingNotes>(
    (opts.notes ?? []).map((n) => [`${n.scope}:${n.targetId}`, n]),
  );
  const identities = new Map((opts.identities ?? []).map((i) => [i.id, i]));
  const store = {
    async getThread(_p: string, nid: string) {
      return opts.threads?.[nid];
    },
    async getIdentity(id: string) {
      return identities.get(id);
    },
    async getWorkingNotes(scope: string, targetId: string) {
      return notes.get(`${scope}:${targetId}`);
    },
    async upsertWorkingNotes(n: WorkingNotes) {
      notes.set(`${n.scope}:${n.targetId}`, n);
    },
    async listWorkingNotes(scope: string) {
      return [...notes.values()].filter((n) => n.scope === scope);
    },
    async listOpenSignals() {
      return opts.signals ?? [];
    },
  } as unknown as Store;
  return { store, notes };
}

const ctx = (
  store: Store,
  opts: { slack?: Platform; orgShadow?: boolean } = {},
): EngineContext => ({
  store,
  platforms: opts.slack ? new Map([["slack", opts.slack]]) : new Map(),
  identities: { list: async () => [], resolve: async () => undefined },
  llm: { complete: async (p) => p },
  config: {
    shadow: { global: false, capabilities: { orgRollup: opts.orgShadow } },
  } as EngineConfig,
  clock: systemClock,
});

describe("synthesizeCluster", () => {
  const cluster: Cluster = { id: "cluster:o/r#1", threadIds: ["o/r#1", "o/r#2"] };
  const threads = {
    "o/r#1": { state: "open" } as Thread,
    "o/r#2": { state: "merged" } as Thread,
  };

  it("writes a concise cluster note without a raw member listing", async () => {
    const { store, notes } = fakeStore({ threads });
    await synthesizeCluster(ctx(store), cluster);
    const note = notes.get("cluster:cluster:o/r#1");
    expect(note?.content).toContain("<!-- aipm:cluster-notes -->");
    expect(note?.content).not.toContain("o/r#1` — open");
    expect(note?.content).not.toContain("o/r#2` — merged");
  });

  it("does not expose raw Slack thread ids to new cluster notes", async () => {
    const slackId = "C0BCL749Q6N/1782230344.374049";
    const { store, notes } = fakeStore({
      threads: {
        "o/r#1": {
          platform: "github",
          nativeId: "o/r#1",
          type: "issue",
          title: "Dataset labels",
          state: "open",
          participants: [],
          meta: {},
          timeline: [],
        },
        [slackId]: {
          platform: "slack",
          nativeId: slackId,
          type: "slack_thread",
          state: "open",
          participants: [],
          meta: {},
          timeline: [
            {
              kind: "comment",
              actor: "slack:U0ACCGLJVPC",
              at: "2026-01-01T00:00:00Z",
              data: { body: "we should generate the dataset from logs" },
            },
          ],
        },
      },
    });

    await synthesizeCluster(ctx(store), {
      id: "cluster:o/r#1",
      threadIds: ["o/r#1", slackId],
    });

    const note = notes.get("cluster:cluster:o/r#1");
    expect(note?.content).toContain("Slack discussion");
    expect(note?.content).toContain("teammate: we should generate the dataset from logs");
    expect(note?.content).not.toContain(slackId);
    expect(note?.content).not.toContain("U0ACCGLJVPC");
  });

  it("is idempotent — unchanged members rewrite nothing", async () => {
    const { store, notes } = fakeStore({ threads });
    await synthesizeCluster(ctx(store), cluster);
    const first = notes.get("cluster:cluster:o/r#1");
    await synthesizeCluster(ctx(store), cluster);
    expect(notes.get("cluster:cluster:o/r#1")).toBe(first);
  });
});

describe("aggregateOrg", () => {
  const note = (targetId: string, hash: string): WorkingNotes => ({
    scope: "cluster",
    targetId,
    content: `<!-- aipm:cluster-notes -->\ncluster ${targetId}`,
    contentHash: hash,
    provenance: "cluster",
  });

  const signal = (kind: Signal["kind"], owedBy = "github:octocat"): Signal => ({
    id: `o/r#1:${kind}:${owedBy}`,
    threadId: "o/r#1",
    kind,
    owedBy,
    detectedAt: "2026-06-24T12:00:00.000Z",
  });

  it("rolls all cluster notes into one org artifact, excluding itself", async () => {
    const { store, notes } = fakeStore({
      notes: [note("cluster:o/r#1", "h1"), note("cluster:o/r#5", "h2")],
    });
    await aggregateOrg(ctx(store));
    const org = notes.get("cluster:org");
    expect(org?.content).toContain("Org rollup — 2 cluster(s)");
    expect(org?.content).toContain("cluster cluster:o/r#1");
    // Re-running excludes the org note itself and stays stable.
    await aggregateOrg(ctx(store));
    expect(notes.get("cluster:org")?.contentHash).toBe(org?.contentHash);
  });

  it("posts one daily Slack pulse to the configured channel", async () => {
    const posts: Array<{ target: unknown; body: string }> = [];
    const slack = {
      id: "slack",
      async postMessage(target: unknown, body: string) {
        posts.push({ target, body });
        return { id: "C123/1782220000.000100" };
      },
    } as unknown as Platform;
    const { store, notes } = fakeStore({
      notes: [note("cluster:o/r#1", "h1")],
      signals: [signal("review_requested"), signal("pr_no_reviewer", "github:no-slack")],
      identities: [
        { id: "github:octocat", handles: { github: "octocat", slack: "U01OCTO" } },
        { id: "github:no-slack", handles: { github: "no-slack" } },
      ],
    });
    const runCtx = ctx(store, { slack });

    await aggregateOrg(runCtx, { channelId: "C123", at: new Date("2026-06-24T14:00:00.000Z") });
    await aggregateOrg(runCtx, { channelId: "C123", at: new Date("2026-06-24T15:00:00.000Z") });

    expect(posts).toHaveLength(1);
    expect(posts[0]?.target).toEqual({ meta: { channelId: "C123" } });
    expect(posts[0]?.body).toContain("*aipm daily pulse* — Wed, Jun 24");
    expect(posts[0]?.body).toContain("Review requested");
    expect(posts[0]?.body).toContain("<https://github.com/o/r/issues/1|o/r#1>");
    expect(posts[0]?.body).toContain("unresolved Slack identity");
    expect(notes.get("cluster:org-rollup:2026-06-24")?.externalRef).toBe("C123/1782220000.000100");
  });

  it("computes the daily Slack pulse in shadow mode without posting", async () => {
    const slack = {
      id: "slack",
      async postMessage() {
        throw new Error("must not post");
      },
    } as unknown as Platform;
    const { store, notes } = fakeStore({ signals: [signal("review_requested")] });

    await aggregateOrg(ctx(store, { slack, orgShadow: true }), {
      channelId: "C123",
      at: new Date("2026-06-24T14:00:00.000Z"),
    });

    const daily = notes.get("cluster:org-rollup:2026-06-24");
    expect(daily?.content).toContain("*aipm daily pulse*");
    expect(daily?.externalRef).toBeUndefined();
  });
});
