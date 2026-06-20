import { describe, expect, it } from "vitest";
import { fixedClock } from "./clock.js";
import type { EngineConfig, Identity, Preference } from "./index.js";
import type { Platform } from "./platform.js";
import { capturePreference, parsePreferenceText } from "./preferences.js";
import type { EngineContext } from "./pipeline.js";
import type { Store } from "./store.js";

const NOW = "2026-01-10T00:00:00.000Z";

describe("parsePreferenceText", () => {
  const now = new Date(NOW);
  it("parses mute repo", () => {
    expect(parsePreferenceText("mute repo owner/name", now)).toEqual({
      rule: "mute",
      selector: { repo: "owner/name" },
    });
  });
  it("parses mute thread", () => {
    expect(parsePreferenceText("please mute owner/name#42", now)).toEqual({
      rule: "mute",
      selector: { threadId: "owner/name#42" },
    });
  });
  it("treats 'mute repo X#5' as a single-thread mute, not a broken repo mute", () => {
    expect(parsePreferenceText("mute repo owner/name#5", now)).toEqual({
      rule: "mute",
      selector: { threadId: "owner/name#5" },
    });
  });
  it("parses relative snooze", () => {
    expect(parsePreferenceText("snooze me for 2 days", now)).toEqual({
      rule: "snooze",
      selector: {},
      until: "2026-01-12T00:00:00.000Z",
    });
  });
  it("parses snooze until a date", () => {
    expect(parsePreferenceText("snooze me until 2026-02-01", now)).toEqual({
      rule: "snooze",
      selector: {},
      until: "2026-02-01T00:00:00.000Z",
    });
  });
  it("parses care-about with high priority", () => {
    expect(parsePreferenceText("I care about repo owner/name high-pri", now)).toEqual({
      rule: "route",
      selector: { repo: "owner/name", priority: "high" },
    });
  });
  it("parses ownership", () => {
    expect(parsePreferenceText("I own owner/name#7", now)).toEqual({
      rule: "own",
      selector: { threadId: "owner/name#7" },
    });
  });
  it("returns undefined for gibberish", () => {
    expect(parsePreferenceText("hello there", now)).toBeUndefined();
  });
});

function harness(identity?: Identity) {
  const prefs: Preference[] = [];
  const dms: string[] = [];
  const store = {
    async findIdentity() {
      return identity;
    },
    async upsertPreference(p: Preference) {
      prefs.push(p);
    },
  } as unknown as Store;
  const slack = {
    id: "slack",
    async notifyPerson(_i: Identity, body: string) {
      dms.push(body);
    },
  } as unknown as Platform;
  const ctx: EngineContext = {
    store,
    platforms: new Map([["slack", slack]]),
    identities: { list: async () => [], resolve: async () => undefined },
    llm: { complete: async (p) => p },
    config: {} as EngineConfig,
    clock: fixedClock(NOW),
  };
  return { ctx, prefs, dms };
}

describe("capturePreference", () => {
  it("stores a parsed preference and confirms via DM", async () => {
    const { ctx, prefs, dms } = harness({ id: "u-a", handles: { slack: "U1" } });
    const res = await capturePreference(ctx, "U1", "mute repo owner/name");
    expect(res.ok).toBe(true);
    expect(prefs[0]).toMatchObject({
      person: "u-a",
      rule: "mute",
      selector: { repo: "owner/name" },
    });
    expect(dms[0]).toMatch(/Got it/);
  });

  it("rejects an unknown Slack user", async () => {
    const { ctx, prefs } = harness(undefined);
    const res = await capturePreference(ctx, "U?", "mute repo x");
    expect(res).toEqual({ ok: false, reason: "unknown_user" });
    expect(prefs).toHaveLength(0);
  });

  it("DMs help text when it can't parse", async () => {
    const { ctx, prefs, dms } = harness({ id: "u-a", handles: { slack: "U1" } });
    const res = await capturePreference(ctx, "U1", "what can you do?");
    expect(res).toMatchObject({ ok: false, reason: "unparsed" });
    expect(prefs).toHaveLength(0);
    expect(dms[0]).toMatch(/couldn't parse/);
  });
});
