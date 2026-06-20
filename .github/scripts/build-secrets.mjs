// Build a wrangler `secret bulk` JSON from CI env, mapping GH_*-prefixed repo
// secrets to their Cloudflare names (GitHub Actions reserves the GITHUB_ prefix).
// Only non-empty values are included; values are never printed to the log.
import { writeFileSync } from "node:fs";

const map = {
  GITHUB_APP_PRIVATE_KEY: process.env.GH_APP_PRIVATE_KEY,
  GITHUB_APP_CLIENT_ID: process.env.GH_APP_CLIENT_ID,
  GITHUB_WEBHOOK_SECRET: process.env.GH_WEBHOOK_SECRET,
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
  SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
  IDENTITY_ROSTER: process.env.IDENTITY_ROSTER,
};

const out = Object.fromEntries(
  Object.entries(map).filter(([, v]) => v != null && v !== ""),
);
const keys = Object.keys(out);
if (keys.length === 0) {
  console.error("No secrets provided in repo settings; nothing to sync.");
  process.exit(1);
}

const target = process.argv[2];
if (!target) {
  console.error("usage: build-secrets.mjs <output.json>");
  process.exit(1);
}
writeFileSync(target, JSON.stringify(out));
console.error(`Prepared ${keys.length} secret(s): ${keys.join(", ")}`);
