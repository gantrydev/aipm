import { describe, expect, it } from "vitest";
import { systemClock } from "./clock.js";
import type { EngineConfig } from "./config.js";
import type { Identity, Link, Thread } from "./domain.js";
import { configIdentitySource } from "./identity-source.js";
import type { NormalizedRef, Platform, RawEvent } from "./platform.js";
import { ingest, type EngineContext } from "./pipeline.js";
import type { Store } from "./store.js";

function fakeStore() {
  const threads: Thread[] = [];
  const links: Link[] = [];
  const identities = new Map<string, Identity>();
  const store = {
    async upsertThread(t: Thread) {
      threads.push(t);
    },
    async upsertLinks(l: Link[]) {
      links.push(...l);
    },
    async replaceLinksFrom(fromId: string, l: Link[]) {
      for (let i = links.length - 1; i >= 0; i--) {
        if (links[i]?.from === fromId) links.splice(i, 1);
      }
      links.push(...l.filter((it) => it.from === fromId));
    },
    async upsertIdentity(i: Identity) {
      identities.set(i.id, i);
    },
    async findIdentity() {
      return undefined;
    },
    async deleteIdentity(id: string) {
      identities.delete(id);
    },
  } as unknown as Store;
  return { store, threads, links, identities };
}

function fakePlatform(thread: Thread, links: Link[]): Platform {
  return {
    id: "github",
    normalizeEvent: (_raw: RawEvent): NormalizedRef => ({
      nativeId: thread.nativeId,
      type: thread.type,
    }),
    getThread: async () => thread,
    getTimeline: async () => thread.timeline,
    discoverLinks: async () => links,
    listThreads: async () => [],
    postMessage: async () => ({ id: "x" }),
    editMessage: async () => {},
    findStickyComment: async () => undefined,
    react: async () => {},
    notifyPerson: async () => {},
  };
}

describe("ingest", () => {
  it("resolves participant handles to Identity ids and upserts thread + links", async () => {
    const thread: Thread = {
      platform: "github",
      nativeId: "o/r#1",
      type: "issue",
      state: "open",
      participants: ["alice", "bob"], // handles from adapter
      owner: "alice",
      meta: {},
      // carol is a timeline actor but not a participant — must still resolve.
      timeline: [{ kind: "comment", actor: "carol", at: "2026-01-01T00:00:00Z", data: {} }],
    };
    const link: Link = { from: "o/r#1", to: "o/r#2", kind: "refs" };
    const { store, threads, links, identities } = fakeStore();

    const ctx: EngineContext = {
      store,
      platforms: new Map([["github", fakePlatform(thread, [link])]]),
      identities: configIdentitySource([{ id: "u-alice", github: "alice" }]),
      llm: { complete: async (p) => p },
      config: {} as EngineConfig,
      clock: systemClock,
    };

    const result = await ingest(ctx, { platform: "github", payload: {} });

    expect(result?.participants).toEqual(["u-alice", "github:bob"]);
    expect(result?.owner).toBe("u-alice");
    expect(result?.timeline[0]?.actor).toBe("github:carol"); // timeline actor resolved
    expect(threads).toHaveLength(1);
    expect(links).toEqual([link]);
    expect(identities.get("u-alice")?.handles.github).toBe("alice");
  });

  it("replaces stale outgoing links while preserving inbound links", async () => {
    const thread: Thread = {
      platform: "github",
      nativeId: "o/r#1",
      type: "issue",
      state: "open",
      participants: [],
      meta: {},
      timeline: [],
    };
    const { store, links } = fakeStore();
    links.push(
      { from: "o/r#1", to: "o/r#stale", kind: "refs" },
      { from: "o/r#inbound", to: "o/r#1", kind: "refs" },
    );
    const fresh: Link = { from: "o/r#1", to: "o/r#fresh", kind: "refs" };

    const ctx: EngineContext = {
      store,
      platforms: new Map([["github", fakePlatform(thread, [fresh])]]),
      identities: configIdentitySource([]),
      llm: { complete: async (p) => p },
      config: {} as EngineConfig,
      clock: systemClock,
    };

    await ingest(ctx, { platform: "github", payload: {} });

    expect(links).toEqual([
      { from: "o/r#inbound", to: "o/r#1", kind: "refs" },
      { from: "o/r#1", to: "o/r#fresh", kind: "refs" },
    ]);
  });

  it("no-ops when the platform ignores the event", async () => {
    const { store, threads } = fakeStore();
    const platform = fakePlatform(
      {
        platform: "github",
        nativeId: "o/r#1",
        type: "issue",
        state: "open",
        participants: [],
        meta: {},
        timeline: [],
      },
      [],
    );
    platform.normalizeEvent = () => undefined;
    const ctx: EngineContext = {
      store,
      platforms: new Map([["github", platform]]),
      identities: configIdentitySource([]),
      llm: { complete: async (p) => p },
      config: {} as EngineConfig,
      clock: systemClock,
    };
    expect(await ingest(ctx, { platform: "github", payload: {} })).toBeUndefined();
    expect(threads).toHaveLength(0);
  });
});
