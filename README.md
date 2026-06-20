# Thread Assistant

An automatic, **suggest-only** work bot. It watches your work threads — GitHub
issues and PRs, Slack threads — figures out when someone owes an action or a
thread has gone stale, and **drafts** a targeted nudge to the right person's
Slack DM. It also keeps a per-thread _working-notes_ summary up to date. It
never acts on its own: it drafts, a human approves.

The problem it solves: the useful chores (nudging a stalled review, noticing a
PR with no reviewer, summarizing where a thread actually stands) are easy to
forget, and platform notifications are too noisy to be the signal. This bot makes
those chores happen on their own, and pushes a small number of high-value nudges
instead of a firehose.

## Principles

- **Suggest-only.** The bot owns and edits its own artifacts (its working-notes
  comment, its DMs). Anything touching human-authored content is a _proposal_
  approved with one reaction.
- **Low-noise.** One nudge per `(person, thread, signal)` per quiet period, then
  it falls back to a digest. Mute/snooze always wins.
- **Deterministic where it matters.** Detecting _that_ an action is owed is plain
  logic over the thread timeline. The LLM is used only for judgment and wording
  (did this reply actually answer the question? how should the nudge read?).
- **Shadow mode first.** Compute everything, post nothing, log what it _would_
  do. Review the log, then enable posting one capability at a time.

## Platforms

GitHub and Slack are **adapters** behind a common interface; the LLM provider is
an adapter too. Adding a platform means implementing the adapter, not touching
the engine.

## Stack

Cloudflare-native: Workers (webhook + Slack ingress) · Cron Triggers (staleness
sweeps) · Queues (bound + retry LLM work) · Durable Objects (serialize per-thread
updates, never double-nudge) · D1 (relational state) · KV (delivery-id dedupe) ·
Workers AI behind AI Gateway (caching + swappable provider). Deploy with Wrangler.

## Quickstart (skeleton)

```bash
# 1. Configure secrets (Wrangler)
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET

# 2. Create the GitHub App (issues/PRs RW, contents R, members R; org-wide install)
#    Subscribe to: issues, issue_comment, pull_request, pull_request_review,
#    pull_request_review_comment, pull_request_review_thread

# 3. Point both webhooks at the Worker, then run locally
wrangler dev          # replay captured payloads against it
wrangler deploy       # ship; starts in shadow mode (posts nothing)
```

See [`DESIGN.md`](./DESIGN.md) for the architecture.
