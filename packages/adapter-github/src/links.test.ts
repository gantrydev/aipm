import { describe, expect, it } from "vitest";
import { discoverLinksFromText } from "./links.js";

describe("discoverLinksFromText", () => {
  it("detects closing keywords as closes links", () => {
    const links = discoverLinksFromText("owner/repo#10", "This fixes #42 and refs owner/repo#7");
    expect(links).toContainEqual({ from: "owner/repo#10", to: "#42", kind: "closes" });
  });

  it("detects plain references as refs links", () => {
    const links = discoverLinksFromText("owner/repo#10", "see owner/repo#7 for context");
    expect(links).toContainEqual({ from: "owner/repo#10", to: "owner/repo#7", kind: "refs" });
  });

  it("does not link a thread to itself", () => {
    const links = discoverLinksFromText("owner/repo#10", "loops back to owner/repo#10");
    expect(links).toHaveLength(0);
  });
});
