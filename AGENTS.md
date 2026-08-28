# dsh-context

A DeepSeek Harness plugin for context insight, actions, and management.

## Background

- DeepSeek Harness:
  - an open-source agent harness developed by DeepSeek AI.
  - Dive deep in to the code when you are preparing for development
  - Github: deepseek-ai/deepseek-harness
  - NPM: @deepseek-ai/dsh
  - Local git clone of [dsh](https://github.com/deepseek-ai/deepseek-harness):
    - may be found in the `~/dev/deepseek-harness` directory
    - `git pull` on the `main` branch to update
    - commits and tags are available for reference and comparison
    - run `pnpm install` to update dependencies after a `git pull` or switching commit/tag

- DeepSeek Harness Plugin:
  - docs:
    - Reference: https://deepseek-harness.github.io/deepseek-harness/en/reference/
  - Example plugins:
    - Available on GitHub topic `dsh-plugin`: https://github.com/topics/dsh-plugin

## Exploring code
- `codegraph` helps to search and explore the code graph of the dsh and plugin, which is very useful for understanding the code structure and dependencies.
- Run `pnpm dlx @colbymchenry/codegraph query <Query or KeyWords>` to explore the code graph of the dsh and plugin, in the corresponding path of the source code folder.
- Run `pnpm dlx @colbymchenry/codegraph sync` to sync the code graph with the latest code changes, before running the query command.
- Run `pnpm dlx @colbymchenry/codegraph init` to initialize the code graph for the first time, if the code graph is not initialized yet as no `./.codegraph` folder present.

## Coding
- Always consider the minimal change and the most performance efficient implementation.
- Try best to use the existing classes, utilities, styles, events, presets and lifecycles provided by DeepSeek Harness.ess.
- Use English in code comments, documentation, Pull Request description, and commit messages.
- Smaller, less-coupling and modulized code and tests are preferred for better maintainability and testability.
- Avoid adding unnecessary code comments (unless for the pinned major decision or for those provide significant value) and code duplication.
- Before any commit, MUST ALWAYS do ALL the following checks:
  - Check the to-do list, and ensure all the items are properly completed or closed.
  - Review and simplify all the code changes, to ensure they are necessary, correct and not over-engineered.
  - Cleanup all temporary files. Cleanup temporary or unhelpful comments.
  - Run `pnpm run lint:fix`, to check and auto-fix code style and formatting.  
  - Run `pnpm run test`, to run all tests, and ensure the code coverage is literally 100%.
  - Run `pnpm run build`, to ensure the code can be built successfully.

## Parsing resilience (log data must never crash or hang a view)

The plugin lives off data it does not own: the durable session log (event shapes vary across dsh versions, producers, and hand-edited replays), the conversation snapshot behind the client join, projection payloads on the wire, history RPC pages, and persisted stores. Treat all of it as untrusted input at every layer. The two failures to design out: any client- or host-side parsing that blanks the page (the error card), and anything that leaves the page stuck on "loading".

- Never let one bad record take down a view. A malformed node, event, tool entry, or file op degrades to zero rows for that item — the card, the tab, and the session keep working.
- Host-side projection folds must be TOTAL. The harness projection registry drives `apply` straight off the session/event bus with no error boundary of its own: one throwing fold stalls that unit's cells and its `session/projection` push feed, and the browser then waits on "loading" forever. So: unknown event types return the state unchanged; per-event processing is isolated so a malformed event is dropped whole (all-or-nothing — no partial state); and never materialize an `undefined`-valued property into persisted state, because the plain-JSON precondition makes one such property fail EVERY projection-cache write for the session (sessions then break in unrelated, far-away places).
- Client-side parsing degrades visibly. Sanitize delivered projection payloads at the boundary (the `timelineOf` pattern: collections re-proved, scalars zeroed, whole-value absence stays `null` → loading screen); isolate per-item work in any fold over join/log data (per-item guards, or a bounded catch when a hostile object may throw on property access); every async fetch must resolve to data or a visible retryable state, never an unhandled rejection that leaves a spinner.
- Re-prove every field at runtime. Structural narrowing over blind casts; optional chaining over non-null assertions; skip elements that fail the shape instead of throwing.
- Every parser carries hostile fixtures next to its happy path: wrong types, null/missing fields, null or primitive elements inside arrays, unpaired references, and objects that throw on property access. The 100% coverage bar applies to every guard branch — an untested guard is an unverified promise.

## Building
- Run `pnpm run build` after code changes applied.
- Run `pnpm run watch` to keep hot-reloaded on dsh with local plugin installed. It also helps developer to see the code changes in the browser.

## Dependency
- Consider updating the dependencies to the latest version if possible, as the deepseek-harness is evolving rapidly.

## Compatibility - Important!
- MUST be able to install and work correctly on `@deepseek-ai/dsh` all of **0.1.0-rc7+** and **0.1.1-rc2+** and **0.1.2-alpha1+** — no regressions in runtime dependencies, message parsing, or any user-visible behavior.
- Check carefully in depth for the compatibility of the plugin with all supported dsh version, investigate and dive deep into details of dsh source code and its dependencies (run pnpm install in dsh source code folder).
- Low-level logic (e.g. token counting) should track the implementation of the newest supported dsh version.

## I18n
- Chinese (Simplified) and English are supported for UI elements.
- Update all the supported languages translations when adding or modifying the UI elements.
- Do not keep the deprecated or unused language keys.

## Docs
- `docs` directory contains only end-user faced documents.
- `docs/social-preview.png` (GitHub social preview) must be exactly **1280 × 640 pixels**.

## Temp files
- Generate one-time temp files in the `.tmp` directory, and properly clean them up right after use.

## Git
- When asked to commit, please commit the possibly mixed changes separately for each task or purpose.
- Push the commits automatically.
- `gh` cli is installed and logged in.

## Workflow

- To-do list
  - Keep the coding agent's to-do list up to date throughout planning, investigation and implementation.
  - Before closing any task, review all pending to-do items and ensure each is completed, cleaned up or explicitly closed.

## Tool Usage
- Always read the file first using the `read` tool before using the `edit` tool, which prevents errors like "Error: edit requires reading '/path/file' first — read the file, then retry."

## Releasing
- Version X.Y.Z, 大版本.次版本.小版本。
- Releases are cut by tagging: `git tag vX.Y.Z && gh release create vX.Y.Z`.
- A [GitHub Actions workflow](.github/workflows/release.yml) then builds, tests, and publishes the package to npm automatically by github workflow. Agent don't have to do or check it manually.
- Write the release notes from the [release template](.github/release_template.md)
