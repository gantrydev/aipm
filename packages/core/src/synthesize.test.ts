import { describe, expect, it } from "vitest";
import { systemClock } from "./clock.js";
import type { EngineConfig } from "./config.js";
import type { Link, Thread, WorkingNotes } from "./domain.js";
import type { LlmAdapter, Platform } from "./platform.js";
import { synthesize, type EngineContext } from "./pipeline.js";
import { Err, Ok } from "./result.js";
import type { Store } from "./store.js";

const COMMENT_URL = "https://api.github.com/repos/o/r/issues/comments/1";

const mkThread = (overrides: Partial<Thread> = {}): Thread => ({
  platform: "github",
  nativeId: "o/r#1",
  type: "pr",
  title: "Add feature",
  state: "open",
  participants: ["u-alice"],
  meta: {},
  timeline: [
    { kind: "comment", actor: "u-alice", at: "2026-01-01T00:00:00Z", data: { body: "wip" } },
  ],
  ...overrides,
});

function fakeStore(links: Link[] = [], threads = new Map<string, Thread>()) {
  const notes = new Map<string, WorkingNotes>();
  const store = {
    async getLinks() {
      return Ok(links);
    },
    async getThread(platform: string, nativeId: string) {
      return Ok(threads.get(`${platform}:${nativeId}`));
    },
    async getIdentity() {
      return Ok(undefined);
    },
    async getWorkingNotes(scope: string, targetId: string) {
      return Ok(notes.get(`${scope}:${targetId}`));
    },
    async upsertWorkingNotes(n: WorkingNotes) {
      notes.set(`${n.scope}:${n.targetId}`, n);
      return Ok(undefined);
    },
  } as unknown as Store;
  return { store, notes };
}

interface FakeOpts {
  sticky?: string; // findStickyComment result
  editThrows?: { status: number };
}
function fakePlatform(opts: FakeOpts = {}) {
  const calls = { post: 0, edit: [] as string[], find: 0 };
  const platform = {
    id: "github",
    async findStickyComment() {
      calls.find++;
      return Ok(opts.sticky);
    },
    async postMessage() {
      calls.post++;
      return Ok({ id: COMMENT_URL });
    },
    async editMessage(messageId: string) {
      calls.edit.push(messageId);
      if (opts.editThrows) {
        return Err(Object.assign(new Error("gone"), opts.editThrows));
      }
      return Ok(undefined);
    },
  } as unknown as Platform;
  return { platform, calls };
}

function ctxWith(
  store: Store,
  platform: Platform,
  llmOut: () => string,
  shadow = false,
): EngineContext {
  const llm: LlmAdapter = { complete: async () => Ok(llmOut()) };
  return {
    store,
    platforms: new Map([["github", platform]]),
    identities: { list: async () => [], resolve: async () => undefined },
    llm,
    config: { shadow: { global: shadow, capabilities: {} } } as EngineConfig,
    clock: systemClock,
  };
}

