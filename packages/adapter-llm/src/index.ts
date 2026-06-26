import type { LlmAdapter, LlmOptions } from "@aipm/core";

export interface WorkersAiConfig {
  ai: Ai;
  /** e.g. "@cf/meta/llama-3.1-8b-instruct". */
  model: string;
  /** AI Gateway id for caching + observability + provider swap (DESIGN §3). */
  gatewayId?: string;
  defaultMaxTokens?: number;
  /** Hard wall-clock bound on one completion; on timeout, returns "" (callers treat empty as skip). */
  requestTimeoutMs: number;
}

/**
 * LLM adapter over Workers AI behind AI Gateway. The model provider is
 * swappable and responses are cached at the gateway (DESIGN §3, §12).
 */
export class WorkersAiLlmAdapter implements LlmAdapter {
  constructor(private readonly config: WorkersAiConfig) {}

  async complete(prompt: string, opts: LlmOptions = {}): Promise<string> {
    const messages = [
      ...(opts.system ? [{ role: "system" as const, content: opts.system }] : []),
      { role: "user" as const, content: prompt },
    ];
    const completion = this.config.ai.run(
      // workers-types types `model` as a known union; deployments may use any.
      this.config.model as never,
      {
        messages,
        max_tokens: opts.maxTokens ?? this.config.defaultMaxTokens ?? 1024,
        temperature: opts.temperature,
      } as never,
      this.config.gatewayId
        ? { gateway: { id: this.config.gatewayId, cacheKey: opts.cacheKey } }
        : undefined,
    );
    const timedOut = Symbol("llm-timeout");
    const timer = new Promise<typeof timedOut>((resolve) =>
      setTimeout(() => resolve(timedOut), this.config.requestTimeoutMs),
    );
    const res = await Promise.race([completion, timer]);
    if (res === timedOut) return "";
    return extractText(res);
  }
}

/**
 * Extract the assistant text across Workers AI response shapes: legacy
 * `{response}`, OpenAI Responses (`output_text` / `output[].content[].text`),
 * and Chat Completions (`choices[].message.content`). gpt-oss models return the
 * Responses shape via /ai/run, llama returns `{response}`.
 */
export function extractText(res: unknown): string {
  const r = res as Record<string, unknown>;
  if (typeof r?.response === "string") return r.response;
  if (typeof r?.output_text === "string") return r.output_text;

  if (Array.isArray(r?.output)) {
    const output = r.output as Array<Record<string, unknown>>;
    const parts = output.flatMap((item) => {
      if (item?.type === "reasoning") return []; // skip chain-of-thought items
      const content = (item?.content as Array<Record<string, unknown>>) ?? [];
      return content.flatMap((c) => (typeof c?.text === "string" ? [c.text] : []));
    });
    if (parts.length) return parts.join("");
  }

  const choice = (r?.choices as Array<Record<string, unknown>>)?.[0];
  const msg = choice?.message as { content?: unknown } | undefined;
  if (typeof msg?.content === "string") return msg.content;

  return "";
}

/** A deterministic stub for tests / shadow runs without an AI binding. */
export class EchoLlmAdapter implements LlmAdapter {
  async complete(prompt: string): Promise<string> {
    return prompt;
  }
}

// --- Budget cap ---------------------------------------------------------------

/** Minimal KV-shaped counter store (KVNamespace satisfies this structurally). */
export interface CounterStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export type BudgetWindow = "minute" | "day";

/** Thrown when an LLM call would exceed a configured budget window. */
export class LlmBudgetExceededError extends Error {
  constructor(
    readonly window: BudgetWindow,
    readonly limit: number,
  ) {
    super(`LLM budget exceeded: ${window} limit of ${limit} reached`);
    this.name = "LlmBudgetExceededError";
  }
}

export interface BudgetConfig {
  store: CounterStore;
  /** Max LLM calls per UTC minute (<=0 disables this window). */
  perMinute: number;
  /** Max LLM calls per UTC day (<=0 disables this window). */
  perDay: number;
  /** Injectable clock for tests; defaults to wall time. */
  now?: () => Date;
}

const KEY_PREFIX = "llm:budget:";
const MINUTE_TTL = 120; // 2 min — outlives its bucket so stale buckets self-expire.
const DAY_TTL = 172_800; // 2 days.

/**
 * Hard ceiling on LLM spend so a bug (runaway loop) or abuse (event flood) can't
 * run up the Workers AI bill. Decorates any {@link LlmAdapter}: it reserves quota
 * in two rolling UTC windows (per-minute caps bursts, per-day caps sustained
 * load) before delegating, and throws {@link LlmBudgetExceededError} once a
 * window is full — the engine treats that like any other LLM failure (logged,
 * skipped, retried next event), so deterministic work degrades gracefully.
 *
 * The counter is read-modify-write over KV, which is eventually consistent and
 * not atomic — so accurate counting assumes the caller bounds how many LLM calls
 * run concurrently (the worker caps queue-consumer concurrency for exactly this).
 * Under that bound the slop is at most a few calls per window; it also counts
 * AI-Gateway cache hits, erring toward tripping early. It is a backstop, not the
 * only line of defense — the member-trigger gate keeps untrusted load out, and
 * bounded concurrency caps the spend rate even if a window miscounts.
 */
export class BudgetedLlmAdapter implements LlmAdapter {
  constructor(
    private readonly inner: LlmAdapter,
    private readonly config: BudgetConfig,
  ) {}

  async complete(prompt: string, opts?: LlmOptions): Promise<string> {
    const now = (this.config.now ?? (() => new Date()))();
    const windows = (
      [
        { name: "minute", key: minuteKey(now), limit: this.config.perMinute, ttl: MINUTE_TTL },
        { name: "day", key: dayKey(now), limit: this.config.perDay, ttl: DAY_TTL },
      ] as const
    ).filter((w) => w.limit > 0);

    const checked = await Promise.all(
      windows.map(async (w) => ({ ...w, count: await this.read(w.key) })),
    );
    // Check every window before reserving any, so an exhausted day-budget doesn't
    // burn a minute-slot (and vice versa).
    checked.forEach((w) => {
      if (w.count >= w.limit) throw new LlmBudgetExceededError(w.name, w.limit);
    });
    await Promise.all(
      checked.map((w) =>
        this.config.store.put(w.key, String(w.count + 1), { expirationTtl: w.ttl }),
      ),
    );
    return this.inner.complete(prompt, opts);
  }

  private async read(key: string): Promise<number> {
    const raw = await this.config.store.get(key);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
function dayKey(d: Date): string {
  return `${KEY_PREFIX}${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function minuteKey(d: Date): string {
  return `${dayKey(d)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
