export interface GhRestOptions {
  apiBaseUrl?: string; // default https://api.github.com
  fetchImpl?: typeof fetch;
}

/** Minimal GitHub REST client. `pathOrUrl` may be a path or an absolute api url. */
export async function ghRest<T = unknown>(
  token: string,
  method: string,
  pathOrUrl: string,
  body?: unknown,
  opts: GhRestOptions = {},
): Promise<T> {
  const base = opts.apiBaseUrl ?? "https://api.github.com";
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${base}${pathOrUrl}`;
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "aipm-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const msg = `GitHub REST ${method} ${url} HTTP ${res.status}: ${await res.text().catch(() => "")}`;
    // Attach status structurally so callers can branch (e.g. 404 deleted comment)
    // without importing this module's types.
    throw Object.assign(new Error(msg), { status: res.status });
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
