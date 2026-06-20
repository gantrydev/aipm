import { describe, expect, it } from "vitest";
import type { Link, Thread } from "./domain.js";
import {
  buildNotesPrompt,
  NOTES_MARKER,
  notesInputDigest,
  renderWorkingNotes,
  stableHash,
} from "./notes.js";
import type { TimelineEvent } from "./domain.js";

const thread: Thread = {
  platform: "github",
  nativeId: "o/r#1",
  type: "pr",
  title: "Add feature",
  state: "open",
  participants: ["u-alice"],
  meta: {},
  timeline: [],
};

describe("stableHash", () => {
  it("is deterministic, 16 hex chars, and changes with input", () => {
    expect(stableHash("hello")).toBe(stableHash("hello"));
    expect(stableHash("hello")).toMatch(/^[0-9a-f]{16}$/);
    expect(stableHash("hello")).not.toBe(stableHash("hellp"));
  });
});

describe("notesInputDigest", () => {
  const base = { thread, links: [] as Link[], linkedStates: new Map<string, string>() };

  it("is stable for identical inputs and changes when an input changes", () => {
    expect(notesInputDigest(base)).toBe(notesInputDigest(base));
    const changed = { ...base, thread: { ...thread, state: "merged" } };
    expect(notesInputDigest(changed)).not.toBe(notesInputDigest(base));
  });
});

describe("buildNotesPrompt", () => {
  it("excludes the bot's own note and bot comments (prevents the re-render loop)", () => {
    const tl: TimelineEvent[] = [
      {
        kind: "comment",
        actor: "u-alice",
        at: "2026-01-01T00:00:00Z",
        data: { body: "real human comment" },
      },
      {
        kind: "comment",
        actor: "github:app[bot]",
        at: "2026-01-01T01:00:00Z",
        data: { body: `${NOTES_MARKER}\n🤖 Working notes …` },
      },
      {
        kind: "comment",
        actor: "github:dependabot[bot]",
        at: "2026-01-01T02:00:00Z",
        data: { body: "bump dep" },
      },
    ];
    const prompt = buildNotesPrompt({ ...thread, timeline: tl });
    expect(prompt).toContain("real human comment");
    expect(prompt).not.toContain(NOTES_MARKER);
    expect(prompt).not.toContain("bump dep");
  });
});

describe("renderWorkingNotes", () => {
  const links: Link[] = [{ from: "o/r#1", to: "o/r#42", kind: "closes" }];
  const linkedStates = new Map([["o/r#42", "open"]]);

  it("includes the marker, linked work, and the hash footer", () => {
    const content = renderWorkingNotes(
      { thread, links, linkedStates, summaryMarkdown: "### Discussion & decisions\n- soon" },
      "abc123",
    );
    expect(content.startsWith(NOTES_MARKER)).toBe(true);
    expect(content).toContain("closes → o/r#42 (open)");
    expect(content).toContain("aipm · abc123");
  });

  it("neutralizes an injected marker/footer in the untrusted summary", () => {
    const malicious = `${NOTES_MARKER}\nhi <!-- sneaky --> <sub>aipm · deadbeef</sub>`;
    const content = renderWorkingNotes(
      { thread, links: [], linkedStates: new Map(), summaryMarkdown: malicious },
      "realhash",
    );
    // Only one real marker (ours, at the top) and one real footer (ours).
    expect(content.split(NOTES_MARKER)).toHaveLength(2);
    expect(content).not.toContain("<!-- sneaky -->");
    expect(content.match(/<sub>aipm ·/g)).toHaveLength(1);
  });
});
