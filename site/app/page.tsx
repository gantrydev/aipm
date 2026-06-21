import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import type { ReactNode } from "react";
import HeroFlow from "./hero-flow";
import CommandBlock from "./command-block";
import SwapWord from "./swap-word";

hljs.registerLanguage("typescript", typescript);

const GITHUB_URL = "https://github.com/gantryops/aipm";
const DESIGN_URL = "https://github.com/gantryops/aipm/blob/main/DESIGN.md";
const README_URL = "https://github.com/gantryops/aipm/blob/main/README.md";
const ORG_URL = "https://gantryops.dev";

const GUTTER = "mx-auto w-full max-w-6xl px-6 sm:px-8";

const HeroBackdrop = () => (
  <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden opacity-60">
    <svg
      className="absolute -top-10 right-0 h-[130%] w-[80%]"
      viewBox="0 0 600 460"
      fill="none"
      aria-hidden="true"
    >
      <g stroke="rgba(109,140,255,0.28)" strokeWidth="1">
        <path className="edge" d="M120 90 L300 60 L470 130 L520 280 L360 330 L180 250 Z" />
        <path className="edge" d="M300 60 L360 330 M180 250 L470 130 M120 90 L360 330" />
      </g>
      {[
        { x: 120, y: 90, c: "var(--color-accent)", d: "0s" },
        { x: 300, y: 60, c: "var(--color-violet)", d: "0.6s" },
        { x: 470, y: 130, c: "var(--color-accent)", d: "1.2s" },
        { x: 520, y: 280, c: "var(--color-signal)", d: "0.3s" },
        { x: 360, y: 330, c: "var(--color-cyan)", d: "0.9s" },
        { x: 180, y: 250, c: "var(--color-signal)", d: "1.5s" },
      ].map((n) => (
        <circle
          key={`${n.x}-${n.y}`}
          cx={n.x}
          cy={n.y}
          r="4.5"
          fill={n.c}
          className="anim-breathe"
          style={{ animationDelay: n.d }}
        />
      ))}
    </svg>
  </div>
);

const PIPELINE = [
  {
    n: "01",
    name: "ingest",
    blurb:
      "a webhook or sweep lands. the adapter turns it into a thread, then upserts links and participants.",
    primitives: ["Workers", "KV"],
  },
  {
    n: "02",
    name: "evaluate",
    blurb:
      "detectors read the timeline and decide what's owed. no model runs here. signals fire or clear.",
    primitives: ["Workers"],
  },
  {
    n: "03",
    name: "synthesize",
    blurb:
      "it rewrites the thread's notes comment. it re-posts only when the content hash changed.",
    primitives: ["Workers AI", "AI Gateway"],
  },
  {
    n: "04",
    name: "route",
    blurb:
      "open signals become nudges. apply prefs, pick the channel by priority, dedupe, back off.",
    primitives: ["Durable Objects", "D1"],
  },
  {
    n: "05",
    name: "aggregate",
    blurb:
      "what wasn't worth a dm rolls up. one digest per person, one cluster-notes summary per org.",
    primitives: ["Cron", "Queues"],
  },
] as const;

const PRINCIPLES = [
  {
    tag: "suggest-only",
    body: "it edits its own things only. its notes, its dms. anything on your turf is a draft you approve with one reaction.",
  },
  {
    tag: "low-noise",
    body: "one nudge per person, thread, and signal. a second one buys nothing, so it drops to a digest. mute and snooze always win.",
  },
  {
    tag: "deterministic",
    body: "plain logic decides what's owed. the model does two things: judge if a reply answered, and word the nudge.",
  },
  {
    tag: "off-by-default",
    body: "every capability ships turned off. you turn each one on when you trust it, one at a time.",
  },
] as const;

