import { describe, expect, it } from "vitest";
import { buildConfig } from "./index.js";

describe("buildConfig", () => {
  it("defaults to global shadow mode", () => {
    const r = buildConfig();
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    const cfg = r.data;
    expect(cfg.shadow.global).toBe(true);
  });

  it("fills all signal thresholds from DESIGN §7 defaults", () => {
    const r = buildConfig();
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    const cfg = r.data;
    expect(cfg.signals.pr_no_reviewer.quietPeriodHours).toBe(4);
    expect(cfg.signals.draft_pr_aged.quietPeriodHours).toBe(168);
  });

  it("merges overrides over defaults", () => {
    const r = buildConfig({
      signals: { pr_no_reviewer: { quietPeriodHours: 2, maxEscalations: 1, enabled: false } },
      botAccounts: ["dependabot[bot]"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    const cfg = r.data;
    expect(cfg.signals.pr_no_reviewer.enabled).toBe(false);
    expect(cfg.signals.review_requested.enabled).toBe(true);
    expect(cfg.botAccounts).toContain("dependabot[bot]");
  });
});