describe("synthesize", () => {
  it("posts a new sticky comment on first run and stores externalRef", async () => {
    const { store, notes } = fakeStore();
    const { platform, calls } = fakePlatform();
    const r = await synthesize(
      ctxWith(store, platform, () => "v1"),
      mkThread(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(calls.post).toBe(1);
    expect(notes.get("thread:o/r#1")?.externalRef).toBe(COMMENT_URL);
  });

  it("is idempotent: unchanged inputs post/edit nothing (and skip the LLM)", async () => {
    const { store } = fakeStore();
    const { platform, calls } = fakePlatform();
    let llmCalls = 0;
    const ctx = ctxWith(store, platform, () => {
      llmCalls++;
      return "v1";
    });
    const r1 = await synthesize(ctx, mkThread());
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw r1.error;
    const r2 = await synthesize(ctx, mkThread());
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw r2.error;
    expect(calls.post).toBe(1);
    expect(calls.edit).toHaveLength(0);
    expect(llmCalls).toBe(1); // second run short-circuits before the LLM
  });

  it("edits in place when an INPUT changes (not when only LLM prose differs)", async () => {
    const { store } = fakeStore();
    const { platform, calls } = fakePlatform();
    const ctx = ctxWith(store, platform, () => "vN");
    const r1 = await synthesize(ctx, mkThread());
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw r1.error;
    const r2 = await synthesize(ctx, mkThread({ state: "merged" })); // input changed
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw r2.error;
    expect(calls.post).toBe(1);
    expect(calls.edit).toEqual([COMMENT_URL]);
  });

  it("recovers a lost externalRef via the marker (D1 reset) and edits, not duplicates", async () => {
    const { store } = fakeStore();
    const { platform, calls } = fakePlatform({ sticky: COMMENT_URL });
    const r = await synthesize(
      ctxWith(store, platform, () => "v1"),
      mkThread(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(calls.find).toBe(1);
    expect(calls.edit).toEqual([COMMENT_URL]);
    expect(calls.post).toBe(0); // found existing → edited, no duplicate
  });

  it("re-posts when the sticky comment was deleted (edit 404)", async () => {
    const { store } = fakeStore();
    const { platform, calls } = fakePlatform({ sticky: COMMENT_URL, editThrows: { status: 404 } });
    const r = await synthesize(
      ctxWith(store, platform, () => "v1"),
      mkThread(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(calls.edit).toEqual([COMMENT_URL]); // tried to edit
    expect(calls.post).toBe(1); // 404 → fell back to a fresh post
  });

  it("folds the cluster's cross-thread summary into the issue note", async () => {
    const { store, notes } = fakeStore();
    notes.set("cluster:cluster:o/r#1", {
      scope: "cluster",
      targetId: "cluster:o/r#1",
      content:
        "<!-- aipm:cluster-notes -->\n### Summary\n- slack says ship it\n\n<sub>aipm · abc</sub>",
      contentHash: "abc",
      provenance: "cluster",
    });
    const { platform } = fakePlatform();
    const r = await synthesize(
      ctxWith(store, platform, () => "issue summary"),
      mkThread(),
      { id: "cluster:o/r#1", threadIds: ["o/r#1", "C1/1.2"] },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    const posted = notes.get("thread:o/r#1")!.content;
    expect(posted).toContain("### Related discussion");
    expect(posted).toContain("slack says ship it");
  });

  it("uses cross-platform linked thread state in the content hash without rendering it", async () => {
    const links: Link[] = [{ from: "o/r#1", to: "C1/1700.0001", kind: "cross_ref" }];
    const slackThread = {
      platform: "slack",
      nativeId: "C1/1700.0001",
      type: "slack_thread",
      state: "open",
      participants: [],
      meta: {},
      timeline: [],
    } satisfies Thread;
    const threads = new Map([["slack:C1/1700.0001", slackThread]]);
    const { store, notes } = fakeStore(links, threads);
    const { platform, calls } = fakePlatform();
    const ctx = ctxWith(store, platform, () => "issue summary");
    const r1 = await synthesize(ctx, mkThread());
    expect(r1.ok).toBe(true);
    if (!r1.ok) throw r1.error;
    expect(notes.get("thread:o/r#1")!.content).not.toContain("C1/1700.0001");

    threads.set("slack:C1/1700.0001", { ...slackThread, state: "closed" });
    const r2 = await synthesize(ctx, mkThread());
    expect(r2.ok).toBe(true);
    if (!r2.ok) throw r2.error;
    expect(calls.edit).toHaveLength(1);
  });

  it("shadow posts nothing but persists the would-be note; flipping live then posts", async () => {
    const { store, notes } = fakeStore();
    const { platform, calls } = fakePlatform();
    const shadowRun = await synthesize(
      ctxWith(store, platform, () => "v1", true),
      mkThread(),
    );
    expect(shadowRun.ok).toBe(true);
    if (!shadowRun.ok) throw shadowRun.error;
    expect(calls.post).toBe(0);
    expect(notes.get("thread:o/r#1")?.externalRef).toBeUndefined(); // computed, not posted

    // Flip shadow off, same inputs: must post the first real comment.
    const liveRun = await synthesize(
      ctxWith(store, platform, () => "v1", false),
      mkThread(),
    );
    expect(liveRun.ok).toBe(true);
    if (!liveRun.ok) throw liveRun.error;
    expect(calls.post).toBe(1);
    expect(notes.get("thread:o/r#1")?.externalRef).toBe(COMMENT_URL);
  });
});
