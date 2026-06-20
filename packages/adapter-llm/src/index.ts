import type { LlmAdapter, LlmOptions } from "@aipm/core";

export interface WorkersAiConfig {
  ai: Ai;
  /** e.g. "@cf/meta/llama-3.1-8b-instruct". */
  model: string;
  /** AI Gateway id for caching + observability + provider swap (DESIGN §3). */
  gatewayId?: string;
  defaultMaxTokens?: number;
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
    const res = await this.config.ai.run(
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
    const parts: string[] = [];
    for (const item of r.output as Array<Record<string, unknown>>) {
      if (item?.type === "reasoning") continue; // skip chain-of-thought items
      for (const c of (item?.content as Array<Record<string, unknown>>) ?? []) {
        if (typeof c?.text === "string") parts.push(c.text);
      }
    }
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
