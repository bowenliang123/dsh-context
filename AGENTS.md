# dsh-context

A DeepSeek Harness plugin for context insight, actions, and management.

## Background

- DeepSeek Harness (dsh):
  - an open-source agent harness developed by DeepSeek AI.
  - Github: https://github.com/deepseek-ai/deepseek-harness
  - NPM: @deepseek-ai/dsh
  - MUST ensure the full clone of the DeepSeek Harness repository is available locally, before any work.
  - MUST always dive deep into the details of dsh source code and dependencies, for its mechanisms, lifecycles, and modules. Ensure every decision is based on the full and actual truth of the dsh source code.
  - Local git clone of [dsh](https://github.com/deepseek-ai/deepseek-harness):
    - may be found in the `~/dev/deepseek-harness` directory
    - `git pull` on the `main` branch to update
    - commits and version tags are available for reference and diff
    - run `pnpm install` to update dependencies after a `git pull` or switching commit/tag

- DeepSeek Harness Plugin:
  - docs:
    - Reference: https://deepseek-harness.github.io/deepseek-harness/en/reference/
  - Example plugins:
    - Available on GitHub topic `dsh-plugin`: https://github.com/topics/dsh-plugin

## Coding
- Always consider the minimal change and the most performance efficient implementation.
- Try best to use the existing classes, utilities, styles, style tokens, events, presets and lifecycles provided by DeepSeek Harness.ess.
- Use English in code comments, documentation, Pull Request description, and commit messages.
- Smaller, less-coupling and modulized code and tests are preferred for better maintainability and testability.
- Avoid adding unnecessary code comments (unless for the pinned major decision or for those provide significant value) and code duplication.
- Update or remove the outdated or unhelpful code comments when modifying the code.
- Before any commit, MUST ALWAYS do ALL the following checks:
  - Check the to-do list, and ensure all the items are properly completed or closed.
  - Carefully independently review and simplify all the diffs and all code changes, to ensure they are necessary, correct and not over-engineered. 
  - Cleanup the generated temporary files. Cleanup temporary or unhelpful comments.
  - MUST Run `pnpm run lint:fix && pnpm run test && pnpm run build` in single command and capture FULL output, to ensure:
    - passing all the linting and test
    - the per-file code coverage MUST BE literally 100%.
      - Example output:
        - -------------------------|---------|----------|---------|---------|-------------------
          File                     | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
          -------------------------|---------|----------|---------|---------|-------------------
          All files                |     100 |      100 |     100 |     100 |

## Parsing resilience (log data must never crash or hang a view)

The plugin lives off data it does not own: the durable session log (event shapes vary across dsh versions, producers, and hand-edited replays), the conversation snapshot behind the client join, projection payloads on the wire, history RPC pages, and persisted stores. Treat all of it as untrusted input at every layer. The two failures to design out: any client- or host-side parsing that blanks the page (the error card), and anything that leaves the page stuck on "loading".

- Never let one bad record take down a view. A malformed node, event, tool entry, or file op degrades to zero rows for that item — the card, the tab, and the session keep working.
- Host-side projection folds must be TOTAL. The harness projection registry drives `apply` straight off the session/event bus with no error boundary of its own: one throwing fold stalls that unit's cells and its `session/projection` push feed, and the browser then waits on "loading" forever. So: unknown event types return the state unchanged; per-event processing is isolated so a malformed event is dropped whole (all-or-nothing — no partial state); and never materialize an `undefined`-valued property into persisted state, because the plain-JSON precondition makes one such property fail EVERY projection-cache write for the session (sessions then break in unrelated, far-away places).
- Client-side parsing degrades visibly. Sanitize delivered projection payloads at the boundary (the `timelineOf` pattern: collections re-proved, scalars zeroed, whole-value absence stays `null` → loading screen); isolate per-item work in any fold over join/log data (per-item guards, or a bounded catch when a hostile object may throw on property access); every async fetch must resolve to data or a visible retryable state, never an unhandled rejection that leaves a spinner.
- Re-prove every field at runtime. Structural narrowing over blind casts; optional chaining over non-null assertions; skip elements that fail the shape instead of throwing.
- Every parser carries hostile fixtures next to its happy path: wrong types, null/missing fields, null or primitive elements inside arrays, unpaired references, and objects that throw on property access. The 100% coverage bar applies to every guard branch — an untested guard is an unverified promise.

## Layout & responsive

- The plugin pane is the shell's center column, not the viewport — its width follows the sidebar's collapse and drags. Drive responsive layout with container queries (the harness's own idiom), not viewport media queries.
- Fold, never crush: under width pressure, wrap rows or fold grid columns instead of truncating into unreadability. No horizontal scrollbars, no overlapping content, and every field stays reachable on the narrowest pane.
- Mind container-query side effects: size containment changes containing-block behavior, so fullscreen overlays portal to `document.body`. Point-of-use specifics live in the CSS comments next to the rules they guard.
- Verify layout changes visually before shipping: a spread of widths from desktop down to phone (~390px), in both locales (English labels are the truncation stress case), on a long session, including the `/context` modal.

## Building
- Run `pnpm run build` after code changes applied.
- Run `pnpm run watch` to keep hot-reloaded on dsh with local plugin installed. It also helps developer to see the code changes in the browser.

## DSH web server
- The dsh web server may be already running, and accessible at `http://127.0.0.1:3080/` by browser.
- Run `pnpm run web` to restart the dsh web server (kills the running `dsh web` first, then starts `dsh web --no-open`).
- If the auth token issue encounters with browser, kill the dsh process and restart it by running `dsh web --no-open`.
  - Example output: 
    - $ dsh web --no-open
      > dsh web: http://127.0.0.1:3080/?token=XXXXXXXXX

## Dependency
- Consider updating the dependencies to the latest version if possible, as the deepseek-harness is evolving rapidly.

## Compatibility - Important!
- MUST be able to install and work correctly on `@deepseek-ai/dsh` **0.1.2-rc1+** — no regressions in runtime dependencies, message parsing, or any user-visible behavior. Older lines (0.1.0-rc.x, 0.1.1-rc.x, 0.1.2-alpha.x) are out of the support matrix.
- That range spans THREE session-log generations, all of which must keep working from the same code:
  - **V0** (`0.1.2-rc.x`): `request/header.header.system`, `assistant/chunk` events, `SurfaceOp { start, end }`, `tool/code-dispatch`.
  - **V2** (`0.1.3-alpha.x`): the assistant stream moved INTO the settlement (`assistant/message.data.stream` / `assistant/attempt.data.stream`); everything else stays V0.
  - **V3** (`0.1.5-alpha.x+`): the system prompt became a `system/message` surface node and left the request envelope; replacement endpoints renamed `startSeq`/`endSeq`; PTC vocabulary renamed `tool/ptc-dispatch`; `system/message` joined the surface event set.
- The V3 line's CLIENT seams moved twice. At `0.1.5-alpha.2` the conversation surface left the flat `conversation` slot for the keyed `main` panel's `main.conversation` — the plugin's `conversation.view` / `conversation.chat.assistant-actions` / `conversation.input.overlay` seats are unchanged and still hang under it — and `SidebarRightGuideEntry` dropped its `description` line. At `0.1.5-rc.1` (the newest verified baseline) that line CAME BACK: the guide entry is again a capsule of glyph + title + optional one-line `description`, exactly as the shipped Files type declares, and the plugin contributes it (the `guideEntry` probe in `tests/baselines.ts` pins the fields — `order`, `title`, `description`, `icon` — of the newest generation). Global main panels (`sidebar.panellist` + `main`) and the newer events (`deliverables/presented`, `subagent/catalog`, the `subagentCatalog` projection) exist on these lines but are not consumed here.
- The fold is **SHAPE-DRIVEN, never version-driven**: a log carries exactly one generation, the spellings are mutually exclusive, and the version probe can be WRONG (a healed profile mirror may name a different release than the running harness — see `src/host/version.ts`). `src/host/logShapes.ts` is the ONE place the generations' spellings meet (`firstTokenTimeOfStream`, `replaceRangeOf`, `isTokenChunk`); `applyTimeline` keeps a single code path over both. Never add a branch on `detectHarnessVersion` to fold behavior.
- Check carefully in depth for the compatibility of the plugin with all supported dsh version, investigate and dive deep into details of dsh source code and its dependencies (run pnpm install in dsh source code folder).
- Low-level logic (e.g. token counting) should track the implementation of the newest supported dsh version — the estimators here mirror the harness's own (`estimateSystemTokens` / `estimateSystemContent` = dsh-token-meter's `estimateSystemMessage`; the first-token rule mirrors dsh-llm's `assistantStreamFirstTokenTime`), and the fold's statistics are verified against the harness's OWN projection values on real V0 and V3 logs.
- Capabilities that only NEWER lines serve (the right Sidebar's tab registry on 0.1.5-rc.1+, the settings scope) are OPTIONAL seams: reach them through a deferred `ctx.inject([...], …)` — never a hard module `inject` — so a harness without the service leaves the plugin fully functional with the capability absent (no pending fiber, no throw). Re-prove the service shape before use, guard the registration, and declare the module in `dsh.client.inject` (an unknown row is ignored at boot, so the declaration is safe on older lines too). `tests/client/compat/` proves both directions per baseline.
- The runtime baseline gate (host side, see `src/host/version.ts` / `src/host/fallback.ts` / `src/shared/version.ts`): at apply time the host probes the RUNNING harness's version (the `dshHomePath`-anchored profiles mirror first, the plugin's own module anchor second) and compares it against `BASELINE_DSH_VERSION` (channel order: release > rc > beta > alpha). A harness below the baseline gets fallback projection units that fold nothing and serve zeroed data plus an `unsupported` wire record — the client keeps rendering the (blank) cards and pops a modal naming both versions and urging the update. Detection failure or an unparseable version FAILS OPEN (the gate never trips), so a probe misfire can never blank a working deployment.


### Compatibility verification mechanism
- `tests/baselines.ts` is the ONE source of truth for the supported baselines and the per-version seam faces (host registry, settings, client seats/history/image/markdown, platform module table).
- Always-on layers (run with `pnpm test`):
  - `tests/host/compat/` — per-baseline registry-contract drivers over the REAL projection definitions (registration rules, wire delivery, plain-JSON cache-write gate, checkpoint restore, init-header tolerance).
  - `tests/client/compat/` — per-baseline client-face matrix (finalized-nodes seat, image loader service, history face + envelope, markdown chrome prop, full Context-tab render through that generation's seats).
- Built-artifact layer (the `compat` vitest project, `tests/compat/`): runs as part of `pnpm test`. It exercises the BUILT plugin (`pnpm run build` first): the bundle smoke (the `__ModuleLoader__` handoff, the CSS channel, slot/trigger registrations, HMR safety) and the real-code matrix — the ACTUAL harness sources at each baseline tag, the tag's real registry booted on the cordis release that line vendors, plus slots/faces/vocabulary/platform-table probes from the tag's sources. A failing probe names the SEAM. Skips cleanly when `lib/` is absent, and the registry matrix also skips without the dsh checkout (env `DSH_REPO`, default `~/dev/deepseek-harness`) — the release workflow builds and fetches the baseline tags before `pnpm test`, so everything always runs there.
- To add a future dsh version: add one `Baseline` entry to `tests/baselines.ts` (tag, vendored cordis, faces), add its tag to the release workflow fetch step, then run `pnpm test`. Re-fit or refactor the seam a failing probe names.

## I18n
- Chinese (Simplified) and English are supported for UI elements.
- Update all the supported languages translations when adding or modifying the UI elements.
- Do not keep the deprecated or unused language keys.

## Docs
- `docs` directory contains only end-user faced documents.
- `docs/social-preview.png` (GitHub social preview) must be exactly **1280 × 640 pixels**.
- `README.md`
  - Images:
    - Only embed external links in the `README.md`, in order to help the readers on both GitHub and NPM to access the images
      - For example, putting the image in the `docs` directory and embedding it in the `README.md` with links:
        - ![some image](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/some-image.png)

## Temp files
- Generate one-time temp files in the `.tmp` directory, and properly clean them up right after use.

## Git
- When asked to commit, please commit the possibly mixed changes separately for each task or purpose.
- `gh` cli is installed and logged in.

## Workflow

- To-do list
  - ALWAYS keep the coding agent's to-do list up to date throughout starting or finishing every step/task of planning, investigation and implementation.
  - Before closing any task, review all pending to-do items and ensure each is completed, cleaned up or explicitly closed.

## Tool Usage
- Always read the file first using the `read` tool before using the `edit` tool, which prevents errors like "Error: edit requires reading '/path/file' first — read the file, then retry."

## Releasing
- Version X.Y.Z, 大版本.次版本.小版本。
- Releases are cut by tagging: `git tag vX.Y.Z && gh release create vX.Y.Z`.
- A [GitHub Actions workflow](.github/workflows/release.yml) then builds, tests, and publishes the package to npm automatically by github workflow. Agent don't have to do or check it manually.
- Write the release notes from the [release template](.github/release_template.md)

<!-- CODEGRAPH_START -->
## CodeGraph
This repo is indexed by CodeGraph (a `.codegraph/` directory exists at the repo root, if not run `codegraph init` to initialize it).
- MUST reach for it BEFORE any grep/find or reading files when you need to understand or locate code:
- **Shell** (always works): ALWAYS run and collect ALL output of `codegraph sync -q && codegraph explore --path /some-path "<symbol names or question>"` without truncating text
<!-- CODEGRAPH_END -->