![Social preview](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/social-preview.png)

# dsh-context

[中文](README_zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-context)](https://www.npmjs.com/package/dsh-context)
[![GitHub stars](https://img.shields.io/github/stars/bowenliang123/dsh-context?style=social)](https://github.com/bowenliang123/dsh-context)
[![dshfind](https://dshfind.com/api/badge/bowenliang123/dsh-context)](https://dshfind.com/en/plugins/bowenliang123/dsh-context?ref=badge)

**The best [DeepSeek Harness plugin](https://www.deepseek.com/harness/) for Agent's context insights and management.**

> Recommended and starred by DeepSeek Harness staff [@tianyicui](https://github.com/tianyicui) and [@turtle1999](https://github.com/turtle1999) — see [this post on X](https://x.com/tianyi/status/2105256532657267119).

[`dsh-context`](https://www.npmjs.com/package/dsh-context) provides full context lifecycle management features.
- **Context Insights page** — the cross-session overview as a first-level sidebar panel (beside Plugins and Automation tasks): KPI band with a 7-day token/cost usage chart, activity heatmap, aggregate composition ring, and filterable session cards that jump straight into any session.
- **Context tab** — a UI context dashboard for DeepSeek Harness's context stats, composition, trend, events, messages, and commands.
- **Fleet tab** — the agent family's own page: the current agent, its parents, and every subagent as one live card each.
- **Context panel** — the same dashboard as a right-sidebar tab: pick **Context** on the sidebar's guide page and the panel opens beside the chat, agent network included.
- **`/context` command** — the slash command shows the context model for current context composition and recent context evolution.

## Install / Update

### Install on DeepSeek Harness web or desktop

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

Five surfaces, one story — what your agent is carrying, how it got there, and what it did with it:

| Where | What you get |
| --- | --- |
| **Context Insights page** | Every session at a glance: usage, cost, cache hit, daily activity, and per-session context profiles — filtered by range, day, group, or search, one click to jump in. |
| **Context tab** | The full dashboard: stats, composition, per-request trend, events, file activity, and command executions — in every session. |
| **Fleet tab** | The agent network: the current agent, its parents, and every subagent, live. |
| **`/context` command** | A centered modal with the same composition and context browser, without leaving the chat. |
| **Preferences card** | Per-user defaults: the panel entry, Insights range, trend and sort defaults, display currency, and the system prompt prefix/suffix joined around every session. |

## 🗂️ The Context Insights page

Click **Context Insights / 上下文洞察** in the sidebar's panel list — the same row level as **Plugins** and **Automation tasks** — and the page opens as a full center-column panel:

![The Context Insights page](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-dashboard.png)

| Section | The question it answers |
| --- | --- |
| **KPI band** | How much am I using — sessions active in the picked range (7d / 30d / all), with billed tokens, estimated cost, cache-hit rate and turns folded by the day each step started; tool runs and active time cover those sessions and their subagents' whole lifetime, matching the timing card. |
| **7-day usage chart** | When did I spend what — each of the last 7 days' billed tokens and estimated cost as a bar pair, folded per turn off the sessions' own request times (not the session's last-active day). |
| **Activity heatmap** | When do I actually work — the last 8 weeks of daily billed tokens; click a day to filter the sessions that were active on it. |
| **Settings entry** | One row under the heatmap — the same guarded jump to this plugin's preferences as the Context tab's Plugin Info card. |
| **Context Composition** | Where the picked range's billed tokens went, split by the Context tab's composition categories. |
| **Session cards** | Each session's profile: composition ring, billed tokens, turns, cost, and its workspace-group / project breadcrumb — sorted by recency, tokens, or context size, searchable, grouped by workspace. A card click opens the session. |


## 📊 The Context tab

Open any session and click the **Context / 上下文** tab:

![Context panel overview](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-overview.png)

| Card | The question it answers |
| --- | --- |
| **Context Stats** | Turns, steps, human inputs, live tool calls — plus a cost estimated from the models.dev list prices (hover the `?` for per-1M rates; only DeepSeek splits peak/off-peak: its listed rates are the off-peak tier, and peak windows bill at 2×). |
| **Token Stats** | Where the billed tokens went — the same total as the chat stats line under the composer, split by composition (system, tools, messages…) with the provider-exact output closing the ring, and the session's cache-hit rate in the corner. |
| **Timing Stats** | How active time split across model calls, tool runs, and overhead. |
| **Current Context** | What's in the window *right now*. |
| **Context Trend** | Every request's size — and its story. |
| **Context Browser** | What any request was *actually* assembled from. |
| **Context Events** | When and why the window changed. |
| **File Activity** | What the agent *did* to your files. |
| **Command Executions** | What the agent ran, how each run ended, and which programs it leaned on. |

The cost estimate follows one documented rule set: [How model pricing is mapped](docs/model-pricing-mapping.md).

The headline occupancy and composition read the **same official token-meter projections as the chat composer's context ring** (`contextPressure` / `contextBreakdown`), so the figures always match what the ring tells you — the card's percentage is that same occupancy, printed with one decimal.

The **Context Stats** card's Agent Network cell (the billed tokens and estimated cost of the whole family) jumps to the **Fleet** tab. Its Input / Output pills are jump links too: **Human Inputs** opens the **Context Browser** on your messages, and **Read / Written / Searched / Images** land on the **File Activity** card with that kind picked.

### Context Stats

#### Token Stats and Timing Stats
![Token_Stats_and_Timing_Stats](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/token-stats-and-timing-stats.png)

#### Context Stats
![Context_Stats](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-stats.png)


### 🧱 Current Context — what's in the context window now

![Current Context card](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/current-context.png)

A six-color stacked bar against the model's full window (the two hatched masks at the end = auto-compaction's reserve: its headroom, then the request's reserved output window): system prompt, tool schemas, user messages, injected context, assistant replies, tool results — each with its ≈token figure and share. When a conversation starts degrading, this is where you see *which part* is responsible.

### 📈 Context Trend — how the context grew and evolved by turn or steps

![Context Trend with the step brief](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-trend.png)

One stacked bar per model request — finer than per-message — so you watch the window grow turn by turn:

- **✨ Step brief** — three plain-language rows under the chart: **User** recalls the message that opened the turn, **In** lists what newly entered (usually the previous tool results), **Response** shows the reply and/or tools called. Click a row to open that exact message in the Context browser.
- **✂ marks the events** — compactions and prunes are pinned to the bar where they happened, so the drops explain themselves.
- **Read it your way** — **Step / Turn** granularity, **Total** (cumulative makeup) or **Delta** (each request's signed change), and sideways scrolling through the whole session. In Delta mode, growth piles up above the baseline and a compaction dives below it:

![Context Trend in Delta mode](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/history-delta.png)

- **Overview** — one toggle squashes the whole session (steps or turns) into the pane's width as a continuous stacked ribbon: every compaction drop and composition shift at a glance, no sideways scrolling, nothing extra to load. Flags mark the quartiles and the full span; hover to scrub, hover a band to light that category across the whole ribbon; click pins the step and opens that band's category in the browser (exclusive with DNA mode and Adaptive).
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

- **Attachments render as ordered cards** — a message's `image` and `file` blocks sit together in the order the message carries them, one card each: images with a thumbnail plus their dimensions, stored size, and the official DeepSeek image-token estimate; other files with their type glyph, extension, and stored size. One click opens the attachment in dsh's own preview column (markdown, code, PDF, office, and image viewers), under the file's real name:

![Image attachment cards with their dimensions, stored size, and token estimate](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-images.png)

- **Diff against the previous turn** — signed delta badges per category (`+N` items, `±Nk` tokens) tell you what a turn added or reclaimed at one glance. Steps older than a compaction are reconstructed from the removed-message archive — and the card says so when a step's makeup is only approximate.

- **DNA mode lays the whole context out flat** — the bar draws one band per item in the model's reading order, and below it the same items become one flat list with the newest message on top (the model reads oldest-first, so the list runs that order bottom-up): every row carries its prompt position (`#12`), category, introducing step, and token price, and expands into the same full content; the tool schemas and the system prompt close the list as two group rows. The card ends flush with the composition + trend cards beside it — a fully flattened session scrolls inside instead of flooding the page.

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

### 🖥️ Command Executions — what the agent ran

![Command Executions](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/command-executions.png)

Every shell and code run with its status, wall time, and step stamp, plus a session summary, attention shortcuts, and a program ranking. The ranking stays global while the search and status chips narrow the list; clicking a program drills into it and marks the row — the ranking never collapses under its own filter.

## 🚢 The Fleet tab

Open any session and click the **Fleet / 编队** tab (right of **Context**) — the agent family on a page of its own, with room for the collaboration surfaces that follow:

![The Fleet page for an eleven-agent team: summary, Agent Network, Fleet Members, and Tasks](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/fleet-overview.png)

A one-line summary opens the page — agents and their status, live context, estimated cost, and task progress — then hands the same family to four linked surfaces: **Agent Network**, **Fleet Members**, **Tasks**, and **Agent Comms**. Picking an agent on the graph or the member board narrows the tasks and channels to that agent, so the page answers for one member at a time.

### 🕸 Agent Network — the family portrait

The current agent, its parents, and every subagent — one card per agent: its title, live context size and window occupancy, a composition bar, and how long it has run for and how many steps it has taken. Edges fan out from each parent in the lineage's color — hover a card to light its whole chain and read the full breakdown in the detail strip; click to jump into that session's own Context tab. Running agents breathe with a green pulse on their incoming edge and turn over the harness's own rolling spinner beside their title, which settles into the same green dot the header's subagent list uses once the work is done; narrow panes fold the family into tidy rows — never a horizontal scrollbar.

### 👥 Fleet Members & Tasks — who is doing what

Each roster member's card carries its role (lead or teammate), model, latest reply, run time and steps, and active task count; the family's other agents sit below in the same card shape. A card's buttons open that agent's chat in the sidebar or the whole view, search and the status chips narrow both sections, and the sort menu orders the other agents by spawn order, tokens, duration, steps, or recency. The **Tasks** board puts team tasks and subagent delegations in the same place — owner groups, status filters, and blocked-by links that light the whole prerequisite chain when you focus a task. Click a task to open its full description in place, raw or rendered, and the board scrolls it to the front under a sticky owner header.

### 📡 Agent Comms — who said what to whom

The comms card reads the family's session logs automatically — no scan step. Team relays, mailbox deliveries, and the runtime's settlement notices merge into channels: each card pairs the lead or current agent with one counterpart, labels both sides, and shows how many messages each side sent. The timeline names both parties and their roles. Clicking any message opens the full record inline below it — the session log it came from and its sequence, a notice when the runtime wrote the settlement rather than the child, the complete closing report (with its structured result or diagnostic), and participant cards that open that agent's chat in the sidebar or the whole view. Filter by message kind or text, flip the order, and the shared agent pick from the graph or member board narrows the whole hub; older history and clipped excerpts are disclosed instead of silently truncated.

![Agent Comms with a settlement record expanded inline](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/fleet-comms.png)

The right Sidebar's **Context** panel keeps the same card inline, so the family stays one click away while you read the chat. Don't want the tab at all? Turn **Fleet tab** off in the preferences card — the card then lives on in that panel, and the Context tab's family cell opens it there whenever a Sidebar is served.

## ⌨️ `/context` command

Type `/context` (or pick it from the `/` menu) and press Enter:

![Slash menu with the context command](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command-entry.png)

A centered dialog opens with the **Current Composition** card and the **Context browser** — the same composition bar, per-step picker, and `vs previous turn` diff badges as the tab:

![The /context modal](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command.png)

## ⚙️ Settings

The **Context** preferences card holds this plugin's per-user settings — the **Context panel entry** (the **Context** conversation tab, the right Sidebar panel, both, or Hide for neither — the reply-row jump goes with it), the **Fleet** tab's own Show/Hide switch (the panel entry never gates it), the **Context Insights** default range (Today / Last 7 days / Last 30 days / All, Last 30 days unless changed; picking a preset on the page writes it back), the display currency (follow the UI language, CNY, or USD), trend granularity (Step/Turn), trend mode (Total/Delta), the trend duration curve (shown by default), the trend auto-overview step threshold, the Context Browser diff baseline, tool and File Activity sort, and the Context Insights Show/Hide switch. It lives on the **Plugins** page: the sidebar **Plugins** entry → the **dsh-context** bundle's page → its **Configuration** section (the card is served by the entry's live Config form).

The **System Prompt · Prefix / Suffix** rows hold free text joined at the very start / end of every session's system prompt, for all agents (subagents included) — a per-deployment persona or behavioral rule that rides the harness's own prompt assembly. Edits apply from the next turn; leave a row empty to disable it.

The Context Insights preset buttons write the pick back as the stored default; every other in-chart and in-card toggle stays per-view and never overwrites the stored preference.

![The Context settings card](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/settings.png)

## Good to know

- **Estimates vs actuals** — category figures use dsh's own fixed-density heuristic (the same one as its built-in token meter); the pinned trend details show provider-reported actuals next to them, and the Token card pairs its ≈-estimated composition shares with the provider-exact billed total.
- **Compatibility** — works on `@deepseek-ai/dsh` from **0.2.0-rc.2** (the `0.2.0` and `0.2.1` lines; verified on their rc.2 releases), the V4 session-log generation, from one shape-driven code path. The per-release matrix and how it is verified: [docs/compatibility.md](docs/compatibility.md).
- **I18n** — UI in English and 简体中文.

## Like it?

If `dsh-context` helped you understand what your agent is carrying around, a ⭐ on [GitHub](https://github.com/bowenliang123/dsh-context) is much appreciated — and issues/PRs are welcome!

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
