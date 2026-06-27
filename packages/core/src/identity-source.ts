import { findMap } from "./common.helper.js";
import type { Identity, PlatformId } from "./domain.js";
import type { IdentitySource } from "./platform.js";
import { Err, Ok, Result } from "./result.js";
import type { Store } from "./store.js";

/** A roster row from config (file / Worker var / D1 seed). */
export interface IdentityRow {
  /** Canonical id; defaults to `github:${github}` when omitted. */
  id?: string;
  github?: string;
  slack?: string;
  email?: string;
  displayName?: string;
}

/** Map a roster row to an Identity. Canonical id is handle-derived, never email. */
export function rowToIdentity(row: IdentityRow): Result<Identity, Error> {
  const handles: Identity["handles"] = {};
  if (row.github) handles.github = row.github;
  if (row.slack) handles.slack = row.slack;
  const id = row.id ?? (row.github ? `github:${row.github}` : undefined);
  if (!id) return Err(new Error("IdentityRow needs an id or a github handle"));
  return Ok({ id, handles, email: row.email, displayName: row.displayName });
}

/**
 * Config-backed IdentitySource (DESIGN §5). Pure over a parsed roster — no I/O
 * beyond the optional JSON.parse — so resolution is O(roster) and adapter-free.
 */
export function configIdentitySource(
  roster: string | Array<IdentityRow>,
): Result<IdentitySource, Error> {
  const rowsResult = typeof roster === "string" ? safeParse(roster) : Ok(roster);
  if (!rowsResult.ok) return rowsResult;
  const mapped = rowsResult.data.map(rowToIdentity);
  const firstErr = findMap(mapped, (r) =>
    r.ok ? { kind: "CONTINUE" } : { kind: "FOUND", data: r },
  );
  if (firstErr) return firstErr;
  const identities = mapped.flatMap((r) => (r.ok ? [r.data] : []));

  return Ok({
    async list() {
      return identities;
    },
    async resolve(query) {
      if (query.email) {
        const byEmail = identities.find((i) => i.email && eq(i.email, query.email));
        if (byEmail) return byEmail;
      }
      if (query.handle) {
        const byHandle = identities.find((i) =>
          query.platform
            ? i.handles[query.platform] === query.handle
            : Object.values(i.handles).includes(query.handle),
        );
        if (byHandle) return byHandle;
      }
      return undefined;
    },
  });
}

/**
 * Resolve a platform handle to a canonical Identity id, persisting the row.
 * Roster hit → canonical id; miss → `${platform}:${handle}` partial for later
 * enrichment. Both the roster row and any pre-existing store row for this handle
 * are consulted so handles merge into one identity; if a stale partial exists
 * under a different id, it is collapsed into the canonical row (otherwise a
 * roster with a custom id would orphan an earlier-created partial — two rows for
 * one person). Threads referencing the old id self-heal on their next ingest.
 */
export async function ensureIdentityForHandle(
  store: Store,
  source: IdentitySource,
  platform: PlatformId,
  handle: string,
): Promise<Result<string, Error>> {
  const fromRoster = await source.resolve({ handle, platform });
  const storedResult = await store.findIdentity({ handle });
  if (!storedResult.ok) return storedResult;
  const stored = storedResult.data;

  const canonicalId = fromRoster?.id ?? stored?.id ?? `${platform}:${handle}`;
  const identity: Identity = {
    ...(stored ?? {}),
    ...(fromRoster ?? {}),
    id: canonicalId,
    handles: { ...stored?.handles, ...fromRoster?.handles, [platform]: handle },
  };

  if (stored && stored.id !== canonicalId) {
    const deleted = await store.deleteIdentity(stored.id);
    if (!deleted.ok) return deleted;
  }
  const upserted = await store.upsertIdentity(identity);
  if (!upserted.ok) return upserted;
  return Ok(canonicalId);
}

const safeParse = (s: string): Result<Array<IdentityRow>, Error> => {
  const parsed = Result.fromSync(() => JSON.parse(s));
  if (!parsed.ok) return parsed;
  const v = parsed.data;
  if (!Array.isArray(v)) return Err(new Error("identity roster must be a JSON array"));
  const rows = v.map((row) => {
    if (!isIdentityRow(row)) {
      return Err(new Error("identity roster row must contain only strings"));
    }
    return Ok(row);
  });
  const firstErr = findMap(rows, (r) => (r.ok ? { kind: "CONTINUE" } : { kind: "FOUND", data: r }));
  if (firstErr) return firstErr;
  return Ok(rows.flatMap((r) => (r.ok ? [r.data] : [])));
};

const eq = (a: string, b?: string) => !!b && a.toLowerCase() === b.toLowerCase();

const isRecord = (value: unknown): value is Record<string, unknown> => {
  const isObject = typeof value === "object";
  return isObject && value !== null;
};

const isOptionalString = (value: unknown) => {
  return value === undefined || typeof value === "string";
};

const isIdentityRow = (value: unknown): value is IdentityRow => {
  if (!isRecord(value)) return false;
  const validId = isOptionalString(value.id);
  const validGithub = isOptionalString(value.github);
  const validSlack = isOptionalString(value.slack);
  const validEmail = isOptionalString(value.email);
  const validDisplayName = isOptionalString(value.displayName);
  return validId && validGithub && validSlack && validEmail && validDisplayName;
};
