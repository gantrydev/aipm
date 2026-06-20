import { describe, expect, it } from "vitest";
import { discoverLinksFromGraphql } from "./discover-links.js";

const repoRef = (n: number) => ({ number: n, repository: { nameWithOwner: "o/r" } });

describe("discoverLinksFromGraphql (DESIGN §4)", () => {
  it("closes: PR closingIssuesReferences", () => {
    const links = discoverLinksFromGraphql("o/r#10", {
      closingIssuesReferences: { nodes: [repoRef(42)] },
    });
    expect(links).toContainEqual({ from: "o/r#10", to: "o/r#42", kind: "closes" });
  });

  it("closes (inverse): issue closedByPullRequestsReferences", () => {
    const links = discoverLinksFromGraphql("o/r#42", {
      closedByPullRequestsReferences: { nodes: [repoRef(10)] },
    });
    expect(links).toContainEqual({ from: "o/r#10", to: "o/r#42", kind: "closes" });
  });

  it("cross_ref: CrossReferencedEvent regardless of willCloseTarget", () => {
    const links = discoverLinksFromGraphql("o/r#1", {
      timelineItems: {
        nodes: [
          { __typename: "CrossReferencedEvent", willCloseTarget: false, source: repoRef(2) },
          { __typename: "CrossReferencedEvent", willCloseTarget: true, source: repoRef(3) },
        ],
      },
    });
    expect(links).toContainEqual({ from: "o/r#2", to: "o/r#1", kind: "cross_ref" });
    expect(links).toContainEqual({ from: "o/r#3", to: "o/r#1", kind: "cross_ref" });
  });

  it("refs: ConnectedEvent, negated by a later DisconnectedEvent", () => {
    const links = discoverLinksFromGraphql("o/r#1", {
      timelineItems: {
        nodes: [
          { __typename: "ConnectedEvent", subject: repoRef(2) },
          { __typename: "ConnectedEvent", subject: repoRef(3) },
          { __typename: "DisconnectedEvent", subject: repoRef(2) },
        ],
      },
    });
    expect(links).toContainEqual({ from: "o/r#1", to: "o/r#3", kind: "refs" });
    expect(links).not.toContainEqual({ from: "o/r#1", to: "o/r#2", kind: "refs" });
  });

  it("sub_issue: parent + subIssues normalized child->parent", () => {
    const links = discoverLinksFromGraphql("o/r#5", {
      parent: repoRef(1),
      subIssues: { nodes: [repoRef(8)] },
    });
    expect(links).toContainEqual({ from: "o/r#5", to: "o/r#1", kind: "sub_issue" });
    expect(links).toContainEqual({ from: "o/r#8", to: "o/r#5", kind: "sub_issue" });
  });

  it("blocked_by: blockedBy + blocking in a single direction", () => {
    const links = discoverLinksFromGraphql("o/r#5", {
      blockedBy: { nodes: [repoRef(2)] },
      blocking: { nodes: [repoRef(9)] },
    });
    expect(links).toContainEqual({ from: "o/r#5", to: "o/r#2", kind: "blocked_by" });
    expect(links).toContainEqual({ from: "o/r#9", to: "o/r#5", kind: "blocked_by" });
  });

  it("never links a thread to itself", () => {
    const links = discoverLinksFromGraphql("o/r#1", {
      closingIssuesReferences: { nodes: [repoRef(1)] },
    });
    expect(links).toHaveLength(0);
  });
});
