"use client";

import { useEffect, useState } from "react";
import { AppShell, Muted, NavLink, Panel } from "../../../components/app-shell";
import { fetchMe, type MeResponse } from "../../../lib/api";

const SetupGithubPage = () => {
  const [me, setMe] = useState<MeResponse | null>(null);
  const appSlug = process.env.NEXT_PUBLIC_GITHUB_APP_SLUG;

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  const installHref = appSlug
    ? `https://github.com/apps/${appSlug}/installations/new`
    : "https://github.com/apps";

  return (
    <AppShell title="setup · github app">
      <Panel>
        <Muted>
          Install the official GitHub App on an organization or user account. ai/pm reconnects the
          workspace from the stable GitHub account id across reinstalls.
        </Muted>
        <div className="mt-6 flex flex-wrap gap-4">
          <a
            className="inline-flex rounded-md bg-accent px-4 py-2 font-mono text-sm text-bg"
            href={installHref}
          >
            install github app
          </a>
          {me?.workspaces[0] ? (
            <NavLink href={`/setup/repositories?workspace=${me.workspaces[0].id}`}>
              already installed → repositories
            </NavLink>
          ) : null}
        </div>
        <p className="mt-6 font-mono text-xs text-faint">
          Slack connection is coming next and is not required for GitHub working notes.
        </p>
      </Panel>
    </AppShell>
  );
};

export default SetupGithubPage;
