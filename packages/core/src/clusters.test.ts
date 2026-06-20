import { describe, expect, it } from "vitest";
import { systemClock } from "./clock.js";
import { aggregateOrg, maintainCluster, synthesizeCluster } from "./clusters.js";
import type { EngineConfig, Cluster, Link, Thread, WorkingNotes } from "./index.js";
import { type EngineContext } from "./pipeline.js";
import type { Store } from "./store.js";

function fakeStore(
  opts: {
    links?: Record<string, Link[]>;
    threads?: Record<string, Thread>;
    notes?: WorkingNotes[];
  } = {},
) {
  const clusters = new Map<string, Cluster>();
  const notes = new Map<string, WorkingNotes>(
    (opts.notes ?? []).map((n) => [`${n.scope}:${n.targetId}`, n]),
  );
  const store = {
    async getLinks(id: string) {
      return opts.links?.[id] ?? [];
    },
    async getThread(_p: string, nid: string) {
      return opts.threads?.[nid];
    },
    async upsertCluster(c: Cluster) {
      clusters.set(c.id, c);
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
  return { store, clusters, notes };
}

const ctx = (store: Store): EngineContext => ({
  store,
  platforms: new Map(),
  identities: { list: async () => [], resolve: async () => undefined },
  llm: { complete: async (p) => p },
  config: {} as EngineConfig,
  clock: systemClock,
});

describe("maintainCluster", () => {
  it("forms a cluster from the connected component over links", async () => {
    const { store, clusters } = fakeStore({
      links: {
        "o/r#1": [{ from: "o/r#1", to: "o/r#2", kind: "closes" }],
        "o/r#2": [
          { from: "o/r#1", to: "o/r#2", kind: "closes" },
          { from: "o/r#2", to: "o/r#3", kind: "refs" },
        ],
        "o/r#3": [{ from: "o/r#2", to: "o/r#3", kind: "refs" }],
      },
    });
    const cluster = await maintainCluster(ctx(store), "o/r#1");
    expect(cluster).toMatchObject({ id: "cluster:o/r#1", threadIds: ["o/r#1", "o/r#2", "o/r#3"] });
    expect(clusters.get("cluster:o/r#1")).toBeTruthy();
  });

  it("does not cluster a singleton", async () => {
    const { store } = fakeStore({ links: {} });
    expect(await maintainCluster(ctx(store), "o/r#9")).toBeUndefined();
  });
});

describe("synthesizeCluster", () => {
  const cluster: Cluster = { id: "cluster:o/r#1", threadIds: ["o/r#1", "o/r#2"] };
  const threads = {
    "o/r#1": { state: "open" } as Thread,
    "o/r#2": { state: "merged" } as Thread,
  };

  it("writes a cluster note listing members and their state", async () => {
    const { store, notes } = fakeStore({ threads });
    await synthesizeCluster(ctx(store), cluster);
    const note = notes.get("cluster:cluster:o/r#1");
    expect(note?.content).toContain("o/r#1` — open");
    expect(note?.content).toContain("o/r#2` — merged");
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
