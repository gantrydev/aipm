import { describe, expect, it } from "vitest";
import { githubTypeHints } from "../src/coordinator.js";

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
