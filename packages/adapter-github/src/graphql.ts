import { Err, Ok, Result } from "@aipm/core";
import { z } from "zod";

export interface GhGraphQLOptions {
  apiBaseUrl?: string; // default https://api.github.com
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const graphqlEnvelopeSchema = z.looseObject({
  data: z.unknown().optional(),
  errors: z.array(z.looseObject({ message: z.string().optional() })).optional(),
});

/**
 * Minimal GitHub GraphQL client. Sends the `sub_issues` feature header (harmless
 * once GA, required while in preview) and returns `Err` on transport or `errors`.
 * The envelope and its `data` payload are validated against `schema` at the
 * boundary, so callers receive a typed value (or an Err), never narrowing `unknown`.
 */
export async function ghGraphQL<S extends z.ZodType>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  schema: S,
  opts: GhGraphQLOptions = {},
): Promise<Result<z.infer<S>, Error>> {
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
  const envelope = graphqlEnvelopeSchema.safeParse(parsed.data);
  if (!envelope.success) return Err(new Error(`GitHub GraphQL: ${envelope.error.message}`));
  const errors = envelope.data.errors;
  if (errors?.length) {
    const messages = errors.map((e) => e.message ?? "unknown").join("; ");
    return Err(new Error(`GitHub GraphQL errors: ${messages}`));
  }
  if (envelope.data.data === undefined) return Err(new Error("GitHub GraphQL: empty response"));
  const validated = schema.safeParse(envelope.data.data);
  if (!validated.success) return Err(new Error(`GitHub GraphQL: ${validated.error.message}`));
  return Ok(validated.data);
}
