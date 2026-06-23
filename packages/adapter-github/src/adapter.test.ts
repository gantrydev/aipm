import { describe, expect, it } from "vitest";
import { GitHubAdapter } from "./adapter.js";

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

function recordingFetch(response: unknown) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(response), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function recordingFetchSequence(responses: unknown[]) {
  const calls: Captured[] = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(responses[i++]), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("GitHubAdapter outbound", () => {
  it("postMessage creates an issue comment and returns its REST url as id", async () => {
    const { fetchImpl, calls } = recordingFetch({
      url: "https://api.github.com/repos/o/r/issues/comments/99",
    });
    const adapter = new GitHubAdapter({ token: "t", fetchImpl });
    const res = await adapter.postMessage({ threadNativeId: "o/r#5" }, "hello");

    expect(res.id).toBe("https://api.github.com/repos/o/r/issues/comments/99");
    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/repos/o/r/issues/5/comments",
      method: "POST",
      body: { body: "hello" },
    });
  });

  it("editMessage PATCHes the comment url in place", async () => {
    const { fetchImpl, calls } = recordingFetch({});
    const adapter = new GitHubAdapter({ token: "t", fetchImpl });
    await adapter.editMessage("https://api.github.com/repos/o/r/issues/comments/99", "updated");

    expect(calls[0]).toMatchObject({
      url: "https://api.github.com/repos/o/r/issues/comments/99",
      method: "PATCH",
      body: { body: "updated" },
    });
  });

  it("findStickyComment returns the url of the comment containing the marker", async () => {
    const { fetchImpl } = recordingFetch([
      { url: "https://api.github.com/repos/o/r/issues/comments/1", body: "unrelated" },
      {
        url: "https://api.github.com/repos/o/r/issues/comments/2",
        body: "x <!-- aipm:working-notes --> y",
      },
    ]);
    const adapter = new GitHubAdapter({ token: "t", fetchImpl });
    const id = await adapter.findStickyComment("o/r#5", "<!-- aipm:working-notes -->");
    expect(id).toBe("https://api.github.com/repos/o/r/issues/comments/2");
  });

  it("findStickyComment returns undefined when no comment matches", async () => {
    const { fetchImpl } = recordingFetch([{ url: "u1", body: "nope" }]);
    const adapter = new GitHubAdapter({ token: "t", fetchImpl });
    expect(await adapter.findStickyComment("o/r#5", "<!-- aipm:working-notes -->")).toBeUndefined();
  });
});

describe("GitHubAdapter getThread", () => {
  it("falls back to issue lookup when an unhinted number is not a PR", async () => {
    const { fetchImpl, calls } = recordingFetchSequence([
      {
        errors: [{ message: "Could not resolve to a PullRequest with the number of 3809." }],
      },
      {
        data: {
          repository: {
            issue: {
              number: 3809,
              title: "issue title",
              body: "issue body",
              state: "OPEN",
              author: { login: "octocat" },
              timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] },
            },
          },
        },
      },
    ]);
    const adapter = new GitHubAdapter({ token: "t", fetchImpl });

    const thread = await adapter.getThread("acme-corp/web-backend#3809");

    expect(thread).toMatchObject({
      platform: "github",
      nativeId: "acme-corp/web-backend#3809",
      type: "issue",
      title: "issue title",
    });
    expect(calls).toHaveLength(2);
  });
});
