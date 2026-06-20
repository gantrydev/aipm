import { describe, expect, it } from "vitest";
import type { Identity } from "./domain.js";
import { configIdentitySource, ensureIdentityForHandle, rowToIdentity } from "./identity-source.js";
import type { Store } from "./store.js";

function fakeStore(seed: Identity[] = []) {
  const ids = new Map(seed.map((i) => [i.id, i]));
  const store = {
    async upsertIdentity(i: Identity) {
      ids.set(i.id, i);
    },
    async findIdentity(q: { handle?: string; email?: string }) {
      for (const i of ids.values()) {
        if (q.email && i.email === q.email) return i;
        if (q.handle && Object.values(i.handles).includes(q.handle)) return i;
      }
      return undefined;
    },
    async deleteIdentity(id: string) {
      ids.delete(id);
    },
  } as unknown as Store;
  return { store, ids };
}

const roster = [
  { id: "u-alice", github: "alice", email: "alice@x.com", slack: "alice.s" },
  { github: "bob", email: "bob@x.com" },
];

describe("rowToIdentity", () => {
  it("defaults id to github:<login> and maps handles", () => {
    expect(rowToIdentity({ github: "bob" })).toEqual({
      id: "github:bob",
      handles: { github: "bob" },
      email: undefined,
      displayName: undefined,
    });
  });
  it("throws without id or github", () => {
    expect(() => rowToIdentity({ email: "x@y.com" })).toThrow();
  });
});

describe("configIdentitySource", () => {
  it("resolves by email then by handle", async () => {
    const src = configIdentitySource(roster);
    expect((await src.resolve({ email: "alice@x.com" }))?.id).toBe("u-alice");
    expect((await src.resolve({ handle: "bob" }))?.id).toBe("github:bob");
    expect(await src.resolve({ handle: "nobody" })).toBeUndefined();
  });
});

describe("ensureIdentityForHandle", () => {
  it("uses the roster canonical id and merges the handle", async () => {
    const { store, ids } = fakeStore();
    const src = configIdentitySource(roster);
    const id = await ensureIdentityForHandle(store, src, "github", "alice");
    expect(id).toBe("u-alice");
    expect(ids.get("u-alice")?.handles.github).toBe("alice");
  });

  it("creates a github:<login> partial on miss", async () => {
    const { store, ids } = fakeStore();
    const src = configIdentitySource([]);
    const id = await ensureIdentityForHandle(store, src, "github", "carol");
    expect(id).toBe("github:carol");
    expect(ids.get("github:carol")?.handles.github).toBe("carol");
  });

  it("collapses a pre-existing partial into a roster custom id (no duplicate rows)", async () => {
    // 1) ingested before the roster knew bob -> partial github:bob created.
    const { store, ids } = fakeStore();
    await ensureIdentityForHandle(store, configIdentitySource([]), "github", "bob");
    expect(ids.has("github:bob")).toBe(true);

    // 2) roster later maps bob to a custom canonical id.
    const id = await ensureIdentityForHandle(
      store,
      configIdentitySource([{ id: "u-bob", github: "bob", slack: "U9" }]),
      "github",
      "bob",
    );
    expect(id).toBe("u-bob");
    expect(ids.has("github:bob")).toBe(false); // stale partial collapsed
    expect(ids.get("u-bob")?.handles).toMatchObject({ github: "bob", slack: "U9" });
  });
});
