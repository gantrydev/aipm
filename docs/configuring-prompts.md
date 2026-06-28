# Configuring the summary prompts

aipm uses an LLM for two summaries:

- **Working notes** — the per-thread summary posted as a sticky comment on each
  GitHub issue/PR.
- **Cluster summary** — the cross-thread rollup over a GitHub issue/PR plus any
  linked Slack threads.

The instruction text ("the words") for each is configurable. Everything else —
which comments are included, truncation limits, bot/own-comment exclusion, and
output sanitization — stays in code and is **not** overridable.

## What you control

The configured text is sent as the model's **system** prompt. The thread data
(title, state, description, discussion) is assembled by the engine and sent as a
separate **user** message. So your prompt decides voice, structure, and which
sections to emit — it never sees or alters how the (untrusted) thread content is
gathered or bounded.

| Variable         | Drives                       | Default constant         | Defined in                      |
| ---------------- | ---------------------------- | ------------------------ | ------------------------------- |
| `NOTES_PROMPT`   | per-thread working notes     | `DEFAULT_NOTES_PROMPT`   | `packages/core/src/notes.ts`    |
| `CLUSTER_PROMPT` | cross-thread cluster summary | `DEFAULT_CLUSTER_PROMPT` | `packages/core/src/clusters.ts` |

There is one global value for each (not per-repo or per-team).

Unset or blank → the built-in default is used, which is the original prompt
verbatim. An unset secret behaves exactly like before this feature existed.

## How to set it

The prompts are Cloudflare secrets. Set them with Wrangler from `apps/worker`:

```bash
cd apps/worker

# multi-line text is easiest from a file:
wrangler secret put NOTES_PROMPT < notes-prompt.txt
wrangler secret put CLUSTER_PROMPT < cluster-prompt.txt

# or paste interactively:
wrangler secret put NOTES_PROMPT
```

You can also edit them in the Cloudflare dashboard:
**Workers & Pages → the worker → Settings → Variables and Secrets**.

A secret change takes effect on the **next event** — no redeploy. Editing a
prompt changes the working-notes content hash, so existing notes re-render with
the new prompt the next time their thread sees activity (it also busts the AI
Gateway cache for that summary).

## Writing a prompt

Look at the default (`DEFAULT_NOTES_PROMPT` / `DEFAULT_CLUSTER_PROMPT`) as the
starting point. A good prompt:

- asks for concise, factual GitHub markdown (it is posted directly into a
  comment),
- names the exact section headers you want (the engine posts whatever the model
  returns under the working-notes header),
- tells the model to treat the user message as data, not instructions,
- says what to ignore (test/webhook/deploy chatter) and to be honest when a
  thread is ambiguous.

A blank or whitespace-only value is treated as unset and falls back to the
default — you cannot deploy an empty prompt.
