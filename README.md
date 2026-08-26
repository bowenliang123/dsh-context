![Social preview](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/social-preview.png)

# dsh-context

[![npm version](https://img.shields.io/npm/v/dsh-context)](https://www.npmjs.com/package/dsh-context)
[![GitHub stars](https://img.shields.io/github/stars/bowenliang123/dsh-context?style=social)](https://github.com/bowenliang123/dsh-context)
[![dshfind](https://dshfind.com/api/badge/bowenliang123/dsh-context)](https://dshfind.com/en/plugins/bowenliang123/dsh-context?ref=badge)

**The best [DeepSeek Harness plugin](https://www.deepseek.com/harness/) for Agent's context insights and management.**

`dsh-context` provides full context lifecycle management features.
- **Context tab** — an UI context dashboard for DeepSeek Harness’s context stats, composition, trend, events, and messages.
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

### Context tab

Open any session and click the **Context / 上下文** tab:

![Context panel overview](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-overview.png)

### ⌨️ `/context` command — In-session Context Insight modal

Type `/context` (or pick it from the `/` menu) and press Enter: a centered dialog shows the **Current Composition** card and the **Context browser** — the same composition bar, legend, and per-step browsing as the tab, so you can inspect what any request was assembled from without leaving the chat.

![Context command_entry](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command-entry.png)

![Context command](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-command.png)

### ⚙️ Settings — per-user preferences

In **Settings → Plugins → Plugin configuration**, the **Context / 上下文** card holds this plugin's per-user preferences — the **default trend granularity** (Step/Turn) and the **default trend mode** (Total/Delta) the Context tab opens with. In-chart toggling stays per-view and never overwrites the stored preference. The card appears only when the Host half is installed and the settings document is writable (a remote browser keeps settings process-local and shows no card).

## What you'll see

### 📊 Context stats — the session at a glance

Turns, steps, how many injections, compactions, and prunes have happened.

### 🧱 Current composition — what's in the window right now

A six-color stacked bar scaled against the model's full context window (the gray track is your remaining headroom): system prompt, tool schemas, your messages, injected context, assistant replies, and tool results — plus the top-5 most expensive tool schemas. When a conversation starts degrading, this is where you find out *which part ate the budget*.

The headline occupancy and the composition counts read the **same official token-meter projections the chat composer's context ring reads** (`contextPressure` / `contextBreakdown`), so the legend's `≈` figures and proportions match the ring's click-open panel exactly; the message bucket is subdivided into the four surface categories by the fold's per-category ratios.

### 📈 Context Trend — every request's size *and* its story

One stacked bar per model request — finer than per-message — so you watch the window grow turn by turn, and drop in one ✂ when compaction hits:

![Context Trend card with the step brief](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-trend.png)

- **✨ Step brief — what a step *was*, not just how big.** Three plain-language rows under the chart: **User** recalls the message that opened the turn (on any of its steps), **In** lists what newly entered the context — usually the previous tool calls' results, failures flagged — and **Response** shows what the model returned: its reply text and/or the tools it called. Hover a row's tag to learn what the row means; click any row to open that exact message in the Context browser.
- **Read it your way** — **Step** or **Turn** granularity, **Total** (cumulative makeup) or **Delta** (each request's signed change), and sideways scroll through the whole session.
- **Hover & pin** — scrub for an instant tooltip (turn/step, time, tokens, a one-line reply preview); click to pin the full category breakdown, with provider-reported actual prompt/output/cache figures next to the estimates.
- **✂ marks the events** — compactions and prunes land exactly where they happened, so the bars' drops explain themselves.
- **Live linkage** — hovering a bar previews that step's assembled context in the Context browser beside the chart; leave the chart and it returns to your own pick.

Above: Turn 1 · Step 15 of a real session — the brief recalls the turn's opening message, the files just read in, and the reply that called `read` next.

A longer session tells the dramatic version — ~563k tokens across 48 turns, then compaction (✂) recycled −535.5k in one step, and the conversation continued from a fresh, small window:

![History chart with a pinned request](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/history-detail.png)

Switch the chart from **Total** to **Delta** and each bar becomes the *change* that request made to the window instead of its cumulative size: diverging stacks pile up from the solid zero baseline when the window grew and hang below it when it shrank, tooltips read `Δ ±Nk`, and the pinned detail card re-prices every category as a signed delta — so you can tell exactly which part of a request added (or reclaimed) tokens. Below, Turn 5's first step grew the window by **+1.6k**: injected context **+803**, the user message **+649**, the assistant reply **+178** — and nothing else moved:

![History chart in Delta mode](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/history-delta.png)

### ⚡ Context events — when and why the window changed

Every compaction, tool-output prune, skill or plugin context injection, model switch, and plan-mode toggle — each labeled with its producer source (instruction file paths, plugin id, skill name), its token delta (compactions/prunes show the **net** reclaimed amount, matching the chart's drop), turn/step attribution, and timestamp. Filter by category (**Inject / Compact / Prune / Switch / Mode**) to see exactly when each kind of event happened and its impact — e.g. when a skill was injected, when instructions were added, or how much a compaction reclaimed:

![Context events and messages](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-events.png)

### 📁 File Activity — what the agent *did* to your files

Not what the context is made of, but what it was good for: one row per touched file — read, written, or searched — aggregated up to the step you pick on the trend chart (the card scrubs live as you hover the bars; the default is the whole session to date):

- **Per-purpose counts** — how many times each file was read, written, and searched, with the header chips doubling as purpose filters (**Read / Written / Searched**), an **Images** chip for the multimodal view (`read_image` calls and image extensions), and a path search box.
- **Line deltas** — every `edit`/`write` contributes its estimated footprint (`+added / −removed`, read off the call arguments), per file and summed in the header.
- **Click to inspect** — a row expands into the file's own operation log (tool, time, per-op delta, failures flagged); each operation jumps straight to the exact tool result in the Context browser. Operations whose paths aged out of the retained window are honestly counted in a footnote.

### 🧭 Context browser — open the box of any request

Pick **Live (next request)** or any retained step from the picker, and browse what that request was actually assembled from:

![Context browser](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser.png)

Six collapsible category sections (system prompt, tool schemas, user messages, injected context, assistant replies, tool results) expand into one row per element — each with its token price — and every element expands again into its **actual content**: the full system prompt, each tool's description and JSON schema, message text, reasoning, tool-call arguments, and tool outputs.

- **Linked with the trend chart** — hover any bar in the Context trend card and the browser previews that step instantly; leave the chart and it returns to your own pick. Keep a category open while scrubbing to compare one category across steps. Clicking a step-brief row (**User** / **In** / **Response**) opens that exact message here, expanded and scrolled into view.
- **Honest about coverage** — steps before a compaction are reconstructed from the removed-message archive, and the card says so when a step's makeup is only approximate. Elements older than the loaded chat window page older history in automatically when you expand them, and live injections (AGENTS.md, session-start context, …) are always listed — never a token sum without its items.
- **Diff against the previous turn** — switch the picker to **vs previous turn** and every category gets signed delta badges (`+N` items, `+Nk` tokens), so one glance tells you what the conversation added since the end of the last turn.

Tool results open into the full call and response: the tool's name and arguments with its **OK/error** status on top, the result body with its line count and a **Raw / Markdown** display toggle, and any image payload (e.g. `read_image` output) rendered as a thumbnail card with its name, dimensions, stored size, and estimated token cost — instead of a flattened blob of text:

![Context browser showing a tool result with Raw/Markdown toggle and an image payload](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-tool-result.png)

### 🖼 Multimodal — image attachments in full view (DeepSeek Harness 0.1.1+)

Fully adapted to DeepSeek Harness 0.1.1's multimodal pipeline and the vision capability of **DeepSeek-V4-Flash-Vision-Exp**. A user message carrying images expands into a card layout — prose in the text card (with the usual raw/Markdown toggle), each image attachment as a thumbnail card in an equal-width two-column grid with its name, normalized dimensions (plus the pre-normalization size when 0.1.1's image pipeline downscaled it), stored size, and **estimated token cost** — priced by DeepSeek's official image-size→token conversion (the docs' image token calculator; 117–384 tokens per image under the provider's per-image cap), the same estimate the message/token breakdowns carry — and anything unrecognized as raw content:

![Context browser rendering image attachments](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/context-browser-images.png)

Images load through the harness's own session-authorized loader — the same one the chat history uses — and degrade to metadata-only cards when it is unavailable. Image blocks in assistant messages and tool results (e.g. `read_image` output) now render too, instead of being silently dropped.

## Like it?

If `dsh-context` helped you understand what your agent is carrying around, a ⭐ on [GitHub](https://github.com/bowenliang123/dsh-context) is much appreciated — and issues/PRs are welcome!

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
