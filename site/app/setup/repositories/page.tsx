"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell, Muted, NavLink, Panel } from "../../../components/app-shell";
import { apiGet, apiMutate, fetchMe } from "../../../lib/api";

type Repo = {
  repositoryId: number;
  fullName: string;
  enabled: boolean;
  status: string;
};

const SetupRepositoriesPage = () => {
  const workspaceId = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("workspace") ?? "";
  }, []);
  const [repos, setRepos] = useState<Array<Repo>>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [csrf, setCsrf] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    Promise.all([
      fetchMe(),
      apiGet<{ repositories: Array<Repo> }>(`/api/workspaces/${workspaceId}/repositories`),
    ])
      .then(([me, data]) => {
        if (me) setCsrf(me.csrfToken);
        setRepos(data.repositories.filter((repo) => repo.status === "active"));
        setSelected(
          new Set(data.repositories.filter((repo) => repo.enabled).map((r) => r.repositoryId)),
        );
      })
      .catch((err: Error) => setError(err.message));
  }, [workspaceId]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSaved(false);
  };

  const save = async () => {
    setError(null);
    try {
      const data = await apiMutate<{ repositories: Array<Repo> }>(
        `/api/workspaces/${workspaceId}/repositories`,
        "PUT",
        csrf,
        { enabledRepositoryIds: [...selected] },
      );
      setRepos(data.repositories.filter((repo) => repo.status === "active"));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save_failed");
    }
  };

  return (
    <AppShell title="setup · repositories">
      <Panel>
        <Muted>
          Select repositories to process. Every repository starts shadowed — ai/pm computes previews
          without posting working notes until you enable a capability later.
        </Muted>
        {!workspaceId ? (
          <p className="mt-4 font-mono text-sm text-signal">missing workspace query param</p>
        ) : null}
        {error ? <p className="mt-4 font-mono text-sm text-signal">{error}</p> : null}
        <ul className="mt-6 space-y-3">
          {repos.map((repo) => (
            <li key={repo.repositoryId} className="flex items-center gap-3 font-mono text-sm">
              <input
                type="checkbox"
                checked={selected.has(repo.repositoryId)}
                onChange={() => toggle(repo.repositoryId)}
              />
              <span>{repo.fullName}</span>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 font-mono text-sm text-bg disabled:opacity-40"
            disabled={!workspaceId || !csrf}
            onClick={() => void save()}
          >
            save selection
          </button>
          {saved ? (
            <NavLink href={`/setup/configure?workspace=${workspaceId}`}>
              continue → configure
            </NavLink>
          ) : null}
        </div>
      </Panel>
    </AppShell>
  );
};

export default SetupRepositoriesPage;
