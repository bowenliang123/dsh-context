# dsh-context

[![npm version](https://img.shields.io/npm/v/dsh-context)](https://www.npmjs.com/package/dsh-context)
[![GitHub stars](https://img.shields.io/github/stars/bowenliang123/dsh-context?style=social)](https://github.com/bowenliang123/dsh-context)
[![license](https://img.shields.io/npm/l/dsh-context)](https://github.com/bowenliang123/dsh-context/blob/main/LICENSE)

**See what your agent's context window is actually made of.**

dsh-context is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) that adds a **Context** panel to the web UI: a live, visual answer to *"what is the model carrying right now, and how did it get there?"* — context composition, per-request history, compactions, and injections, all in one place.

![Context panel overview](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-overview.png)

## Install

One command, from any DeepSeek Harness installation:

```sh
dsh plugin --profile web add dsh-context
```

Then start the web UI with `dsh web`, open any session, and click the **上下文 / Context** tab. No build step, no restart.

## What you'll see

### 📊 Context stats — the session at a glance

Turns, steps, how much context has been recycled by compactions and prunes, how many injections happened, model switches, and the estimated total tokens sent — next to the provider-reported actuals, so you can see how the estimate holds up.

### 🧱 Current composition — what's in the window right now

A six-color stacked bar scaled against the model's full context window (the gray track is your remaining headroom): system prompt, tool schemas, your messages, injected context, assistant replies, and tool results — plus the top-5 most expensive tool schemas. When a conversation starts degrading, this is where you find out *which part ate the budget*.

### 📈 History — watch the window grow (and get compacted)

One stacked bar per model request, finer than per-message. Toggle between **Turn** and **Step** granularity, scroll sideways through the session, hover any bar for a quick tooltip, and click to pin the full breakdown — including provider-reported actual prompt/output tokens next to the estimate. **✂ marks where compaction or pruning happened** — watch the bars drop:

![History chart with a pinned request](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/history-detail.png)

Above: a real session that grew to ~563k tokens across 48 turns, then compaction (✂) recycled −535.5k in one step, and the conversation continued from a fresh, small window.

### ⚡ Context events — when and why the window changed

Every compaction, tool-output prune, skill or plugin context injection, and model switch — each with its token delta, turn/step attribution, and timestamp:

![Context events and messages](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-events.png)

### 💬 Messages — the currently model-visible surface

The exact message list the model sees right now, newest first, with a per-message token cost.

## Good to know

- **Live**: refreshes every 2 seconds while the tab is open, and works for historical, persisted sessions too.
- **Bilingual**: 中文 / English, following the dsh locale automatically.
- **Honest numbers**: estimates use the same fixed-density heuristic as dsh's built-in tokenMeter (~4 chars ≈ 1 token), so they match the harness's own stats; wherever the provider reported real usage, it's shown alongside as "actual".

## Development

```sh
pnpm install   # then: pnpm run typecheck / pnpm run build / pnpm test
```

To hack on it from this checkout: `dsh plugin --profile <name> add .`

## Like it?

If dsh-context helped you understand what your agent is carrying around, a ⭐ on [GitHub](https://github.com/bowenliang123/dsh-context) is much appreciated — and issues/PRs are welcome!

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
