import { describe, expect, it } from "vitest";
import { EchoLlmAdapter } from "./index.js";

describe("EchoLlmAdapter", () => {
  it("echoes the prompt for deterministic shadow runs", async () => {
    const llm = new EchoLlmAdapter();
    expect(await llm.complete("hello")).toBe("hello");
  });
});
