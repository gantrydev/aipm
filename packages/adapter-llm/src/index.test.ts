import { describe, expect, it } from "vitest";
import {
  BudgetedLlmAdapter,
  type CounterStore,
  EchoLlmAdapter,
  extractText,
  LlmBudgetExceededError,
} from "./index.js";

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

describe("BudgetedLlmAdapter", () => {
  function memStore() {
    const map = new Map<string, string>();
    const store: CounterStore = {
      get: async (k) => map.get(k) ?? null,
      put: async (k, v) => {
        map.set(k, v);
      },
    };
    return { map, store };
  }

  it("passes calls through and counts them under budget", async () => {
    const { map, store } = memStore();
    const now = () => new Date("2026-06-21T12:00:00Z");
    const llm = new BudgetedLlmAdapter(new EchoLlmAdapter(), {
      store,
      perMinute: 5,
      perDay: 100,
      now,
    });
    expect(await llm.complete("hi")).toBe("hi");
    expect(await llm.complete("yo")).toBe("yo");
    expect([...map.values()]).toEqual(["2", "2"]); // minute + day buckets both at 2
  });

  it("throws once the per-minute window is full", async () => {
    const { store } = memStore();
    const now = () => new Date("2026-06-21T12:00:00Z");
    const llm = new BudgetedLlmAdapter(new EchoLlmAdapter(), {
      store,
      perMinute: 2,
      perDay: 100,
      now,
    });
    await llm.complete("a");
    await llm.complete("b");
    await expect(llm.complete("c")).rejects.toBeInstanceOf(LlmBudgetExceededError);
  });

  it("recovers in the next minute bucket", async () => {
    const { store } = memStore();
    let t = new Date("2026-06-21T12:00:00Z");
    const llm = new BudgetedLlmAdapter(new EchoLlmAdapter(), {
      store,
      perMinute: 1,
      perDay: 100,
      now: () => t,
    });
    await llm.complete("a");
    await expect(llm.complete("b")).rejects.toBeInstanceOf(LlmBudgetExceededError);
    t = new Date("2026-06-21T12:01:00Z");
    expect(await llm.complete("c")).toBe("c");
  });

  it("enforces the per-day window across minutes", async () => {
    const { store } = memStore();
    let t = new Date("2026-06-21T12:00:00Z");
    const llm = new BudgetedLlmAdapter(new EchoLlmAdapter(), {
      store,
      perMinute: 100,
      perDay: 2,
      now: () => t,
    });
    await llm.complete("a");
    t = new Date("2026-06-21T12:05:00Z");
    await llm.complete("b");
    t = new Date("2026-06-21T13:00:00Z");
    await expect(llm.complete("c")).rejects.toThrow(/day limit/);
  });

  it("does not consume a minute slot when the day budget is already full", async () => {
    const { map, store } = memStore();
    const now = () => new Date("2026-06-21T12:00:00Z");
    const llm = new BudgetedLlmAdapter(new EchoLlmAdapter(), {
      store,
      perMinute: 100,
      perDay: 1,
      now,
    });
    await llm.complete("a"); // day bucket -> 1
    const minuteBefore = map.get("llm:budget:2026-06-21T12:00");
    await expect(llm.complete("b")).rejects.toBeInstanceOf(LlmBudgetExceededError);
    expect(map.get("llm:budget:2026-06-21T12:00")).toBe(minuteBefore); // unchanged
  });

  it("treats a non-positive limit as a disabled window", async () => {
    const { store } = memStore();
    const now = () => new Date("2026-06-21T12:00:00Z");
    const llm = new BudgetedLlmAdapter(new EchoLlmAdapter(), {
      store,
      perMinute: 0,
      perDay: 0,
      now,
    });
    for (let i = 0; i < 50; i++) expect(await llm.complete("x")).toBe("x");
  });
});
