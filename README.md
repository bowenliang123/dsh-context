![Social preview](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/social-preview.png)

# dsh-context

[![npm version](https://img.shields.io/npm/v/dsh-context)](https://www.npmjs.com/package/dsh-context)
[![GitHub stars](https://img.shields.io/github/stars/bowenliang123/dsh-context?style=social)](https://github.com/bowenliang123/dsh-context)
[![dshfind](https://dshfind.com/api/badge/bowenliang123/dsh-context)](https://dshfind.com/en/plugins/bowenliang123/dsh-context?ref=badge)

**The best [DeepSeek Harness plugin](https://www.deepseek.com/harness/) for Agent's context insights and management.**

`dsh-context` provides full context lifecycle management features.
- **Context tab** — an UI context dashboard for DeepSeek Harness's context stats, composition, trend, events, and messages.
- **`/context` command** — the slash command shows the context model for current context composition and recent context evolution.

## Install / Update

To Install from any DeepSeek Harness installation:

```sh
dsh plugin --profile web add dsh-context
```

Or to update the `dsh-context` plugin:

```sh
dsh plugin --profile web update dsh-context@latest
```

Then start the web UI with `dsh web`. No build step, no restart.

## Use it

Three surfaces, one story — what your agent is carrying, how it got there, and what it did with it:

| Where | What you get |
| --- | --- |
| **Context tab** | The full dashboard: stats, composition, per-request trend, events, file activity, and the agent network — in every session. |
| **`/context` command** | A centered modal with the same composition and context browser, without leaving the chat. |
| **Settings → Plugin configuration** | Per-user defaults: trend granularity & mode, File Activity sort. |

## 📊 The Context tab

Open any session and click the **Context / 上下文** tab:

![Context panel overview](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-overview.png)

| Card | The question it answers |
| --- | --- |
| **Context Stats** | Turns, steps, live tool calls & images, context-event tallies — plus a list-price cost estimate (hover the `?` for per-1M rates). |
| **Token Stats** | Where the billed tokens went: cache read/write, uncached input, output — around the cache-hit ring. |
| **Timing Stats** | How active time split across model calls, tool runs, and overhead. |
| **Current Context** | What's in the window *right now*. |
| **Context Trend** | Every request's size — and its story. |
| **Context Browser** | What any request was *actually* assembled from. |
| **Context Events** | When and why the window changed. |
| **File Activity** | What the agent *did* to your files. |
| **Agent Network** | The whole agent family, live. |

The headline occupancy and composition read the **same official token-meter projections as the chat composer's context ring** (`contextPressure` / `contextBreakdown`), so the figures always match what the ring tells you.

### 🧱 Current Context — who ate the budget

![Current Context card](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/current-context.png)

A six-color stacked bar against the model's full window (hatching = free headroom): system prompt, tool schemas, user messages, injected context, assistant replies, tool results — each with its ≈token figure and share. When a conversation starts degrading, this is where you see *which part* is responsible.

### 📈 Context Trend — every request, sized and explained

![Context Trend with the step brief](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-trend.png)

One stacked bar per model request — finer than per-message — so you watch the window grow turn by turn:

- **✨ Step brief** — three plain-language rows under the chart: **User** recalls the message that opened the turn, **In** lists what newly entered (usually the previous tool results), **Response** shows the reply and/or tools called. Click a row to open that exact message in the Context browser.
- **✂ marks the events** — compactions and prunes are pinned to the bar where they happened, so the drops explain themselves.
- **Read it your way** — **Step / Turn** granularity, **Total** (cumulative makeup) or **Delta** (each request's signed change), and sideways scrolling through the whole session. In Delta mode, growth piles up above the baseline and a compaction dives below it:

![Context Trend in Delta mode](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/history-delta.png)

- **Hover & pin** — scrub for an instant tooltip; click to pin the full breakdown, with provider-reported **Actual Prompt / Output / Cache** next to the estimates.
- **Live linkage** — hovering a bar previews that step's assembled context in the Context browser beside the chart; leaving the chart returns to your own pick.

### 🧭 Context Browser — open the box of any request

Pick **Live (next request)** or any retained step, and browse what that request was assembled from: six collapsible categories expand into one row per element with its token price, and every element expands again into its **actual content** — the system prompt, each tool's JSON schema, message text, reasoning, tool arguments, and tool outputs.

- **Who provides each tool** — every tool-schema row carries a best-effort source chip: `tool-*` first-party packages, `dsh-*` capability packages, `mcp:<server>` proxies, or the exact plugin watched live from `tools.register()`. Sort by **size / name**, and filter every category by its own searchable fields:

![Tool schemas with source chips, filter, and sort](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tools.png)

- **Tool results open into the full call** — the tool name and arguments with its **OK/error** status, the result body with line count and a **Raw / Markdown** toggle:

![A tool result expanded with Raw/Markdown toggle](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tool-result.png)

- **Image payloads render as cards** — thumbnails with name, dimensions, stored size, and the official DeepSeek image-token estimate (dsh 0.1.1+ multimodal pipeline, e.g. `read_image` results and image attachments):

![An image payload rendered as a thumbnail card](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-images.png)

- **Diff against the previous turn** — signed delta badges per category (`+N` items, `±Nk` tokens) tell you what a turn added or reclaimed at one glance. Steps older than a compaction are reconstructed from the removed-message archive — and the card says so when a step's makeup is only approximate.

### ⚡ Context Events — when and why the window changed

![Context Events with a compaction](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-events.png)

Every injection, compaction, prune, model switch, and plan-mode toggle — labeled with its producer (instruction file, plugin id, skill name), its net token delta (compactions show what they reclaimed), turn/step, and time. The **Inject / Compact / Prune / Switch / Mode** chips filter the log by kind.

### 📁 File Activity — what the agent did to your files

![File Activity](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/file-activity.png)

One row per touched file — read, written, or searched — aggregated up to whichever step you pick on the trend chart:

- **Per-purpose counts** with header chips doubling as filters (**Read / Written / Searched / Images**) and a path search box.
- **Line deltas** — every `edit`/`write` contributes its estimated `+added / −removed` footprint, per file and summed.
- **Every mode counts** — native tools, the Minimal preset's `str_replace_editor`, and the nested calls inside PTC `run_code` programs are all folded into per-tool rows.
- **Searches land on real files** — matched files get their own ops rows with hit counts.
- **Click a row** to expand its full operation log — every op jumps straight to the exact tool result in the Context browser.

### 🕸 Agent Network — the family portrait

![Agent Network with two subagents](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/agent-network.png)

The current agent, its parents, and every subagent — one node per agent, colored edges for the lineage, multi-level delegation on one map. Each ring is that session's composition scaled to its window occupancy; hover for tokens, requests, billing, and active time; click to jump into that session's own Context tab. Running agents breathe with a green pulse.

## ⌨️ `/context` command

Type `/context` (or pick it from the `/` menu) and press Enter:

![Slash menu with the context command](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command-entry.png)

A centered dialog opens with the **Current Composition** card and the **Context browser** — the same composition bar, per-step picker, and `vs previous turn` diff badges as the tab:

![The /context modal](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command.png)

## ⚙️ Settings

In **Settings → Plugins → Plugin configuration**, the **Context** card holds this plugin's per-user preferences — default trend granularity (Step/Turn), default trend mode (Total/Delta), and the File Activity default sort. In-chart and in-card toggles stay per-view and never overwrite the stored preference.

![The Context settings card](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/settings.png)

## Good to know

- **Estimates vs actuals** — category figures use dsh's own fixed-density heuristic (the same one as its built-in token meter); the pinned trend details and Token/Timing rings show provider-reported actuals next to them.
- **Compatibility** — works on `@deepseek-ai/dsh` **0.1.0-rc7+**, **0.1.1-rc2+**, and **0.1.2-alpha1+**; multimodal rendering requires 0.1.1+.
- **I18n** — UI in English and 简体中文.

## Like it?

If `dsh-context` helped you understand what your agent is carrying around, a ⭐ on [GitHub](https://github.com/bowenliang123/dsh-context) is much appreciated — and issues/PRs are welcome!

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
