"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell, Muted, NavLink, Panel } from "../../../components/app-shell";
import { apiGet, apiMutate, fetchMe } from "../../../lib/api";

type Section = "overview" | "repositories" | "configuration" | "activity" | "settings";

const parsePath = (): { workspaceId: string; section: Section } => {
  if (typeof window === "undefined") return { workspaceId: "", section: "overview" };
  const parts = window.location.pathname.split("/").filter(Boolean);
  const workspaceId = parts[1] ?? "";
  const section = (parts[2] as Section | undefined) ?? "overview";
  const allowed: Array<Section> = [
    "overview",
    "repositories",
    "configuration",
    "activity",
    "settings",
  ];
  return {
    workspaceId,
    section: allowed.includes(section) ? section : "overview",
  };
};

const AppDashboardPage = () => {
  const initial = useMemo(() => parsePath(), []);
  const [workspaceId] = useState(initial.workspaceId);
  const [section] = useState<Section>(initial.section);
  const [csrf, setCsrf] = useState("");

  useEffect(() => {
    fetchMe()
      .then((me) => {
        if (me) setCsrf(me.csrfToken);
      })
      .catch(() => undefined);
  }, []);

  if (!workspaceId) {
    return (
      <AppShell title="workspace">
        <Panel>
          <Muted>Missing workspace id in the path. Start from setup.</Muted>
          <div className="mt-4">
            <NavLink href="/setup/github">go to setup</NavLink>
          </div>
        </Panel>
      </AppShell>
    );
  }

  return (
    <AppShell title={`workspace · ${section}`}>
      <nav className="mb-8 flex flex-wrap gap-4 font-mono text-sm">
        {(
          ["overview", "repositories", "configuration", "activity", "settings"] as Array<Section>
        ).map((item) => (
          <a
            key={item}
            href={`/app/${workspaceId}/${item}`}
            className={item === section ? "text-accent" : "text-muted hover:text-ink"}
          >
            {item}
          </a>
        ))}
      </nav>
      {section === "overview" ? <Overview workspaceId={workspaceId} /> : null}
      {section === "repositories" ? <Repositories workspaceId={workspaceId} csrf={csrf} /> : null}
      {section === "configuration" ? <Configuration workspaceId={workspaceId} csrf={csrf} /> : null}
      {section === "activity" ? <Activity workspaceId={workspaceId} /> : null}
      {section === "settings" ? <Settings /> : null}
    </AppShell>
  );
};

const Overview = (props: { workspaceId: string }) => {
  const [summary, setSummary] = useState("loading…");
  useEffect(() => {
    Promise.all([
      apiGet<{
        installations: Array<{ status: string }>;
        repositories: Array<{ enabled: boolean }>;
      }>(`/api/workspaces/${props.workspaceId}/repositories`),
      apiGet<{
        config: { shadow: { global: boolean } };
      }>(`/api/workspaces/${props.workspaceId}/config`),
    ])
      .then(([repos, config]) => {
        const enabled = repos.repositories.filter((repo) => repo.enabled).length;
        const activeInstalls = repos.installations.filter(
          (item) => item.status === "active",
        ).length;
        setSummary(
          `${activeInstalls} active install(s) · ${enabled} enabled repo(s) · shadow global ${config.config.shadow.global ? "on" : "off"}`,
        );
      })
      .catch((err: Error) => setSummary(err.message));
  }, [props.workspaceId]);

  return (
    <Panel>
      <Muted>{summary}</Muted>
      <p className="mt-4 font-mono text-xs text-faint">
        Slack is unavailable / coming next. GitHub operation does not depend on Slack.
      </p>
    </Panel>
  );
};

