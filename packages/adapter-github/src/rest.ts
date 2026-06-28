import { Err, Ok, Result } from "@aipm/core";
import { z } from "zod";

export interface GhRestOptions {
  apiBaseUrl?: string; // default https://api.github.com
  fetchImpl?: typeof fetch;
}

/**
 * Minimal GitHub REST client. `pathOrUrl` may be a path or an absolute api url.
 * The response body is validated against `schema` at the boundary, so callers
 * receive a typed value (or an Err) and never narrow `unknown` themselves.
 */
export async function ghRest<S extends z.ZodType>(
  token: string,
  method: string,
  pathOrUrl: string,
  body: unknown,
  schema: S,
  opts: GhRestOptions = {},
): Promise<Result<z.infer<S>, Error>> {
  const base = opts.apiBaseUrl ?? "https://api.github.com";
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${base}${pathOrUrl}`;
  const requestBody = body !== undefined ? Result.fromSync(() => JSON.stringify(body)) : null;
  if (requestBody && !requestBody.ok) return requestBody;
  const fetched = await Result.from(() =>
    (opts.fetchImpl ?? fetch)(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "aipm-worker",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: requestBody ? requestBody.data : undefined,
    }),
  );
  if (!fetched.ok) return fetched;
  const res = fetched.data;
  if (!res.ok) {
    const msg = `GitHub REST ${method} ${url} HTTP ${res.status}: ${await res.text().catch(() => "")}`;
    // Attach status structurally so callers can branch (e.g. 404 deleted comment)
    // without importing this module's types.
    return Err(Object.assign(new Error(msg), { status: res.status }));
  }
  if (res.status === 204) {
    const empty = schema.safeParse(undefined);
    if (!empty.success) return Err(new Error(`GitHub REST ${method} ${url}: unexpected empty 204`));
    return Ok(empty.data);
  }
  const parsed = await Result.from(() => res.json());
  if (!parsed.ok) return parsed;
  const validated = schema.safeParse(parsed.data);
  if (!validated.success) {
    return Err(new Error(`GitHub REST ${method} ${url}: ${validated.error.message}`));
  }
  return Ok(validated.data);
}
