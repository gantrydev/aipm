"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell, Muted, NavLink, Panel } from "../../../components/app-shell";
import { apiGet, apiMutate, fetchMe } from "../../../lib/api";

type ConfigResponse = {
  config: {
    notesPrompt: string;
    clusterPrompt: string;
    shadow: { global: boolean; capabilities: Record<string, boolean | undefined> };
  };
  revision: number;
  slack: { status: string };
};

const SetupConfigurePage = () => {
  const workspaceId = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("workspace") ?? "";
  }, []);
  const [csrf, setCsrf] = useState("");
  const [notesPrompt, setNotesPrompt] = useState("");
  const [clusterPrompt, setClusterPrompt] = useState("");
  const [shadowGlobal, setShadowGlobal] = useState(true);
  const [slackStatus, setSlackStatus] = useState("coming_next");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!workspaceId) return;
    Promise.all([fetchMe(), apiGet<ConfigResponse>(`/api/workspaces/${workspaceId}/config`)])
      .then(([me, data]) => {
        if (me) setCsrf(me.csrfToken);
        setNotesPrompt(data.config.notesPrompt);
        setClusterPrompt(data.config.clusterPrompt);
        setShadowGlobal(data.config.shadow.global);
        setSlackStatus(data.slack.status);
      })
      .catch((err: Error) => setError(err.message));
  }, [workspaceId]);

  const save = async () => {
    setError(null);
    try {
      await apiMutate(`/api/workspaces/${workspaceId}/config`, "PUT", csrf, {
        config: {
          notesPrompt,
          clusterPrompt,
          shadow: { global: shadowGlobal, capabilities: {} },
        },
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save_failed");
    }
  };

  return (
    <AppShell title="setup · configure">
      <Panel>
        <Muted>
          Review default prompts. Shadow mode stays on for new workspaces — nothing is posted to
          GitHub until you go live on a capability from the dashboard.
        </Muted>
        {error ? <p className="mt-4 font-mono text-sm text-signal">{error}</p> : null}
        <label className="mt-6 block font-mono text-xs uppercase tracking-wide text-faint">
          notes prompt
          <textarea
            className="mt-2 w-full rounded-md border border-white/10 bg-bg p-3 font-mono text-sm text-ink"
            rows={6}
            value={notesPrompt}
            onChange={(event) => setNotesPrompt(event.target.value)}
          />
        </label>
        <label className="mt-4 block font-mono text-xs uppercase tracking-wide text-faint">
          cluster prompt
          <textarea
            className="mt-2 w-full rounded-md border border-white/10 bg-bg p-3 font-mono text-sm text-ink"
            rows={6}
            value={clusterPrompt}
            onChange={(event) => setClusterPrompt(event.target.value)}
          />
        </label>
        <p className="mt-4 font-mono text-sm text-muted">
          shadow global: <span className="text-signal">{shadowGlobal ? "on" : "off"}</span>
        </p>
        <p className="mt-2 font-mono text-sm text-faint">slack: {slackStatus} (unavailable)</p>
        <div className="mt-6 flex flex-wrap items-center gap-4">
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 font-mono text-sm text-bg disabled:opacity-40"
            disabled={!workspaceId || !csrf}
            onClick={() => void save()}
          >
            save configuration
          </button>
          {saved ? (
            <NavLink href={`/setup/review?workspace=${workspaceId}`}>continue → review</NavLink>
          ) : null}
        </div>
      </Panel>
    </AppShell>
  );
};

export default SetupConfigurePage;
