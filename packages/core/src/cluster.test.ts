import { describe, expect, it } from "vitest";
import { computeClusters, dedupeKey } from "./cluster.js";
import type { Link } from "./domain.js";

describe("computeClusters", () => {
  it("groups connected threads and isolates the rest", () => {
    const links: Link[] = [
      { from: "a", to: "b", kind: "closes" },
      { from: "b", to: "c", kind: "refs" },
    ];
    const clusters = computeClusters(["a", "b", "c", "d"], links);
    const sorted = clusters.map((c) => c.join(",")).sort();
    expect(sorted).toEqual(["a,b,c", "d"]);
  });

  it("includes thread ids that appear only in links", () => {
    const links: Link[] = [{ from: "x", to: "y", kind: "manual" }];
    const clusters = computeClusters([], links);
    expect(clusters).toEqual([["x", "y"]]);
  });
});

describe("dedupeKey", () => {
  it("is stable and ordered person:thread:kind", () => {
    expect(dedupeKey("U1", "owner/repo#1", "review_requested")).toBe(
      "U1:owner/repo#1:review_requested",
    );
  });
});
