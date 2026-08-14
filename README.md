# dsh-context

A **Context insight panel** for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (dsh): a plugin that adds a **Context** tab to the web UI — right beside **Chat** and **Trajectory** — so you can see what the model's context window is actually made of, and how it evolves across the conversation.

![dsh-context screenshot](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/screenshot.png)

## Quick install

One command, from any [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) installation (the `web` profile is the one `dsh web` boots; it is created automatically on first use):

```sh
dsh plugin --profile web add dsh-context
```

then start the web UI and open any session — the **上下文 / Context** tab appears right beside **Chat** and **Trajectory**:

```sh
dsh web
```

> Running dsh from a source checkout instead of the installed CLI? Prefix the commands with `pnpm` (`pnpm dsh plugin --profile web add dsh-context`).

## Why

Every model request packs the same window from six sources: the system prompt, tool schemas, your messages, injected context (skills, AGENTS.md, runtime snapshots), assistant replies, and tool results. When a conversation degrades or gets compacted, *which part ate the budget* is usually invisible. dsh-context makes it observable:

- **Current composition** — a stacked bar of the six categories, scaled against the model's context window (the gray track is your remaining headroom), plus the top-5 most expensive tool schemas.
- **History** — one stacked bar per model request (finer than per-turn), with Y-axis ticks and gridlines. Click any bar for its full breakdown, including the **provider-reported** prompt/output tokens next to the estimate. ✂ marks where compaction/pruning happened — watch the bars drop.
- **Context events** — compactions, tool-output prunes, skill injections (`Skill injected (code-review)`), plugin context injections, model switches — each with its token delta and timestamp.
- **Messages** — the currently model-visible surface, message by message, with per-message token costs.

The UI is bilingual (中文/English) and follows the dsh locale automatically.

## Install

dsh-context ships as a **dsh bundle**: an npm package with a `dsh.bundle` manifest (a `cordis.patch.yml` layer that inserts the plugin row) and a `dsh.client` manifest (the web UI half). No build step, no restart — the one-liner above installs it into the `web` profile (or any other profile you boot with `dsh --profile <name>`). The `dsh-context` loader row activates the host half, and the web app picks up the package's `./client` bundle and adds the **上下文 / Context** tab to every session view.

To install from this checkout instead (for development), from the repo root:

```sh
dsh plugin --profile <name> add .
```

If dsh is run from a source checkout, prefix the commands with `pnpm` (`pnpm dsh plugin ...`).

## Usage

Open any session and click **上下文 / Context** (to the right of Chat and Trajectory). Data refreshes every 2 seconds while the tab is open; switching sessions switches the view to that session's log — including historical, persisted sessions.

- **Hover** a history bar for a quick tooltip; **click** it to pin the breakdown below the chart.
- The overview bar is scaled to the model's context window, so ~13% full means ~13% of the window is spoken for.
- Numbers are estimates using the *same fixed-density heuristic as dsh's built-in tokenMeter* (~4 chars ≈ 1 token), so they match the harness's own stats. Wherever the provider reported real usage, it's shown alongside as "actual".

## How it works

- **Data source**: the session's durable event log. Live sessions are folded straight from the in-memory log (`sessions.get(id).events` — no clone, no disk parse); persisted sessions fall back to `sessionQuery.readSession`.
- **Transport**: host ↔ browser over a generic **Connection RPC channel** (`/dsh-context`, `ctx.connection.rpc` — the same channel mechanism the api gateway uses). The host half registers a `snapshot` endpoint; the client half calls it via `ctx.connection.rpc.call`.
- **Incremental fold**: per-session fold state lives in the Host half, so each poll only processes newly appended events — reopening the tab is instant.
- **Events decoded**: `request/header` (system prompt + tool schemas), surface events with `surfaceOp` (append/replace — compaction rewrites history in place), `compaction/summary|prune`, `assistant/message.usage` (real provider tokens), and message `source` metadata (`plugin` forms, `skill-invocation`) for injection events.
- **Architecture**: `src/host.js` is a plain ESM Cordis plugin (zero dependencies) loaded by the `dsh-context` loader row; `src/client.js` is the browser half, wrapped at build time into the web boot's closure-factory bundle (`window.__ModuleLoader__.load`). The client renders with bare `React.createElement` — theme-native via dsh CSS variables, bilingual via the client `locale` service.

## Development

```sh
node scripts/build.mjs   # writes lib/index.js (host) + lib/client.js (client bundle)
```

`build.mjs` also smoke-checks the outputs (both halves must parse; the host half must import with the `name`/`inject`/`apply` plugin shape).

## Files

| File | Role |
| --- | --- |
| `src/host.js` | Host half: incremental log fold, category accounting, `/dsh-context` snapshot RPC |
| `src/client.js` | Client half: tab registration, bilingual chart UI |
| `package.json` | `dsh.bundle` (patch layer) + `dsh.client` (web UI) manifests |
| `cordis.patch.yml` | The bundle's patch layer: inserts the `dsh-context` row |
| `scripts/build.mjs` | Zero-dependency build of `lib/index.js` + `lib/client.js` |
| `docs/screenshot.png` | The UI in action |

## License

MIT
