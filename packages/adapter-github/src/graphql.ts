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
 * once GA, required while in preview) and throws on transport or `errors`.
 */
export async function ghGraphQL<T = unknown>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  opts: GhGraphQLOptions = {},
): Promise<T> {
  const base = opts.apiBaseUrl ?? "https://api.github.com";
  const doFetch = opts.fetchImpl ?? fetch;

  const res = await doFetch(`${base}/graphql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "aipm-worker",
      Accept: "application/vnd.github+json",
      "GraphQL-Features": "sub_issues",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GitHub GraphQL HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }

  const json = (await res.json()) as { data?: T; errors?: GraphQLError[] };
  if (json.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (json.data === undefined) throw new Error("GitHub GraphQL: empty response");
  return json.data;
}
