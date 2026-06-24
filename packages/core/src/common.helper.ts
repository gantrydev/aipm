/* eslint-disable local/no-raw-loops */
import type { Result } from "./result.js";

const MAX_ITERATIONS = 10_000_000;

const asyncMap = async <T, V>(arrayList: Array<T>, fn: (item: T, index: number) => Promise<V>) => {
  let index = 0;
  const resultArray: Array<Awaited<V>> = [];
  for (const item of arrayList) {
    const result = await fn(item, index);
    resultArray.push(result);
    index = index + 1;
  }
  return resultArray;
};

const asyncForEach = async <T>(
  arrayList: Array<T>,
  fn: (item: T, index: number) => Promise<void>,
) => {
  let index = 0;
  for (const item of arrayList) {
    await fn(item, index);
    index = index + 1;
  }
};

const asyncFilter = async <T>(arrayList: Array<T>, fn: (item: T) => Promise<boolean>) => {
  const resultArray: Array<T> = [];
  for (const item of arrayList) {
    const keep = await fn(item);
    if (!keep) continue;
    resultArray.push(item);
  }
  return resultArray;
};

type UnfoldStep<S, R> = { kind: "CONTINUE"; next: S } | { kind: "STOP"; value: R };

const asyncUnfold = async <S, R>(
  seed: S,
  step: (state: S) => Promise<UnfoldStep<S, R>>,
): Promise<R> => {
  let state = seed;
  let iterations = 0;
  while (true) {
    const result = await step(state);
    if (result.kind === "STOP") return result.value;
    state = result.next;
    iterations = iterations + 1;
    if (iterations >= MAX_ITERATIONS) {
      throw new Error("Max iterations reached in asyncUnfold");
    }
  }
};

const groupBy = <T, K extends string>(arr: Array<T>, keyfn: (item: T) => K) => {
  const grouped = Object.create(null) as Partial<Record<K, Array<T>>>;
  for (const current of arr) {
    const key = keyfn(current);
    const existing = grouped[key];
    grouped[key] = existing ? [...existing, current] : [current];
  }
  return grouped;
};

const indexBy = <T, K extends string>(arr: Array<T>, keyfn: (item: T) => K) => {
  const indexed = Object.create(null) as Partial<Record<K, T>>;
  for (const current of arr) {
    const key = keyfn(current);
    indexed[key] = current;
  }
  return indexed;
};

const chunk = <T>(arrayList: Array<T>, size: number): Array<Array<T>> => {
  const validSize = Number.isInteger(size) && size > 0;
  if (!validSize) {
    throw new Error(`chunk size must be a positive integer, got ${String(size)}`);
  }
  const count = Math.ceil(arrayList.length / size);
  return Array.from({ length: count }).map((_unused, index) => {
    const start = index * size;
    return arrayList.slice(start, start + size);
  });
};

const unwrap = <T>(result: Result<T, Error>): T => {
  if (result.ok) return result.data;
  throw result.error;
};

export { asyncMap, asyncForEach, asyncFilter, asyncUnfold, groupBy, indexBy, chunk, unwrap };
