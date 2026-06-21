"use client";

import { useEffect, useState } from "react";

const WORDS = [
  { label: "GitHub", fg: "#aab9ff" },
  { label: "Slack", fg: "#f08fb4" },
] as const;

const SWAP_MS = 2200;

const SwapWord = () => {
  const [index, setIndex] = useState(0);
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (query.matches) return;
    setAnimated(true);
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % WORDS.length);
    }, SWAP_MS);
    return () => window.clearInterval(id);
  }, []);

  const word = WORDS[index];
  if (!word) return null;

  if (!animated) {
    return (
      <span className="font-semibold" style={{ color: word.fg }}>
        GitHub and Slack
      </span>
    );
  }

  return (
    <span className="align-baseline">
      <span className="sr-only">GitHub and Slack</span>
      <span aria-hidden="true" className="relative inline-grid font-semibold">
        {WORDS.map((it, i) => (
          <span
            key={it.label}
            style={{ color: it.fg }}
            className={`col-start-1 row-start-1 text-center ${i === index ? "swapin" : "pointer-events-none opacity-0 transition-opacity duration-300"}`}
          >
            {it.label}
          </span>
        ))}
      </span>
    </span>
  );
};

export default SwapWord;
