import { describe, expect, it } from "vitest";
import { EchoLlmAdapter, extractText } from "./index.js";

describe("extractText", () => {
  it("reads legacy {response} (llama)", () => {
    expect(extractText({ response: "hi" })).toBe("hi");
  });
  it("reads the Responses output[] shape (gpt-oss), skipping reasoning", () => {
    const res = {
      output: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking" }] },
        { type: "message", content: [{ type: "output_text", text: "the answer" }] },
      ],
    };
    expect(extractText(res)).toBe("the answer");
  });
  it("reads output_text convenience field", () => {
    expect(extractText({ output_text: "quick" })).toBe("quick");
  });
  it("reads Chat Completions choices[]", () => {
    expect(extractText({ choices: [{ message: { content: "chat" } }] })).toBe("chat");
  });
  it("returns empty string on an unknown shape", () => {
    expect(extractText({ weird: true })).toBe("");
  });
});

describe("EchoLlmAdapter", () => {
  it("echoes the prompt for deterministic shadow runs", async () => {
    const llm = new EchoLlmAdapter();
    expect(await llm.complete("hello")).toBe("hello");
  });
});
