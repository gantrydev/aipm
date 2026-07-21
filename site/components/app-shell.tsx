"use client";

import { useEffect, useState, type ReactNode } from "react";
import { authGithubUrl, fetchMe, type MeResponse } from "../lib/api";

const shell = "mx-auto w-full max-w-5xl px-6 py-10 sm:px-8";

export const AppShell = (props: { title: string; children: ReactNode; requireAuth?: boolean }) => {
  const [me, setMe] = useState<MeResponse | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((data) => {
        if (!cancelled) setMe(data);
      })
      .catch(() => {
        if (!cancelled) setMe(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (me === undefined) {
    return (
      <main className={`${shell} text-muted`}>
        <p className="font-mono text-sm">loading…</p>
      </main>
    );
  }

  if (props.requireAuth !== false && !me) {
    const returnTo =
      typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : "/setup/github";
    return (
      <main className={shell}>
        <h1 className="font-mono text-2xl text-ink">{props.title}</h1>
        <p className="mt-3 max-w-xl text-muted">Sign in with GitHub to continue.</p>
        <a
          className="mt-8 inline-flex rounded-md bg-accent px-4 py-2 font-mono text-sm text-bg"
          href={authGithubUrl(returnTo)}
        >
          continue with github
        </a>
      </main>
    );
  }

  return (
    <main className={shell}>
      <header className="mb-10 flex flex-wrap items-end justify-between gap-4 border-b border-white/10 pb-6">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-faint">aipm</p>
          <h1 className="mt-2 font-mono text-2xl text-ink">{props.title}</h1>
        </div>
        {me ? <p className="font-mono text-sm text-muted">@{me.user.githubLogin}</p> : null}
      </header>
      {props.children}
    </main>
  );
};

export const Panel = (props: { children: ReactNode; className?: string }) => (
  <section className={`card-tight p-5 ${props.className ?? ""}`}>{props.children}</section>
);

export const Muted = (props: { children: ReactNode }) => (
  <p className="text-sm leading-relaxed text-muted">{props.children}</p>
);

export const NavLink = (props: { href: string; children: ReactNode }) => (
  <a className="font-mono text-sm text-accent underline-offset-4 hover:underline" href={props.href}>
    {props.children}
  </a>
);
