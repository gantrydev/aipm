"use client";

import { useEffect, useState } from "react";

const TICK_MS = 3200;

const ITEMS = [
  {
    kind: "gh",
    cx: 92,
    label: "pr #482",
    situ: "no reviewer · 4h",
    to: "rui",
    ref: "#482",
    line: "#482 is open 4h with no reviewer. want me to grab one?",
  },
  {
    kind: "gh",
    cx: 280,
    label: "issue #511",
    situ: "@mentioned · 1d",
    to: "maya",
    ref: "#511",
    line: "you were asked to look at #511 a day ago. still open.",
  },
  {
    kind: "sl",
    cx: 468,
    label: "#support",
    situ: "owes a reply · 2h",
    to: "sam",
    ref: "#support",
    line: "this #support thread has waited on your reply for 2h.",
  },
] as const;

const ghPath =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z";
const slPath =
  "M3.36 10.1A1.68 1.68 0 1 1 1.68 8.4h1.68v1.7Zm.84 0a1.68 1.68 0 0 1 3.36 0v4.22a1.68 1.68 0 1 1-3.36 0V10.1ZM5.88 3.36A1.68 1.68 0 1 1 7.56 1.68v1.68H5.88Zm0 .85a1.68 1.68 0 0 1 0 3.36H1.66a1.68 1.68 0 1 1 0-3.36h4.22ZM12.64 5.9a1.68 1.68 0 1 1 1.68 1.68h-1.68V5.9Zm-.84 0a1.68 1.68 0 0 1-3.36 0V1.68a1.68 1.68 0 1 1 3.36 0V5.9ZM10.12 12.64a1.68 1.68 0 1 1-1.68 1.68v-1.68h1.68Zm0-.84a1.68 1.68 0 0 1 0-3.36h4.22a1.68 1.68 0 1 1 0 3.36h-4.22Z";

const IconCheck = () => (
  <svg
    viewBox="0 0 24 24"
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 13l4 4L19 7" />
  </svg>
);

const ChipNode = (props: { item: (typeof ITEMS)[number]; active: boolean; motion: boolean }) => {
  const it = props.item;
  const x = it.cx - 76;
  const color = it.kind === "sl" ? "#e0709a" : "#c9d1e0";
  const iconPath = it.kind === "sl" ? slPath : ghPath;
  return (
    <g>
      {props.active && props.motion ? (
        <rect
          x={x - 4}
          y={25}
          width={160}
          height={58}
          rx={15}
          fill="none"
          stroke="#6d8cff"
          strokeWidth={1.2}
        >
          <animate
            attributeName="opacity"
            values="0.85;0.2;0.85"
            dur="2s"
            repeatCount="indefinite"
          />
        </rect>
      ) : null}
      <rect
        x={x}
        y={28}
        width={152}
        height={52}
        rx={12}
        fill="#10141f"
        stroke={props.active ? "rgba(109,140,255,0.65)" : "rgba(255,255,255,0.1)"}
        strokeWidth={1}
      />
      <g transform={`translate(${x + 15}, 46)`} fill={color}>
        <path d={iconPath} />
      </g>
      <text
        x={x + 41}
        y={51}
        fontFamily="var(--font-mono)"
        fontSize={12}
        fontWeight={700}
        fill={props.active ? "#e7eaf3" : "#9aa3b8"}
      >
        {it.label}
      </text>
      <text
        x={x + 41}
        y={67}
        fontFamily="var(--font-mono)"
        fontSize={10}
        fill={props.active ? "#ffb84d" : "#5d6678"}
      >
        {it.situ}
      </text>
    </g>
  );
};

