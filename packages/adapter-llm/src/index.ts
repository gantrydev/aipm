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
    const res = (await this.config.ai.run(
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
    )) as { response?: string };
    return res.response ?? "";
  }
}

/** A deterministic stub for tests / shadow runs without an AI binding. */
export class EchoLlmAdapter implements LlmAdapter {
  async complete(prompt: string): Promise<string> {
    return prompt;
  }
}
