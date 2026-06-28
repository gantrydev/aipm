import { describe, expect, it } from "vitest";
import type { Link, Thread } from "./domain.js";
import {
  buildNotesInput,
  DEFAULT_NOTES_PROMPT,
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
  const base = {
    thread,
    links: [] as Link[],
    linkedStates: new Map<string, string>(),
    instructions: "summarize concisely",
  };

  it("is stable for identical inputs and changes when an input changes", () => {
    expect(notesInputDigest(base)).toBe(notesInputDigest(base));
    const changed = { ...base, thread: { ...thread, state: "merged" } };
    expect(notesInputDigest(changed)).not.toBe(notesInputDigest(base));
  });

  it("changes when the instructions change", () => {
    const changed = { ...base, instructions: "summarize verbosely" };
    expect(notesInputDigest(changed)).not.toBe(notesInputDigest(base));
  });
});

describe("buildNotesInput", () => {
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
    const input = buildNotesInput({ ...thread, timeline: tl });
    expect(input).toContain("real human comment");
    expect(input).toContain("Add feature");
    expect(input).not.toContain(NOTES_MARKER);
    expect(input).not.toContain("bump dep");
  });
});

describe("DEFAULT_NOTES_PROMPT", () => {
  it("carries the bullet-count instruction", () => {
    expect(DEFAULT_NOTES_PROMPT).toContain("Use at most 3 bullets per section");
  });
});

describe("renderWorkingNotes", () => {
  const links: Link[] = [{ from: "o/r#1", to: "o/r#42", kind: "closes" }];
  const linkedStates = new Map([["o/r#42", "open"]]);

  it("includes the marker, summary, and hash footer without restating linked work", () => {
    const content = renderWorkingNotes(
      { thread, links, linkedStates, summaryMarkdown: "### Discussion & decisions\n- soon" },
      "abc123",
    );
    expect(content.startsWith(NOTES_MARKER)).toBe(true);
    expect(content).toContain("### Discussion & decisions");
    expect(content).not.toContain("**Links:**");
    expect(content).not.toContain("o/r#42");
    expect(content).toContain("aipm · abc123");
  });

  it("omits raw Slack thread ids from rendered notes", () => {
    const content = renderWorkingNotes(
      {
        thread,
        links: [{ from: "o/r#1", to: "C0BCL749Q6N/1782230344.374049", kind: "cross_ref" }],
        linkedStates: new Map([["C0BCL749Q6N/1782230344.374049", "open"]]),
        summaryMarkdown: "### What's needed next\n- decide",
      },
      "abc123",
    );

    expect(content).not.toContain("C0BCL749Q6N/1782230344.374049");
    expect(content).not.toContain("**Links:**");
  });

  it("renders concise related discussion generated for new notes", () => {
    const content = renderWorkingNotes(
      {
        thread,
        links: [],
        linkedStates: new Map(),
        summaryMarkdown: "### What's needed next\n- decide",
        related: "### Summary\n- useful context",
      },
      "abc123",
    );

    expect(content).toContain("### Related discussion");
    expect(content).toContain("- useful context");
  });

  it("scrubs raw Slack thread ids from untrusted generated prose", () => {
    const content = renderWorkingNotes(
      {
        thread,
        links: [],
        linkedStates: new Map(),
        summaryMarkdown:
          "### Discussion & decisions\n- See C0BCL749Q6N/1782230344.374049 for context.",
      },
      "abc123",
    );

    expect(content).toContain("See Slack thread for context");
    expect(content).not.toContain("C0BCL749Q6N/1782230344.374049");
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