const Repositories = (props: { workspaceId: string; csrf: string }) => {
  const [repos, setRepos] = useState<
    Array<{ repositoryId: number; fullName: string; enabled: boolean }>
  >([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{
      repositories: Array<{
        repositoryId: number;
        fullName: string;
        enabled: boolean;
        status: string;
      }>;
    }>(`/api/workspaces/${props.workspaceId}/repositories`)
      .then((data) => {
        const active = data.repositories.filter((repo) => repo.status === "active");
        setRepos(active);
        setSelected(
          new Set(active.filter((repo) => repo.enabled).map((repo) => repo.repositoryId)),
        );
      })
      .catch((err: Error) => setMessage(err.message));
  }, [props.workspaceId]);

  return (
    <Panel>
      <Muted>Enabled repositories are eligible for shadow processing.</Muted>
      <ul className="mt-4 space-y-2">
        {repos.map((repo) => (
          <li key={repo.repositoryId} className="flex items-center gap-3 font-mono text-sm">
            <input
              type="checkbox"
              checked={selected.has(repo.repositoryId)}
              onChange={() => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(repo.repositoryId)) next.delete(repo.repositoryId);
                  else next.add(repo.repositoryId);
                  return next;
                });
              }}
            />
            {repo.fullName}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="mt-6 rounded-md bg-accent px-4 py-2 font-mono text-sm text-bg disabled:opacity-40"
        disabled={!props.csrf}
        onClick={() => {
          void apiMutate(`/api/workspaces/${props.workspaceId}/repositories`, "PUT", props.csrf, {
            enabledRepositoryIds: [...selected],
          })
            .then(() => setMessage("saved"))
            .catch((err: Error) => setMessage(err.message));
        }}
      >
        save
      </button>
      {message ? <p className="mt-3 font-mono text-xs text-muted">{message}</p> : null}
    </Panel>
  );
};

const Configuration = (props: { workspaceId: string; csrf: string }) => {
  const [workingNotesLive, setWorkingNotesLive] = useState(false);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{
      config: { shadow: { capabilities: Record<string, boolean | undefined> } };
      revision: number;
    }>(`/api/workspaces/${props.workspaceId}/config`)
      .then((data) => {
        setRevision(data.revision);
        setWorkingNotesLive(data.config.shadow.capabilities.workingNotes === false);
      })
      .catch((err: Error) => setMessage(err.message));
  }, [props.workspaceId]);

  return (
    <Panel>
      <Muted>
        Shadow-first defaults. Enabling working notes is an explicit capability transition recorded
        in the activity feed.
      </Muted>
      <p className="mt-4 font-mono text-sm text-muted">config revision {revision}</p>
      <p className="mt-2 font-mono text-sm">
        working notes:{" "}
        <span className={workingNotesLive ? "text-approved" : "text-signal"}>
          {workingNotesLive ? "live" : "shadow"}
        </span>
      </p>
      {!workingNotesLive ? (
        <button
          type="button"
          className="mt-6 rounded-md border border-signal/40 px-4 py-2 font-mono text-sm text-signal disabled:opacity-40"
          disabled={!props.csrf}
          onClick={() => {
            void apiMutate<{ revision: number }>(
              `/api/workspaces/${props.workspaceId}/capabilities`,
              "POST",
              props.csrf,
              {
                capability: "workingNotes",
                shadow: false,
              },
            )
              .then((data) => {
                setWorkingNotesLive(true);
                setRevision(data.revision);
                setMessage("working notes enabled");
              })
              .catch((err: Error) => setMessage(err.message));
          }}
        >
          enable working notes
        </button>
      ) : null}
      {message ? <p className="mt-3 font-mono text-xs text-muted">{message}</p> : null}
    </Panel>
  );
};

const Activity = (props: { workspaceId: string }) => {
  const [items, setItems] = useState<
    Array<{ id: string; action: string; outcome: string; createdAt: string }>
  >([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<{ items: Array<{ id: string; action: string; outcome: string; createdAt: string }> }>(
      `/api/workspaces/${props.workspaceId}/activity?limit=50`,
    )
      .then((data) => setItems(data.items))
      .catch((err: Error) => setError(err.message));
  }, [props.workspaceId]);

  return (
    <Panel>
      <Muted>Append-only activity and preview feed for this workspace.</Muted>
      {error ? <p className="mt-4 font-mono text-sm text-signal">{error}</p> : null}
      <ul className="mt-4 space-y-3">
        {items.map((item) => (
          <li key={item.id} className="font-mono text-sm text-muted">
            {item.createdAt} · {item.action} · {item.outcome}
          </li>
        ))}
        {!items.length && !error ? (
          <li className="font-mono text-sm text-faint">no activity yet</li>
        ) : null}
      </ul>
    </Panel>
  );
};

const Settings = () => (
  <Panel>
    <Muted>
      Workspace settings. Slack OAuth is intentionally unavailable until a tenant-safe follow-up
      ships. Do not paste manual Slack tokens into the managed service.
    </Muted>
    <div className="mt-4 flex justify-between gap-4 border-t border-white/5 pt-3 font-mono text-sm">
      <span className="text-faint">slack</span>
      <span className="text-muted">coming next</span>
    </div>
    <div className="mt-4 flex justify-between gap-4 border-t border-white/5 pt-3 font-mono text-sm">
      <span className="text-faint">github oauth</span>
      <span className="text-muted">connected via session</span>
    </div>
  </Panel>
);

export default AppDashboardPage;