const SIGNALS = [
  {
    signal: "@mentioned, no response",
    trigger: "webhook",
    target: "mentioned person",
    quiet: "1 business day",
    channel: "dm / digest",
    clears: "they reply",
  },
  {
    signal: "review requested",
    trigger: "webhook",
    target: "reviewer",
    quiet: "1 business day",
    channel: "dm",
    clears: "review submitted",
  },
  {
    signal: "unaddressed review comments",
    trigger: "webhook",
    target: "pr author",
    quiet: "1 business day",
    channel: "dm",
    clears: "author replies / pushes",
  },
  {
    signal: "pr open, no reviewer",
    trigger: "webhook + sweep",
    target: "author",
    quiet: "4h",
    channel: "dm",
    clears: "reviewer added",
  },
  {
    signal: "draft pr aged",
    trigger: "sweep",
    target: "author",
    quiet: "> 7 days",
    channel: "digest",
    clears: "marked ready / closed",
  },
  {
    signal: "in-progress stale",
    trigger: "sweep",
    target: "owner / assignee",
    quiet: "> N days",
    channel: "digest (dm if high pri)",
    clears: "thread updated",
  },
  {
    signal: "blocker cleared",
    trigger: "webhook",
    target: "blocked thread's owner",
    quiet: "immediate",
    channel: "dm",
    clears: "fires once",
  },
] as const;

const STACK = [
  { concern: "webhook + Slack ingress", primitive: "Workers" },
  { concern: "staleness + draft-age sweeps", primitive: "Cron Triggers" },
  { concern: "decouple ingest from the rest", primitive: "Queues" },
  { concern: "serialize per-thread updates", primitive: "Durable Objects" },
  { concern: "relational state", primitive: "D1" },
  { concern: "delivery-id dedupe, flags", primitive: "KV" },
  { concern: "summaries + judgment", primitive: "Workers AI · AI Gateway" },
  { concern: "ship it", primitive: "Wrangler" },
] as const;

const ADAPTER_CODE = `interface Platform {
  id: PlatformId;
  listThreads(query): Promise<Array<Thread>>;
  getThread(nativeId): Promise<Thread>;
  getTimeline(nativeId): Promise<Array<TimelineEvent>>;
  discoverLinks(thread): Promise<Array<Link>>;
  postMessage(target, body): Promise<{ id: string }>;
  editMessage(messageId, body): Promise<void>;
  react(messageId, emoji): Promise<void>;
  notifyPerson(identity, body): Promise<void>;
}`;

const Kicker = (props: { children: ReactNode }) => {
  return (
    <div className="mb-3 flex items-center gap-2 font-mono text-xs tracking-widest text-accent uppercase">
      <span className="h-px w-6 bg-accent/60" />
      {props.children}
    </div>
  );
};

const Bullet = (props: { children: ReactNode }) => {
  return (
    <li className="flex gap-2.5 text-sm leading-relaxed text-muted">
      <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent" />
      <span>{props.children}</span>
    </li>
  );
};

const GH_ICON =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z";
const SL_ICON =
  "M3.36 10.1A1.68 1.68 0 1 1 1.68 8.4h1.68v1.7Zm.84 0a1.68 1.68 0 0 1 3.36 0v4.22a1.68 1.68 0 1 1-3.36 0V10.1ZM5.88 3.36A1.68 1.68 0 1 1 7.56 1.68v1.68H5.88Zm0 .85a1.68 1.68 0 0 1 0 3.36H1.66a1.68 1.68 0 1 1 0-3.36h4.22ZM12.64 5.9a1.68 1.68 0 1 1 1.68 1.68h-1.68V5.9Zm-.84 0a1.68 1.68 0 0 1-3.36 0V1.68a1.68 1.68 0 1 1 3.36 0V5.9ZM10.12 12.64a1.68 1.68 0 1 1-1.68 1.68v-1.68h1.68Zm0-.84a1.68 1.68 0 0 1 0-3.36h4.22a1.68 1.68 0 1 1 0 3.36h-4.22Z";

