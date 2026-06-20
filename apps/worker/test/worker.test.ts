import { D1Store } from "@aipm/db";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker", () => {
  it("health endpoint responds", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("rejects unsigned github webhooks", async () => {
    const res = await SELF.fetch("https://example.com/webhooks/github", {
      method: "POST",
      body: JSON.stringify({ action: "opened" }),
    });
    expect(res.status).toBe(401);
  });

  it("D1Store round-trips an identity against the migrated schema", async () => {
    const store = new D1Store(env.DB);
    await store.upsertIdentity({
      id: "u1",
      handles: { github: "octocat" },
      email: "o@example.com",
    });
    const found = await store.findIdentity({ handle: "octocat" });
    expect(found?.id).toBe("u1");
  });
});
