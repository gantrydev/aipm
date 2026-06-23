import { describe, expect, it } from "vitest";
import { debounceMs, githubTypeHints } from "../src/coordinator.js";

describe("githubTypeHints", () => {
  it("preserves issue and PR type hints from full GitHub URLs", () => {
    const hints = githubTypeHints({
      body: "see https://github.com/acme-corp/web-backend/issues/3809",
      timeline: [
        {
          kind: "comment",
          at: "2026-01-01T00:00:00Z",
          data: {
            body: "also https://github.com/acme-corp/web-backend/pull/4200",
          },
        },
      ],
    });

    expect(hints.get("acme-corp/web-backend#3809")).toBe("issue");
    expect(hints.get("acme-corp/web-backend#4200")).toBe("pr");
  });
});

describe("debounceMs", () => {
  it("waits longer for Slack threads so bursts settle before clustering", () => {
    expect(debounceMs({ platform: "slack", payload: {} })).toBe(90_000);
  });

  it("debounces GitHub webhooks but not scheduled sweeps", () => {
    expect(debounceMs({ platform: "github", event: "issues", payload: {} })).toBe(20_000);
    expect(debounceMs({ platform: "github", event: "sweep", payload: {} })).toBe(0);
  });
});
