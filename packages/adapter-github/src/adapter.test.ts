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