const HeroScene = () => {
  const [tick, setTick] = useState(0);
  const [motion, setMotion] = useState(true);
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setMotion(false);
      return;
    }
    const id = window.setInterval(() => {
      setTick((prev) => prev + 1);
      setApproved(false);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  const active = tick % ITEMS.length;
  const item = ITEMS[active];
  if (!item) return null;
  const others = ITEMS.flatMap((it, i) => (i === active ? [] : [it]));

  return (
    <div className="relative w-full" style={{ aspectRatio: "560 / 580" }}>
      <svg
        viewBox="0 0 560 580"
        className="absolute inset-0 h-full w-full overflow-visible"
        role="img"
        aria-label="GitHub and Slack events stream into the aipm engine, which drafts one suggestion for you to approve."
      >
        <defs>
          <radialGradient id="hubcore" cx="40%" cy="34%" r="72%">
            <stop offset="0%" stopColor="#c3ccff" />
            <stop offset="48%" stopColor="#6d8cff" />
            <stop offset="100%" stopColor="#8a6cff" />
          </radialGradient>
          <radialGradient id="ambient" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(109,140,255,0.20)" />
            <stop offset="55%" stopColor="rgba(138,108,255,0.07)" />
            <stop offset="100%" stopColor="rgba(8,10,17,0)" />
          </radialGradient>
          <filter id="glowS" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="2.4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="glowL" x="-90%" y="-90%" width="280%" height="280%">
            <feGaussianBlur stdDeviation="7" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          {ITEMS.map((it, i) => (
            <path key={`def${i}`} id={`in${i}`} d={`M${it.cx},82 C${it.cx},150 280,158 280,202`} />
          ))}
          <path id="out" d="M280,304 C280,328 280,338 280,356" />
        </defs>

        <circle cx={280} cy={252} r={210} fill="url(#ambient)" />

        {/* connector tracks */}
        {ITEMS.map((it, i) => (
          <path
            key={`trk${i}`}
            d={`M${it.cx},82 C${it.cx},150 280,158 280,202`}
            fill="none"
            stroke={i === active ? "rgba(109,140,255,0.55)" : "rgba(109,140,255,0.18)"}
            strokeWidth={1.1}
            strokeDasharray="0.5 7"
            strokeLinecap="round"
          />
        ))}
        <path
          d="M280,304 C280,328 280,338 280,356"
          fill="none"
          stroke="rgba(69,224,154,0.5)"
          strokeWidth={1.2}
          strokeDasharray="0.5 6"
          strokeLinecap="round"
        />

        {/* streaming particles */}
        {motion
          ? ITEMS.flatMap((it, i) =>
              [0, 1.3].map((off) => (
                <circle
                  key={`p${i}-${off}`}
                  r={2.8}
                  fill="#3fded0"
                  opacity={i === active ? 1 : 0.45}
                  filter="url(#glowS)"
                >
                  <animateMotion dur="2.6s" begin={`${i * 0.3 + off}s`} repeatCount="indefinite">
                    <mpath href={`#in${i}`} />
                  </animateMotion>
                  <animate
                    attributeName="opacity"
                    values="0;1;1;0"
                    keyTimes="0;0.12;0.85;1"
                    dur="2.6s"
                    begin={`${i * 0.3 + off}s`}
                    repeatCount="indefinite"
                  />
                </circle>
              )),
            )
          : null}
        {motion
          ? [0.2, 1.3].map((off) => (
              <circle key={`out${off}`} r={3} fill="#45e09a" filter="url(#glowS)">
                <animateMotion dur="2s" begin={`${off}s`} repeatCount="indefinite">
                  <mpath href="#out" />
                </animateMotion>
              </circle>
            ))
          : null}

        {ITEMS.map((it, i) => (
          <ChipNode key={`chip${i}`} item={it} active={i === active} motion={motion} />
        ))}

        {/* hub */}
        {motion ? (
          <circle
            cx={280}
            cy={252}
            r={74}
            fill="none"
            stroke="rgba(109,140,255,0.22)"
            strokeWidth={1}
            strokeDasharray="2 12"
          >
            <animateTransform
              attributeName="transform"
              type="rotate"
              from="0 280 252"
              to="360 280 252"
              dur="28s"
              repeatCount="indefinite"
            />
          </circle>
        ) : null}
        {motion
          ? [0, 1.7].map((off) => (
              <circle
                key={`ring${off}`}
                cx={280}
                cy={252}
                r={52}
                fill="none"
                stroke="#6d8cff"
                strokeWidth={1.2}
              >
                <animate
                  attributeName="r"
                  values="52;88"
                  dur="3.4s"
                  begin={`${off}s`}
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0.5;0"
                  dur="3.4s"
                  begin={`${off}s`}
                  repeatCount="indefinite"
                />
              </circle>
            ))
          : null}
        <circle cx={280} cy={252} r={52} fill="url(#hubcore)" filter="url(#glowL)" />
        <circle
          cx={280}
          cy={252}
          r={52}
          fill="none"
          stroke="rgba(255,255,255,0.4)"
          strokeWidth={1}
        />
        <text
          x={280}
          y={249}
          textAnchor="middle"
          fontFamily="var(--font-mono)"
          fontSize={17}
          fontWeight={700}
          fill="#080a11"
        >
          aipm
        </text>
        <text
          x={280}
          y={267}
          textAnchor="middle"
          fontFamily="var(--font-mono)"
          fontSize={8.5}
          fill="rgba(8,10,17,0.6)"
        >
          evaluates · drafts
        </text>

        {/* landing glow */}
        <circle cx={280} cy={356} r={5} fill="#45e09a" filter="url(#glowS)" opacity={0.9} />
      </svg>

      {/* the drafted suggestion, floats over the flow */}
      <div className="absolute top-[60%] left-1/2 w-[90%] max-w-[420px] -translate-x-1/2">
        <div className="mb-2 flex items-center gap-2 pl-1 font-mono text-[10px] tracking-widest text-faint uppercase">
          <span className="h-1.5 w-1.5 rounded-full bg-approved anim-breathe" /> drafted · ready for
          you
        </div>
        <div className="rounded-2xl border border-white/12 bg-[#0d111c]/85 p-4 shadow-[0_30px_70px_-28px_rgba(109,140,255,0.6)] backdrop-blur-xl">
          <div key={tick}>
            <div className="flex items-center gap-2.5">
              <span className="popin flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-accent to-violet text-[13px] font-bold text-bg uppercase">
                {item.to.charAt(0)}
              </span>
              <div className="risein leading-tight" style={{ animationDelay: "0.05s" }}>
                <div className="text-[13px] font-semibold text-ink">@{item.to}</div>
                <div className="font-mono text-[10px] text-faint">Slack dm</div>
              </div>
              <span
                className="risein ml-auto rounded bg-accent/12 px-1.5 py-0.5 font-mono text-[10px] text-accent"
                style={{ animationDelay: "0.1s" }}
              >
                re {item.ref}
              </span>
            </div>
            <div
              className="risein mt-3 min-h-[2.75rem] text-[13.5px] leading-relaxed text-ink/90"
              style={{ animationDelay: "0.15s" }}
            >
              {item.line}
            </div>
            <div className="risein mt-4 flex items-center gap-2" style={{ animationDelay: "0.2s" }}>
              {approved ? (
                <span className="popin flex items-center gap-1.5 text-[12px] font-semibold text-approved">
                  <IconCheck /> sent · one Slack dm
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setApproved(true)}
                    className="glow-approved flex items-center gap-1.5 rounded-md bg-approved/15 px-3 py-1.5 text-[12px] font-semibold text-approved transition-colors hover:bg-approved/25"
                  >
                    <IconCheck /> approve
                  </button>
                  <span className="rounded-md border border-white/12 px-3 py-1.5 text-[12px] text-muted">
                    snooze
                  </span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="mt-2.5 flex items-center gap-1.5 pl-1 font-mono text-[10px] text-faint">
          <span className="tracking-widest uppercase">next</span>
          {others.map((o) => (
            <span
              key={`${tick}-${o.ref}`}
              className="risein rounded bg-white/5 px-1.5 py-0.5 text-muted"
              style={{ animationDelay: "0.26s" }}
            >
              @{o.to} {o.ref}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default HeroScene;
