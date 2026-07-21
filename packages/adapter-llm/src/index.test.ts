import { describe, expect, it } from "vitest";
import {
  BudgetedLlmAdapter,
  type CounterStore,
  EchoLlmAdapter,
  extractText,
  LlmBudgetExceededError,
} from "./index.js";

describe("extractText", () => {
  const extracted = (res: unknown): string => {
    const r = extractText(res);
    if (!r.ok) throw r.error;
    return r.data;
  };
  it("reads legacy {response} (llama)", () => {
    expect(extracted({ response: "hi" })).toBe("hi");
  });
  it("reads the Responses output[] shape (gpt-oss), skipping reasoning", () => {
    const res = {
      output: [
        { type: "reasoning", content: [{ type: "reasoning_text", text: "thinking" }] },
        { type: "message", content: [{ type: "output_text", text: "the answer" }] },
      ],
    };
    expect(extracted(res)).toBe("the answer");
  });
  it("reads output_text convenience field", () => {
    expect(extracted({ output_text: "quick" })).toBe("quick");
  });
  it("reads Chat Completions choices[]", () => {
    expect(extracted({ choices: [{ message: { content: "chat" } }] })).toBe("chat");
  });
  it("returns empty string on a valid response with no text", () => {
    expect(extracted({ weird: true })).toBe("");
  });
  it("errors on a non-object response", () => {
    const r = extractText("nope");
    expect(r.ok).toBe(false);
  });
});

describe("EchoLlmAdapter", () => {
  it("echoes the prompt for deterministic shadow runs", async () => {
    const llm = new EchoLlmAdapter();
    const r = await llm.complete("hello");
    expect(r.ok).toBe(true);
    if (!r.ok) throw r.error;
    expect(r.data).toBe("hello");
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
    const hi = await llm.complete("hi");
    expect(hi.ok).toBe(true);
    if (!hi.ok) throw hi.error;
    expect(hi.data).toBe("hi");
    const yo = await llm.complete("yo");
    expect(yo.ok).toBe(true);
    if (!yo.ok) throw yo.error;
    expect(yo.data).toBe("yo");
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
    const a = await llm.complete("a");
    expect(a.ok).toBe(true);
    if (!a.ok) throw a.error;
    const b = await llm.complete("b");
    expect(b.ok).toBe(true);
    if (!b.ok) throw b.error;
    const r = await llm.complete("c");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(LlmBudgetExceededError);
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
    const a = await llm.complete("a");
    expect(a.ok).toBe(true);
    if (!a.ok) throw a.error;
    const b = await llm.complete("b");
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toBeInstanceOf(LlmBudgetExceededError);
    t = new Date("2026-06-21T12:01:00Z");
    const c = await llm.complete("c");
    expect(c.ok).toBe(true);
    if (!c.ok) throw c.error;
    expect(c.data).toBe("c");
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
    const a = await llm.complete("a");
    expect(a.ok).toBe(true);
    if (!a.ok) throw a.error;
    t = new Date("2026-06-21T12:05:00Z");
    const b = await llm.complete("b");
    expect(b.ok).toBe(true);
    if (!b.ok) throw b.error;
    t = new Date("2026-06-21T13:00:00Z");
    const r = await llm.complete("c");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/day limit/);
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
    const a = await llm.complete("a"); // day bucket -> 1
    expect(a.ok).toBe(true);
    if (!a.ok) throw a.error;
    const minuteBefore = map.get("llm:budget:2026-06-21T12:00");
    const r = await llm.complete("b");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(LlmBudgetExceededError);
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
    for (let i = 0; i < 50; i++) {
      const r = await llm.complete("x");
      expect(r.ok).toBe(true);
      if (!r.ok) throw r.error;
      expect(r.data).toBe("x");
    }
  });
});