const AdapterFlow = () => {
  const highlighted = hljs.highlight(ADAPTER_CODE, { language: "typescript" }).value;
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col items-center">
      <div className="grid w-full grid-cols-3 gap-2 font-mono text-[13px]">
        <span className="inline-flex items-center justify-center gap-2 justify-self-center rounded-lg border border-github/40 bg-white/[0.03] px-3.5 py-2 text-github">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d={GH_ICON} />
          </svg>
          github
        </span>
        <span className="inline-flex items-center justify-center gap-2 justify-self-center rounded-lg border border-slack/40 bg-white/[0.03] px-3.5 py-2 text-slack">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
            <path d={SL_ICON} />
          </svg>
          slack
        </span>
        <span className="inline-flex items-center justify-center justify-self-center rounded-lg border border-dashed border-faint/60 bg-white/[0.02] px-3.5 py-2 text-muted">
          + anything
        </span>
      </div>

      <svg viewBox="0 0 600 56" className="w-full" fill="none" aria-hidden="true">
        <g stroke="#6d8cff" strokeOpacity="0.5" strokeWidth="1.5">
          <path d="M100,6 C100,30 300,26 300,44" />
          <path d="M300,6 L300,44" />
          <path d="M500,6 C500,30 300,26 300,44" />
        </g>
        <path
          d="M293,42 L300,52 L307,42"
          stroke="#6d8cff"
          strokeOpacity="0.7"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      <div className="w-full overflow-hidden rounded-lg border border-accent/30 bg-[#0a0e18] shadow-[0_18px_44px_-30px_rgba(0,0,0,0.9)]">
        <div className="flex items-center gap-2 border-b border-white/8 bg-white/[0.025] px-4 py-2.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/70" />
          <span className="ml-2 font-mono text-[11px] tracking-wide text-faint">platform.ts</span>
        </div>
        <pre className="overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-6">
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
        </pre>
      </div>

      <svg viewBox="0 0 600 46" className="w-full" fill="none" aria-hidden="true">
        <path d="M300,4 L300,32" stroke="#3fded0" strokeOpacity="0.55" strokeWidth="1.5" />
        <path
          d="M293,30 L300,40 L307,30"
          stroke="#3fded0"
          strokeOpacity="0.7"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      <div className="rounded-lg border border-cyan/50 bg-cyan/10 px-5 py-2.5 font-mono text-sm font-bold text-cyan">
        aipm engine
      </div>
    </div>
  );
};

