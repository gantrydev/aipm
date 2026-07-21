import { BudgetedLlmAdapter, type CounterStore } from "@aipm/adapter-llm";
import { Ok, Result, type LlmAdapter } from "@aipm/core";
import type { WorkspaceId } from "@aipm/db";
import type { Env } from "../env.js";
import { budgetKey } from "./keys.js";

const DEFAULT_TENANT_LLM_MINUTE = 60;
const DEFAULT_TENANT_LLM_DAY = 1_000;
const DEFAULT_GLOBAL_LLM_MINUTE = 600;
const DEFAULT_GLOBAL_LLM_DAY = 10_000;
const DEFAULT_TENANT_RATE_MINUTE = 300;
const DEFAULT_GLOBAL_RATE_MINUTE = 3_000;

/**
 * Applies an unpublished tenant ceiling first and a deployment hard ceiling
 * second. Tenant counters are workspace-namespaced; global counters contain no
 * customer content.
 */
export function createWorkspaceBudgetedLlm(
  inner: LlmAdapter,
  env: Env,
  workspaceId: WorkspaceId,
): LlmAdapter {
  const kv = counterStore(env.DELIVERY_DEDUPE);
  const global = new BudgetedLlmAdapter(inner, {
    store: prefixedStore(kv, "global-budget:llm:"),
    perMinute: intVar(env.GLOBAL_LLM_PER_MINUTE_HARD_CEILING, DEFAULT_GLOBAL_LLM_MINUTE),
    perDay: intVar(env.GLOBAL_LLM_DAILY_HARD_CEILING, DEFAULT_GLOBAL_LLM_DAY),
  });
  return new BudgetedLlmAdapter(global, {
    store: tenantBudgetStore(kv, workspaceId),
    perMinute: intVar(env.LLM_PER_MINUTE_BUDGET, DEFAULT_TENANT_LLM_MINUTE),
    perDay: intVar(env.LLM_DAILY_BUDGET, DEFAULT_TENANT_LLM_DAY),
  });
}

export interface RateBudgetDecision {
  readonly allowed: boolean;
  readonly exhausted?: "tenant" | "global";
}

/** Reserves one ingress slot, degrading to a safe skip when a ceiling is full. */
export async function consumeWorkspaceRateBudget(
  env: Env,
  workspaceId: WorkspaceId,
  now = new Date(),
): Promise<Result<RateBudgetDecision, Error>> {
  const tenantLimit = intVar(env.TENANT_RATE_PER_MINUTE_CEILING, DEFAULT_TENANT_RATE_MINUTE);
  const globalLimit = intVar(env.GLOBAL_RATE_PER_MINUTE_HARD_CEILING, DEFAULT_GLOBAL_RATE_MINUTE);
  const bucket = minuteBucket(now);
  const tenantKey = budgetKey(workspaceId, "minute", `rate:${bucket}`);
  const globalKey = `global-budget:rate:${bucket}`;
  const store = counterStore(env.DELIVERY_DEDUPE);

  const tenant = await reserve(store, tenantKey, tenantLimit);
  if (!tenant.ok) return tenant;
  if (!tenant.data) return Ok({ allowed: false, exhausted: "tenant" });
  const global = await reserve(store, globalKey, globalLimit);
  if (!global.ok) return global;
  if (!global.data) return Ok({ allowed: false, exhausted: "global" });
  return Ok({ allowed: true });
}

const counterStore = (kv: KVNamespace): CounterStore => ({
  get: (key) => kv.get(key),
  put: (key, value, options) => kv.put(key, value, options),
});

const prefixedStore = (store: CounterStore, prefix: string): CounterStore => ({
  get: (key) => store.get(`${prefix}${key}`),
  put: (key, value, options) => store.put(`${prefix}${key}`, value, options),
});

const tenantBudgetStore = (store: CounterStore, workspaceId: WorkspaceId): CounterStore => ({
  get: (key) => store.get(adapterBudgetKey(workspaceId, key)),
  put: (key, value, options) => store.put(adapterBudgetKey(workspaceId, key), value, options),
});

const adapterBudgetKey = (workspaceId: WorkspaceId, key: string): string => {
  const bucket = key.replace(/^llm:budget:/, "");
  return budgetKey(workspaceId, bucket.includes("T") ? "minute" : "day", bucket);
};

async function reserve(
  store: CounterStore,
  key: string,
  limit: number,
): Promise<Result<boolean, Error>> {
  if (limit <= 0) return Ok(true);
  const loaded = await Result.from(() => store.get(key));
  if (!loaded.ok) return loaded;
  const parsed = Number(loaded.data);
  const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  if (count >= limit) return Ok(false);
  const stored = await Result.from(() => store.put(key, String(count + 1), { expirationTtl: 120 }));
  if (!stored.ok) return stored;
  return Ok(true);
}

const intVar = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || !/^-?\d+$/.test(raw.trim())) return fallback;
  return Number(raw.trim());
};

const pad = (value: number): string => String(value).padStart(2, "0");
const minuteBucket = (date: Date): string =>
  `${String(date.getUTCFullYear())}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}`;
