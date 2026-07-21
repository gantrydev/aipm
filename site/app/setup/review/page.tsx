"use client";

import { useMemo } from "react";
import { AppShell, Muted, NavLink, Panel } from "../../../components/app-shell";

const SetupReviewPage = () => {
  const workspaceId = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("workspace") ?? "";
  }, []);

  return (
    <AppShell title="setup · review">
      <Panel>
        <Muted>
          You are ready for a shadow run. Open the workspace dashboard to inspect activity previews
          before enabling GitHub working-note writes.
        </Muted>
        <ul className="mt-6 list-disc space-y-2 pl-5 text-sm text-muted">
          <li>repositories selected</li>
          <li>prompts reviewed</li>
          <li>shadow mode on by default</li>
          <li>slack unavailable / coming next</li>
        </ul>
        {workspaceId ? (
          <div className="mt-8">
            <NavLink href={`/app/${workspaceId}/overview`}>open dashboard →</NavLink>
          </div>
        ) : null}
      </Panel>
    </AppShell>
  );
};

export default SetupReviewPage;
