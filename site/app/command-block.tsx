"use client";

import { useState } from "react";

const ROWS = [
  { cmd: "wrangler secret put GITHUB_APP_PRIVATE_KEY", note: null, divider: false },
  { cmd: "wrangler secret put SLACK_BOT_TOKEN", note: null, divider: false },
  { cmd: "wrangler secret put SLACK_SIGNING_SECRET", note: null, divider: false },
  { cmd: "wrangler dev", note: "replay captured webhook + Slack payloads", divider: true },
  { cmd: "wrangler deploy", note: "ship to Cloudflare's edge", divider: false },
] as const;

const IconCopy = () => (
  <svg
    viewBox="0 0 24 24"
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);
const IconCheck = () => (
  <svg
    viewBox="0 0 24 24"
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 13l4 4L19 7" />
  </svg>
);

const CommandBlock = () => {
  const [copied, setCopied] = useState(-1);

  const onCopy = async (index: number, cmd: string) => {
    const clip = navigator.clipboard;
    if (!clip) return;
    const [outcome] = await Promise.allSettled([clip.writeText(cmd)]);
    if (outcome.status !== "fulfilled") return;
    setCopied(index);
    window.setTimeout(() => setCopied((current) => (current === index ? -1 : current)), 1300);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-white/10 bg-[#0a0e18] font-mono text-[12.5px] shadow-[0_18px_44px_-30px_rgba(0,0,0,0.9)]">
      <div className="flex items-center gap-2 border-b border-white/8 bg-white/[0.025] px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/70" />
        <span className="ml-2 text-[11px] tracking-wide text-faint">~/aipm</span>
      </div>
      <div className="py-2">
        {ROWS.map((row, index) => (
          <div key={row.cmd} className={row.divider ? "mt-2 border-t border-white/8 pt-2" : ""}>
            <button
              type="button"
              onClick={() => onCopy(index, row.cmd)}
              aria-label={`Copy: ${row.cmd}`}
              className="group flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors hover:bg-white/5"
            >
              <span className="mt-0.5 shrink-0 select-none self-start text-accent/80">$</span>
              <span className="break-words text-ink">{row.cmd}</span>
              <span
                className={`ml-auto shrink-0 self-start pt-0.5 transition-colors ${copied === index ? "text-approved" : "text-faint/50 group-hover:text-muted"}`}
              >
                {copied === index ? <IconCheck /> : <IconCopy />}
              </span>
            </button>
            {row.note ? (
              <div className="px-4 pb-2 pl-9 text-[11.5px] leading-snug text-faint">
                <span className="select-none">{"# "}</span>
                {row.note}
              </div>
            ) : null}
          </div>
        ))}
        <div className="flex items-center gap-2.5 px-4 pt-1 pb-1.5 text-faint">
          <span className="select-none text-accent/80">$</span>
          <span className="cursor inline-block h-3.5 w-[7px] translate-y-px bg-accent/70" />
        </div>
      </div>
    </div>
  );
};

export default CommandBlock;
