# Managed Slack follow-up contract

Slack is deferred from the managed GitHub-first MVP. GitHub onboarding, shadow
previews, and working notes must operate with no Slack configuration.

Before managed Slack can be enabled, it must provide:

- workspace OAuth with a persisted mapping from an ai/pm workspace to a Slack
  team ID;
- encrypted, per-workspace bot credentials (never a deployment-global token);
- uninstall/revocation handling that immediately disables delivery and removes
  stored credentials;
- team-qualified user, channel, thread, event-dedupe, and cache identifiers;
- installation/team resolution before an event is accepted or enqueued; and
- workspace-scoped audit records for OAuth, ingress, attempted delivery, and
  sent/skipped/suppressed/failed outcomes.

The existing `/webhooks/slack` route and `SLACK_BOT_TOKEN` /
`SLACK_SIGNING_SECRET` settings are legacy self-host configuration only.
`MANAGED_MODE=true` disables that ingress with HTTP 410, and managed engine
contexts do not attach the global Slack token. Do not expose these settings in
the managed control plane.
