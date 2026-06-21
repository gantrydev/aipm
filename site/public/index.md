# aipm

**It drafts the nudge. You approve with one reaction.**

A suggest-only work bot. It watches GitHub issues and PRs and Slack threads, figures out when someone owes an action or a thread has gone stale, and drafts a targeted nudge to the right person's Slack DM. It also keeps a per-thread working-notes summary current. The machine never acts alone: it drafts, a human approves.

`workers · cron · queues · d1` · v0.1

## Principles

- **suggest-only** — It drafts the nudge and edits its own notes; touching a human's thread waits for your one reaction.
- **low-noise** — One nudge per person, thread, and signal. Then a digest. Mute and snooze always win.
- **deterministic** — Plain logic over the timeline decides what's owed; the model only judges if a reply answered and words the nudge.
- **shadow-first** — Computes every nudge, posts nothing, logs what it would do. Flip on one capability at a time.

## Engine

Platform-neutral. GitHub and Slack are adapters behind a common interface; the LLM provider is an adapter too. Adding a platform means implementing the adapter, not touching the engine.

```
Ingest → Evaluate → Synthesize → Route → Aggregate
```

Stages are decoupled by Queues so LLM work is bounded and retryable. A Durable Object per cluster (or per thread) serializes updates so concurrent events can't double-nudge. Evaluate is deterministic; the LLM is used only for working-notes summaries, judging whether a reply answered the question, and nudge wording.

## Quickstart

Configure secrets (Wrangler):

```bash
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put SLACK_BOT_TOKEN
wrangler secret put SLACK_SIGNING_SECRET
```

Create the GitHub App — issues/PRs RW, contents R, members R; org-wide install. Subscribe to `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `pull_request_review_thread`.

Point both webhooks at the Worker, then run locally and ship:

```bash
wrangler dev      # replay captured webhook + Slack payloads
wrangler deploy   # starts in shadow mode — posts nothing
```

> Nothing posts without a human. Until you turn shadow off, every nudge is a line in a log, not a message anyone got.

## Signals

All thresholds are configuration. The quiet period is a business-day-aware duration (deployment sets timezone + working days).

| Signal                      | Trigger         | Target                 | Quiet          | Channel                 |
| --------------------------- | --------------- | ---------------------- | -------------- | ----------------------- |
| @mentioned, no response     | webhook         | mentioned person       | 1 business day | DM (high pri) / digest  |
| review requested            | webhook         | reviewer               | 1 business day | DM                      |
| unaddressed review comments | webhook         | PR author              | 1 business day | DM                      |
| PR open, no reviewer        | webhook + sweep | author                 | 4h             | DM                      |
| draft PR aged               | sweep           | author                 | > 7 days       | digest                  |
| in-progress stale           | sweep           | owner/assignee         | > N days       | digest (DM if high pri) |
| blocker cleared             | webhook         | blocked thread's owner | immediate      | DM                      |

When a thread reaches a terminal state (closed/merged/done), all its signals clear. One nudge per dedupe key per quiet period; after N escalations a signal drops to digest-only. Authors whose login ends in `[bot]` are never nudge targets.

## Links

- Source: https://github.com/gantrydev/aipm
- Design: https://github.com/gantrydev/aipm/blob/main/DESIGN.md
- Readme: https://github.com/gantrydev/aipm/blob/main/README.md
- Full reference for agents: https://aipm.dev/llms-full.txt
- Maker: https://gantrydev.com