const Page = () => {
  return (
    <>
      <header>
        <div className={`flex h-16 items-center gap-3 ${GUTTER}`}>
          <a href="#top" className="flex items-baseline no-underline">
            <span className="retro text-[26px] leading-none font-black tracking-tight">aipm</span>
          </a>
          <nav className="ml-auto hidden items-center gap-7 text-sm text-muted md:flex">
            <a className="no-underline transition-colors hover:text-ink" href="#how">
              how it works
            </a>
            <a className="no-underline transition-colors hover:text-ink" href="#signals">
              signals
            </a>
            <a className="no-underline transition-colors hover:text-ink" href="#stack">
              stack
            </a>
            <a className="no-underline transition-colors hover:text-ink" href="#start">
              get started
            </a>
          </nav>
          <a
            className="ml-auto text-sm text-muted no-underline transition-colors hover:text-ink md:ml-7"
            href={GITHUB_URL}
          >
            github
          </a>
        </div>
      </header>

      <main id="top">
        {/* ───────────── hero ───────────── */}
        <section className={`relative overflow-hidden py-16 lg:py-24 ${GUTTER}`}>
          <HeroBackdrop />
          <div className="grid items-center gap-10 lg:grid-cols-[1fr_1.05fr] lg:gap-14">
            <div>
              <div className="chip mb-6">
                <span className="h-1.5 w-1.5 rounded-full bg-approved" />
                suggest-only · you approve everything
              </div>
              <h1 className="text-4xl leading-[1.05] font-extrabold tracking-tight text-ink sm:text-5xl lg:text-[3.5rem]">
                a 10x pm for everyone.
                <br />
                <span className="gradient-text">always in the background.</span>
              </h1>
              <p className="mt-6 max-w-[42ch] text-lg leading-relaxed text-muted">
                it watches every <SwapWord /> thread and finds who owes a reply. you get a draft for
                their dm, and nothing sends unless you send it.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a className="btn btn-primary" href="#start">
                  quickstart
                </a>
                <a className="btn btn-ghost" href={GITHUB_URL}>
                  read the source
                </a>
              </div>
              <div className="mt-9 flex flex-wrap gap-x-6 gap-y-2">
                {PRINCIPLES.map((p) => (
                  <span key={p.tag} className="font-mono text-xs text-faint">
                    <span className="text-accent">+</span> {p.tag}
                  </span>
                ))}
              </div>
            </div>
            <div className="relative">
              <HeroFlow />
            </div>
          </div>
        </section>

        {/* ───────────── get started ───────────── */}
        <section id="start" className={`py-16 lg:py-20 ${GUTTER}`}>
          <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-14">
            <div>
              <CommandBlock />
              <div className="mt-4 flex items-start gap-2 text-[13px] leading-relaxed text-muted">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-signal" />a human
                approves every nudge. nothing leaves the Worker on its own.
              </div>
            </div>
            <div>
              <Kicker>get started</Kicker>
              <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
                three commands
              </h2>
              <p className="mt-4 text-base leading-relaxed text-muted">
                set three secrets, point both webhooks at the Worker, then deploy. that&apos;s the
                install.
              </p>
              <ul className="mt-6 space-y-2.5">
                <Bullet>one org-wide GitHub App, so every repo&apos;s threads show up.</Bullet>
                <Bullet>one Slack app, every channel it&apos;s invited to.</Bullet>
              </ul>
              <div className="mt-8 flex flex-wrap gap-3">
                <a className="btn btn-primary" href={README_URL}>
                  full guide
                </a>
                <a className="btn btn-ghost" href={DESIGN_URL}>
                  architecture
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* ───────────── cloudflare-native ───────────── */}
        <section id="stack" className={`py-16 lg:py-24 ${GUTTER}`}>
          <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-14">
            <div>
              <Kicker>cloudflare-native</Kicker>
              <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
                one primitive per concern
              </h2>
              <p className="mt-4 max-w-xl text-base leading-relaxed text-muted">
                every concern maps to a Cloudflare primitive. no servers, no queue to host, no
                database to run.
              </p>
            </div>
            <div className="divide-y divide-white/8 overflow-hidden rounded-xl border border-white/10">
              {STACK.map((row) => (
                <div key={row.concern} className="flex items-center gap-4 px-4 py-3">
                  <span className="text-sm text-muted">{row.concern}</span>
                  <span className="ml-auto rounded-md bg-accent/12 px-2 py-0.5 font-mono text-xs font-medium whitespace-nowrap text-accent">
                    {row.primitive}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ───────────── platform-neutral ───────────── */}
        <section id="adapters" className={`py-16 lg:py-24 ${GUTTER}`}>
          <div className="mx-auto max-w-2xl text-center">
            <div className="mb-3 flex items-center justify-center gap-2.5 font-mono text-xs tracking-widest text-accent uppercase">
              <span className="h-px w-6 bg-accent/60" />
              platform-neutral
              <span className="h-px w-6 bg-accent/60" />
            </div>
            <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
              one interface, any platform
            </h2>
            <p className="mt-4 text-base leading-relaxed text-muted">
              github and slack are just adapters behind one interface. implement it and the whole
              engine runs on a new platform — the llm provider is an adapter too.
            </p>
          </div>
          <div className="mt-12">
            <AdapterFlow />
          </div>
        </section>

        {/* ───────────── how it works: the pipeline ───────────── */}
        <section id="how" className={`py-16 lg:py-24 ${GUTTER}`}>
          <Kicker>how it works</Kicker>
          <h2 className="max-w-3xl text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            five stages, queues between them
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
            a thread moves through one stage at a time. one Durable Object per thread serializes the
            work, so two events can't make two nudges. the engine never names GitHub or Slack. both
            are adapters.
          </p>

          {/* animated rail (lg+) */}
          <div className="relative mt-16 mb-2 hidden h-16 lg:block">
            <div className="absolute top-1/2 right-[8%] left-[8%] h-0.5 -translate-y-1/2 overflow-hidden rounded bg-gradient-to-r from-accent/50 via-violet/50 to-cyan/50">
              <span className="flow-dot" style={{ animationDelay: "0s" }} />
              <span className="flow-dot" style={{ animationDelay: "0.6s" }} />
              <span className="flow-dot" style={{ animationDelay: "1.2s" }} />
              <span className="flow-dot" style={{ animationDelay: "1.8s" }} />
              <span className="flow-dot" style={{ animationDelay: "2.4s" }} />
            </div>
            <div className="absolute inset-0 flex items-center justify-between px-[8%]">
              {PIPELINE.map((stage) => (
                <span
                  key={stage.n}
                  className="-translate-x-1/2 first:translate-x-0 last:-translate-x-full"
                >
                  <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/40 bg-bg font-mono text-base font-bold text-accent glow-accent">
                    {stage.n}
                  </span>
                </span>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {PIPELINE.map((stage) => (
              <div key={stage.n} className="card lift p-5">
                <div className="font-mono text-3xl font-black text-white/12">{stage.n}</div>
                <div className="mt-2 text-lg font-bold text-ink">{stage.name}</div>
                <p className="mt-2 text-[13px] leading-relaxed text-muted">{stage.blurb}</p>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {stage.primitives.map((prim) => (
                    <span
                      key={prim}
                      className="rounded-md border border-white/10 bg-white/4 px-1.5 py-0.5 font-mono text-[10px] text-cyan"
                    >
                      {prim}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-3 rounded-xl border border-signal/25 bg-signal/8 px-4 py-3 text-sm text-muted">
            <span className="font-semibold text-signal">the model is on a tight leash.</span> it
            runs in two places: judging if a reply answered, and wording the nudge. everything else
            is plain logic.
          </div>
        </section>

        {/* ───────────── principles ───────────── */}
        <section className={`py-16 lg:py-20 ${GUTTER}`}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PRINCIPLES.map((p, i) => (
              <div key={p.tag} className="card lift relative overflow-hidden p-6">
                <div className="font-mono text-5xl font-black text-white/5">{`0${i + 1}`}</div>
                <div className="mt-2 font-mono text-sm font-bold text-accent">{p.tag}</div>
                <p className="mt-2.5 text-sm leading-relaxed text-muted">{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ───────────── signals ───────────── */}
        <section id="signals" className={`py-16 lg:py-24 ${GUTTER}`}>
          <Kicker>the detectors</Kicker>
          <h2 className="max-w-3xl text-3xl font-bold tracking-tight text-ink sm:text-4xl">
            seven things it watches
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
            each one is plain logic over the timeline. every threshold is config. the quiet window
            counts business days. when a thread closes, its signals clear.
          </p>

          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {SIGNALS.map((s) => (
              <div key={s.signal} className="card lift flex flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-[15px] font-semibold text-ink">{s.signal}</div>
                  <span className="shrink-0 rounded-md bg-signal/12 px-2 py-0.5 font-mono text-[11px] font-semibold whitespace-nowrap text-signal">
                    {s.quiet}
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 font-mono text-[11px]">
                  <span className="text-faint">trigger</span>
                  <span className="text-muted">{s.trigger}</span>
                  <span className="text-faint">nudges</span>
                  <span className="text-muted">{s.target}</span>
                  <span className="text-faint">via</span>
                  <span className="text-muted">{s.channel}</span>
                </div>
                <div className="mt-4 flex items-center gap-1.5 border-t border-white/8 pt-3 text-[11px] text-faint">
                  <span className="text-approved">clears</span> when {s.clears}
                </div>
              </div>
            ))}
            <div className="card flex flex-col justify-center p-5">
              <div className="text-[15px] font-semibold text-ink">and your own</div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">
                signals are data. add a detector. a contract test feeds it a timeline fixture and
                checks the right signal comes out.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/8 py-12">
        <div className={`flex flex-col gap-8 ${GUTTER}`}>
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <div className="text-3xl font-black tracking-tight text-ink">
                aipm<span className="text-accent">.</span>
              </div>
              <p className="mt-2 max-w-xs text-sm text-muted">10x pm on your background.</p>
            </div>
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm text-muted">
              <a className="no-underline transition-colors hover:text-ink" href={GITHUB_URL}>
                github
              </a>
              <a className="no-underline transition-colors hover:text-ink" href={DESIGN_URL}>
                design
              </a>
              <a className="no-underline transition-colors hover:text-ink" href={README_URL}>
                readme
              </a>
              <a className="no-underline transition-colors hover:text-ink" href="/llms-full.txt">
                for agents
              </a>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/8 pt-6 text-xs text-faint">
            <span>
              a{" "}
              <a
                className="text-muted no-underline transition-colors hover:text-ink"
                href={ORG_URL}
              >
                Gantry
              </a>{" "}
              × plainbyte project
            </span>
          </div>
        </div>
      </footer>
    </>
  );
};

export default Page;
