import type { Identity, PlatformId } from "./domain.js";
import type { IdentitySource } from "./platform.js";
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
export function rowToIdentity(row: IdentityRow): Identity {
  const handles: Identity["handles"] = {};
  if (row.github) handles.github = row.github;
  if (row.slack) handles.slack = row.slack;
  const id = row.id ?? (row.github ? `github:${row.github}` : undefined);
  if (!id) throw new Error("IdentityRow needs an id or a github handle");
  return { id, handles, email: row.email, displayName: row.displayName };
}

/**
 * Config-backed IdentitySource (DESIGN §5). Pure over a parsed roster — no I/O
 * beyond the optional JSON.parse — so resolution is O(roster) and adapter-free.
 */
export function configIdentitySource(roster: string | IdentityRow[]): IdentitySource {
  const rows: IdentityRow[] = typeof roster === "string" ? safeParse(roster) : roster;
  const identities = rows.map(rowToIdentity);

  return {
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
  };
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
): Promise<string> {
  const fromRoster = await source.resolve({ handle, platform });
  const stored = await store.findIdentity({ handle });

  const canonicalId = fromRoster?.id ?? stored?.id ?? `${platform}:${handle}`;
  const identity: Identity = {
    ...(stored ?? {}),
    ...(fromRoster ?? {}),
    id: canonicalId,
    handles: { ...stored?.handles, ...fromRoster?.handles, [platform]: handle },
  };

  if (stored && stored.id !== canonicalId) await store.deleteIdentity(stored.id);
  await store.upsertIdentity(identity);
  return canonicalId;
}

const safeParse = (s: string): IdentityRow[] => {
  const v = JSON.parse(s);
  if (!Array.isArray(v)) throw new Error("identity roster must be a JSON array");
  return v as IdentityRow[];
};

const eq = (a: string, b?: string) => !!b && a.toLowerCase() === b.toLowerCase();
