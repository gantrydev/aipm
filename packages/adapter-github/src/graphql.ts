import { Err, Ok, Result } from "@aipm/core";

export interface GhGraphQLOptions {
  apiBaseUrl?: string; // default https://api.github.com
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface GraphQLError {
  message: string;
  type?: string;
}

/**
 * Minimal GitHub GraphQL client. Sends the `sub_issues` feature header (harmless
 * once GA, required while in preview) and returns `Err` on transport or `errors`.
 */
export async function ghGraphQL<T = unknown>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  opts: GhGraphQLOptions = {},
): Promise<Result<T, Error>> {
  const base = opts.apiBaseUrl ?? "https://api.github.com";
  const doFetch = opts.fetchImpl ?? fetch;
  const requestBody = Result.fromSync(() => JSON.stringify({ query, variables }));
  if (!requestBody.ok) return requestBody;

  const fetched = await Result.from(() =>
    doFetch(`${base}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "aipm-worker",
        Accept: "application/vnd.github+json",
        "GraphQL-Features": "sub_issues",
      },
      body: requestBody.data,
    }),
  );
  if (!fetched.ok) return fetched;
  const res = fetched.data;

  if (!res.ok) {
    const bodyText = await Result.from(() => res.text());
    const detail = bodyText.ok ? bodyText.data : "";
    return Err(new Error(`GitHub GraphQL HTTP ${res.status}: ${detail}`));
  }

  const parsed = await Result.from(() => res.json());
  if (!parsed.ok) return parsed;
  const json = parsed.data as { data?: T; errors?: Array<GraphQLError> };
  if (json.errors?.length) {
    return Err(new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`));
  }
  if (json.data === undefined) return Err(new Error("GitHub GraphQL: empty response"));
  return Ok(json.data);
}
