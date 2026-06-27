import { D1Store } from "@aipm/db";
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { memberGate } from "../src/members.js";
import type { Env } from "../src/env.js";

const ROSTER = JSON.stringify([{ github: "octocat", slack: "U01ALICE" }, { github: "hubot" }]);
const gateEnv = (over: Partial<Env> = {}) =>
  ({ IDENTITY_ROSTER: ROSTER, ...over }) as unknown as Env;

describe("worker", () => {
  it("rejects unsigned github webhooks", async () => {
    const res = await SELF.fetch("https://example.com/webhooks/github", {
      method: "POST",
      body: JSON.stringify({ action: "opened" }),
    });
    expect(res.status).toBe(401);
  });

  it("D1Store round-trips an identity against the migrated schema", async () => {
    const store = new D1Store(env.DB);
    const upserted = await store.upsertIdentity({
      id: "u1",
      handles: { github: "octocat" },
      email: "o@example.com",
    });
    expect(upserted.ok).toBe(true);
    const found = await store.findIdentity({ handle: "octocat" });
    expect(found.ok).toBe(true);
    expect(found.data?.id).toBe("u1");
  });
});

describe("memberGate", () => {
  it("allows roster members and drops non-members by default", async () => {
    const gate = memberGate(gateEnv());
    expect(gate.ok).toBe(true);
    expect(gate.data!.required).toBe(true);
    expect(await gate.data!.allows("github", "octocat")).toBe(true);
    expect(await gate.data!.allows("slack", "U01ALICE")).toBe(true);
    expect(await gate.data!.allows("github", "randostranger")).toBe(false);
    expect(await gate.data!.allows("slack", "U99NOBODY")).toBe(false);
    expect(await gate.data!.allows("github", undefined)).toBe(false);
  });

  it("processes everyone when REQUIRE_MEMBER_TRIGGER=false", async () => {
    const gate = memberGate(gateEnv({ REQUIRE_MEMBER_TRIGGER: "false" }));
    expect(gate.ok).toBe(true);
    expect(gate.data!.required).toBe(false);
    expect(await gate.data!.allows("github", "randostranger")).toBe(true);
    expect(await gate.data!.allows("github", undefined)).toBe(true);
  });

  it("fails safe: an empty roster drops everyone while the gate is on", async () => {
    const gate = memberGate(gateEnv({ IDENTITY_ROSTER: "[]" }));
    expect(gate.ok).toBe(true);
    expect(await gate.data!.allows("github", "octocat")).toBe(false);
  });

  it("only matches a handle on its own platform", async () => {
    const gate = memberGate(gateEnv());
    expect(gate.ok).toBe(true);
    // octocat is a github handle, not a slack id.
    expect(await gate.data!.allows("slack", "octocat")).toBe(false);
  });
});
