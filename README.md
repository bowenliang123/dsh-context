![Social preview](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/social-preview.png)

# dsh-context

[![npm version](https://img.shields.io/npm/v/dsh-context)](https://www.npmjs.com/package/dsh-context)
[![GitHub stars](https://img.shields.io/github/stars/bowenliang123/dsh-context?style=social)](https://github.com/bowenliang123/dsh-context)
[![dshfind](https://dshfind.com/api/badge/bowenliang123/dsh-context)](https://dshfind.com/en/plugins/bowenliang123/dsh-context?ref=badge)

**The best [DeepSeek Harness plugin](https://www.deepseek.com/harness/) for Agent's context insights and management.**

> Recommended and starred by DeepSeek Harness staff [@tianyicui](https://github.com/tianyicui) and [@turtle1999](https://github.com/turtle1999) — see [this post on X](https://x.com/tianyi/status/2105256532657267119).

[`dsh-context`](https://www.npmjs.com/package/dsh-context) provides full context lifecycle management features.
- **Context Insights page** — the cross-session overview as a first-level sidebar panel (beside Plugins and Automation tasks): KPI band with a 7-day token/cost usage chart, activity heatmap, aggregate composition ring, and filterable session cards that jump straight into any session.
- **Context tab** — an UI context dashboard for DeepSeek Harness's context stats, composition, trend, events, and messages.
- **Context panel** — the same dashboard as a right-sidebar tab: pick **Context** on the sidebar's guide page and the panel opens beside the chat.
- **`/context` command** — the slash command shows the context model for current context composition and recent context evolution.

## Install / Update

### Install on DeekSeek Harness web or desktop

Fill `dsh-context` in the **Add plugin** wizard's search box, and click **Install**:

![Add_plugin_wizard](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/add-plugin-wizard.png)

### Install with `dsh` cli

Install [`dsh-context`](https://www.npmjs.com/package/dsh-context) plugin from [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh):

```sh
dsh plugin --profile web add dsh-context
```

Or update the `dsh-context` plugin:

```sh
dsh plugin --profile web update dsh-context@latest
```

Then start the web UI with `dsh web`. No build step, no restart.

## Use it

Four surfaces, one story — what your agent is carrying, how it got there, and what it did with it:

| Where | What you get |
| --- | --- |
| **Context Insights page** | Every session at a glance: usage, cost, cache hit, daily activity, and per-session context profiles — filtered by range, day, group, or search, one click to jump in. |
| **Context tab** | The full dashboard: stats, composition, per-request trend, events, file activity, and the agent network — in every session. |
| **`/context` command** | A centered modal with the same composition and context browser, without leaving the chat. |
| **Preferences card** | Per-user defaults: view placement, trend granularity & mode, File Activity sort, and more. |

## 🗂️ The Context Insights page

Click **Context Insights / 上下文洞察** in the sidebar's panel list — the same row level as **Plugins** and **Automation tasks** — and the page opens as a full center-column panel:

![The Context Insights page](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-dashboard.png)

| Section | The question it answers |
| --- | --- |
| **KPI band** | How much am I using — sessions, billed tokens, estimated cost, and cache-hit rate over the picked range (7d / 30d / all). |
| **7-day usage chart** | When did I spend what — each of the last 7 days' billed tokens and estimated cost as a bar pair, folded per turn off the sessions' own request times (not the session's last-active day). |
| **Activity heatmap** | When do I actually work — the last 8 weeks of daily billed tokens; click a day to filter the sessions that were active on it. |
| **Settings entry** | One row under the heatmap — the same guarded jump to this plugin's preferences as the Context tab's Plugin Info card. |
| **Context Composition** | Where the context windows went, summed over the range's sessions. |
| **Session cards** | Each session's profile: composition ring, billed tokens, turns, cost, and its workspace-group / project breadcrumb — sorted by recency, tokens, or context size, searchable, grouped by workspace. A card click opens the session. |


## 📊 The Context tab

Open any session and click the **Context / 上下文** tab:

![Context panel overview](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-overview.png)

| Card | The question it answers |
| --- | --- |
| **Context Stats** | Turns, steps, human inputs, live tool calls — plus a cost estimated from the models.dev list prices (hover the `?` for per-1M rates; DeepSeek peak/off-peak aware). |
| **Token Stats** | Where the billed tokens went — the same total as the chat stats line under the composer, split by composition (system, tools, messages…) with the provider-exact output closing the ring, and the session's cache-hit rate in the corner. |
| **Timing Stats** | How active time split across model calls, tool runs, and overhead. |
| **Current Context** | What's in the window *right now*. |
| **Context Trend** | Every request's size — and its story. |
| **Context Browser** | What any request was *actually* assembled from. |
| **Context Events** | When and why the window changed. |
| **File Activity** | What the agent *did* to your files. |
| **Agent Network** | The whole agent family, live. |

The headline occupancy and composition read the **same official token-meter projections as the chat composer's context ring** (`contextPressure` / `contextBreakdown`), so the figures always match what the ring tells you — the card's percentage is that same occupancy, printed with one decimal.

### Context Stats

#### Token Stats and Timing Stats
![Token_Stats_and_Timing_Stats](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/token-stats-and-timing-stats.png)

#### Context Stats
![Context_Stats](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-stats.png)


### 🧱 Current Context — what's in the context window now

![Current Context card](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/current-context.png)

A six-color stacked bar against the model's full window (hatching = free headroom): system prompt, tool schemas, user messages, injected context, assistant replies, tool results — each with its ≈token figure and share. When a conversation starts degrading, this is where you see *which part* is responsible.

### 📈 Context Trend — how the context grew and evolved by turn or steps

![Context Trend with the step brief](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-trend.png)

One stacked bar per model request — finer than per-message — so you watch the window grow turn by turn:

- **✨ Step brief** — three plain-language rows under the chart: **User** recalls the message that opened the turn, **In** lists what newly entered (usually the previous tool results), **Response** shows the reply and/or tools called. Click a row to open that exact message in the Context browser.
- **✂ marks the events** — compactions and prunes are pinned to the bar where they happened, so the drops explain themselves.
- **Read it your way** — **Step / Turn** granularity, **Total** (cumulative makeup) or **Delta** (each request's signed change), and sideways scrolling through the whole session. In Delta mode, growth piles up above the baseline and a compaction dives below it:

![Context Trend in Delta mode](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/history-delta.png)

- **Hover & pin** — scrub for an instant tooltip; click to pin the full breakdown, with provider-reported **Actual Prompt / Output / Cache** next to the estimates.
- **Live linkage** — hovering a bar previews that step's assembled context in the Context browser beside the chart; leaving the chart returns to your own pick.

### 🧭 Context Browser — open the box of any request

Pick **Live (next request)** or any retained step, and browse what that request was assembled from: seven collapsible categories expand into one row per element with its token price, and every element expands again into its **actual content** — the system prompt, each tool's JSON schema, message text, reasoning, tool arguments, and tool outputs. Skill content (the available-skills catalog, `/skill` invocations, and `skill`-tool loads) has its own **Skill Injections** category, so a stealthy skill's context footprint can't hide inside the injected-context and tool-result buckets.

- **Who provides each tool** — every tool-schema row carries a best-effort source chip: `tool-*` first-party packages, `dsh-*` capability packages, `mcp:<server>` proxies, or the exact plugin watched live from `tools.register()`. Sort by **size / name**, and filter every category by its own searchable fields:

![Tool schemas with source chips, filter, and sort](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tools.png)

- **Filter assistant replies by kind** — the assistant category's search box carries **Thinking / Tools / Answer** chips, each with the shown step's message count (one reply can carry several); click one to keep only the matching replies, click again to clear:

![Assistant replies with kind filter chips](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-assistant-kinds.png)

- **Tool results open into the full call** — the tool name and arguments with its **OK/error** status, the result body with line count and a **Raw / Markdown** toggle:

![A tool result expanded with Raw/Markdown toggle](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tool-result.png)

- **Image payloads render as cards** — thumbnails with name, dimensions, stored size, and the official DeepSeek image-token estimate (the dsh multimodal pipeline, e.g. `read_image` results and image attachments):

![An image payload rendered as a thumbnail card](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-images.png)

- **Diff against the previous turn** — signed delta badges per category (`+N` items, `±Nk` tokens) tell you what a turn added or reclaimed at one glance. Steps older than a compaction are reconstructed from the removed-message archive — and the card says so when a step's makeup is only approximate.

### ⚡ Context Events — when and why the window changed

![Context Events with a compaction](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-events.png)

Every injection, compaction, prune, model switch, and plan-mode toggle — labeled with its producer (instruction file, plugin id, skill name), its net token delta (compactions show what they reclaimed), turn/step, and time. The **Inject / Compact / Prune / Switch / Mode** chips filter the log by kind, each carrying its whole-session event tally.

### 📁 File Activity — what the agent did to your files

![File Activity](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/file-activity.png)

One row per touched file — read, written, or searched — aggregated up to whichever step you pick on the trend chart:

- **Per-purpose counts** with header chips doubling as filters (**Read / Written / Searched / Images**) and a path search box.
- **Line deltas** — every `edit`/`write` contributes its estimated `+added / −removed` footprint, per file and summed.
- **Every mode counts** — native tools, the Minimal preset's `str_replace_editor`, and the nested calls inside PTC `run_code` programs are all folded into per-tool rows.
- **Searches land on real files** — matched files get their own ops rows with hit counts.
- **Click a row** to expand its full operation log — every op jumps straight to the exact tool result in the Context browser.
- **Click a file name** to open its preview in the right Sidebar, exactly as the built-in Files sidebar does — the same viewer, the same tab-per-file behavior. On a harness without that column the name opens on your system as before.

### 🕸 Agent Network — the family portrait

![Agent Network with seven subagents](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/agent-network.png)

The current agent, its parents, and every subagent — one card per agent: its title, live context size and window occupancy, a composition bar, and how long it has run for and how many steps it has taken. Edges fan out from each parent in the lineage's color — hover a card to light its whole chain and read the full breakdown in the detail strip; click to jump into that session's own Context tab. Running agents breathe with a green pulse on their incoming edge and turn over the harness's own rolling spinner beside their title, which settles into the same green dot the header's subagent list uses once the work is done; narrow panes fold the family into tidy rows — never a horizontal scrollbar.

## ⌨️ `/context` command

Type `/context` (or pick it from the `/` menu) and press Enter:

![Slash menu with the context command](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command-entry.png)

A centered dialog opens with the **Current Composition** card and the **Context browser** — the same composition bar, per-step picker, and `vs previous turn` diff badges as the tab:

![The /context modal](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command.png)

## ⚙️ Settings

The **Context** preferences card holds this plugin's per-user settings — default placement, trend granularity (Step/Turn), trend mode (Total/Delta), the trend duration curve (shown by default), tool and File Activity sort, and the sidebar insights entry. It lives on the **Plugins** page: the sidebar **Plugins** entry → the **dsh-context** bundle's page → its **Configuration** section (the card is served by the entry's live Config form).

In-chart and in-card toggles stay per-view and never overwrite the stored preference.

![The Context settings card](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/settings.png)

## Good to know

- **Estimates vs actuals** — category figures use dsh's own fixed-density heuristic (the same one as its built-in token meter); the pinned trend details show provider-reported actuals next to them, and the Token card pairs its ≈-estimated composition shares with the provider-exact billed total.
- **Compatibility** — works on `@deepseek-ai/dsh` **0.1.7-rc.2+** (the `0.1.7` line from rc.2 and the `0.2.0` line from rc.2), the V4 session-log generation, from one shape-driven code path. The per-release matrix and how it is verified: [docs/compatibility.md](docs/compatibility.md).
- **I18n** — UI in English and 简体中文.

## Like it?

If `dsh-context` helped you understand what your agent is carrying around, a ⭐ on [GitHub](https://github.com/bowenliang123/dsh-context) is much appreciated — and issues/PRs are welcome!

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
