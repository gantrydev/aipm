import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const SITE_URL = "https://thepm.dev";

const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "anthropic-ai",
  "Claude-Web",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "Amazonbot",
  "Bytespider",
  "Meta-ExternalAgent",
];

const robots = (): MetadataRoute.Robots => {
  const aiRules = AI_CRAWLERS.map((userAgent) => ({ userAgent: userAgent, allow: "/" }));
  return {
    rules: [{ userAgent: "*", allow: "/" }, ...aiRules],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
};

export default robots;
