import { describe, expect, it } from "vitest";
import { systemClock } from "./clock.js";
import { aggregateOrg, synthesizeCluster } from "./clusters.js";
import type { EngineConfig, Cluster, Thread, WorkingNotes } from "./index.js";
import { type EngineContext } from "./pipeline.js";
import type { Store } from "./store.js";

function fakeStore(
  opts: {
    threads?: Record<string, Thread>;
    notes?: WorkingNotes[];
  } = {},
) {
  const notes = new Map<string, WorkingNotes>(
    (opts.notes ?? []).map((n) => [`${n.scope}:${n.targetId}`, n]),
  );
  const store = {
    async getThread(_p: string, nid: string) {
      return opts.threads?.[nid];
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
  } as unknown as Store;
  return { store, notes };
}

const ctx = (store: Store): EngineContext => ({
  store,
  platforms: new Map(),
  identities: { list: async () => [], resolve: async () => undefined },
  llm: { complete: async (p) => p },
  config: {} as EngineConfig,
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
  it("rolls all cluster notes into one org artifact, excluding itself", async () => {
    const note = (targetId: string, hash: string): WorkingNotes => ({
      scope: "cluster",
      targetId,
      content: `<!-- aipm:cluster-notes -->\ncluster ${targetId}`,
      contentHash: hash,
      provenance: "cluster",
    });
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
});
