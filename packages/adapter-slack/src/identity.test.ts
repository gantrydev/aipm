import { describe, expect, it } from "vitest";
import { resolveSlackId } from "./identity.js";

const json = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

const cfg = (fetchImpl: typeof fetch) => ({ botToken: "xoxb-test", fetchImpl });

describe("resolveSlackId (lookupByEmail)", () => {
  it("returns the user id on ok", async () => {
    const id = await resolveSlackId(cfg(json({ ok: true, user: { id: "U123" } })), {
      email: "a@x.com",
    });
    expect(id).toBe("U123");
  });

  it("returns undefined on users_not_found (a gap, not an error)", async () => {
    const id = await resolveSlackId(cfg(json({ ok: false, error: "users_not_found" })), {
      email: "a@x.com",
    });
    expect(id).toBeUndefined();
  });

  it("throws on missing_scope", async () => {
    await expect(
      resolveSlackId(cfg(json({ ok: false, error: "missing_scope" })), { email: "a@x.com" }),
    ).rejects.toThrow(/missing_scope/);
  });
});

describe("resolveSlackId (users.list fallback)", () => {
  it("paginates, skips bots/deleted, and matches on handle", async () => {
    const pages = [
      {
        ok: true,
        members: [
          { id: "Bbot", is_bot: true, name: "carol" },
          { id: "Udel", deleted: true, name: "carol" },
        ],
        response_metadata: { next_cursor: "c2" },
      },
      {
        ok: true,
        members: [{ id: "Ucarol", name: "carol" }],
        response_metadata: { next_cursor: "" },
      },
    ];
    let i = 0;
    const fetchImpl = (async () =>
      new Response(JSON.stringify(pages[i++]), { status: 200 })) as unknown as typeof fetch;

    const id = await resolveSlackId({ botToken: "x", fetchImpl }, { handle: "carol" });
    expect(id).toBe("Ucarol");
    expect(i).toBe(2); // both pages fetched
  });

  it("retries on HTTP 429 honoring Retry-After, then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ ok: true, user: { id: "U7" } }), { status: 200 });
    }) as unknown as typeof fetch;

    const id = await resolveSlackId(
      { botToken: "x", fetchImpl, sleep: async () => {} },
      { email: "a@x.com" },
    );
    expect(id).toBe("U7");
    expect(calls).toBe(2);
  });
});
