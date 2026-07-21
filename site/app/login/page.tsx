"use client";

import { useEffect, useState } from "react";
import { AppShell, Muted, Panel } from "../../components/app-shell";
import { authGithubUrl } from "../../lib/api";

const LoginPage = () => {
  const [returnTo, setReturnTo] = useState("/setup/github");

  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get("returnTo");
    if (fromQuery) setReturnTo(fromQuery);
  }, []);

  return (
    <AppShell title="sign in" requireAuth={false}>
      <Panel>
        <Muted>
          Managed ai/pm uses GitHub OAuth. New repositories start in shadow mode — previews only —
          until you explicitly enable working notes.
        </Muted>
        <a
          className="mt-6 inline-flex rounded-md bg-accent px-4 py-2 font-mono text-sm text-bg"
          href={authGithubUrl(returnTo)}
        >
          continue with github
        </a>
      </Panel>
    </AppShell>
  );
};

export default LoginPage;
