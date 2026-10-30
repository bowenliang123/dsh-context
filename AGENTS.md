# dsh-context

A DeepSeek Harness plugin for context insight, actions, and management.

## Background

- DeepSeek Harness (dsh):
  - an open-source agent harness developed by DeepSeek AI.
  - Github: https://github.com/deepseek-ai/deepseek-harness
  - NPM: @deepseek-ai/dsh
  - MUST ensure the full clone of the DeepSeek Harness repository is available locally, before any work.
  - MUST always dive deep into the details of dsh source code and dependencies, for its mechanisms, lifecycles, and modules. Ensure every decision is based on the full and actual truth of the dsh source code.
  - Local clone at `~/dev/deepseek-harness`: `git pull` on `main` to update, and run `pnpm install` after pulling or switching commit/tag. Commits and version tags are available for reference and diff.

- DeepSeek Harness Plugin:
  - Reference docs: https://deepseek-harness.github.io/deepseek-harness/en/reference/
  - Example plugins: GitHub topic `dsh-plugin` — https://github.com/topics/dsh-plugin

## Coding Standard
  
  ### Priorities
  
  - User experience, data accuracy, and data integrity come first. Nothing outranks them.
  - Never trade them away for refactors, performance, or convenience.
  - Verify every change against reality with real tests. No assumptions.
  
  ### Data Integrity
  
  - No shallow caching: users see the complete session and the complete scope, never only the cached slice.
  - Every statistic covers the full session and full scope, and reflects real content and real changes.
  - Async, progressive loading is fine for first paint, but must never require extra user actions. Load or refresh more in the background automatically.
  
  ### Efficiency
  
  - Make the smallest change that fully solves the problem, with the most efficient implementation.
  - Keep code and tests small, modular, and loosely coupled. No duplication.
  - Reuse existing test suites, cases, and assertions. Delete tests and code that are outdated or no longer needed.
  - Reuse what DeepSeek Harness already provides: classes, utilities, styles, style tokens, events, presets, lifecycles.
  
  ### Comments
  
  - No comments in source code or tests.
  - Machine-readable directives required by tooling (`v8 ignore`, triple-slash references) are exempt; keep them minimal and drop their explanatory prose.
  
  ### Tests
  
  - Reuse existing specs, suites, cases, and assertions. Drop tests no longer needed.
  - Iterate with the narrowest run first: `pnpm exec vitest run tests/<area>/<name>.spec.ts -t "<case name>"` (regex, e.g. `"a|b"`).
  
  ### Optimization
  - Prevent over-engineering
  - Prevent memory leaking risks, dangling references, and unbounded growth of retained data, on either server and client side.
  - Always re-consider better efficient performance and lower memory footprint, especially for long-running sessions and complicated scenarios.
  
  ### Language
  
  - English only: code, comments, tests, docs, PR descriptions, commit messages.
  
  ### Temporary Files
  
  - Create them only in `./.tmp`.
  - Delete them immediately after use.
  
  ### File Size
  
  - Every source and test file stays under 1000 lines.


## Pre-commit checks

Complete ALL of these before ANY commit:

- Close out the to-do list, ensuring every item is completed, cleaned up or explicitly closed.
- Review the full diff independently: every change necessary, correct, and not over-engineered.
- Clean up generated temporary files and temporary or unhelpful comments.
- Load the [code-review](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md) skill, run it to review all the changes.
  - Independently verify or follow each of its suggestions after its multi-axis analysis done. 
  - Tell its subagents to skip typecheck, lint, and test coverage, which the main agent covers.
  - Pass its subagents the relevant filenames and line number ranges during the work.
- Run `pnpm run check`: it runs `pnpm run lint`, `pnpm run typecheck` and `pnpm run coverage` concurrently, prints each tool's COMPLETE output, and fails when any of them does (the same logs stay in `.tmp/check-logs/`).
  - Fix every lint and type error, and ensure 100% per-file coverage. Please capture the ALL content of the full output without truncation or tailing.
    - Example for per-file 100% coverage output:
      ```
      % Coverage report from v8
      -------------------------|---------|----------|---------|---------|-------------------
      File                     | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
      -------------------------|---------|----------|---------|---------|-------------------
      -------------------------|---------|----------|---------|---------|-------------------
      ```
    - If any file is not 100% covered, the File and Uncovered Line #s columns shows the missing line numbers.
  - The `pre-commit` hook runs this same gate, and a green run stamps the worktree into `.tmp/check.stamp`, so a commit of unchanged content skips it; `pnpm run check --full` forces a full re-run.

## Layout & responsive

- The plugin pane is the shell's center column, not the viewport — its width follows the sidebar's collapse and drags. Drive responsive layout with container queries (the harness's own idiom), not viewport media queries.
- Fold, never crush: under width pressure, wrap rows or fold grid columns instead of truncating into unreadability. No horizontal scrollbars, no overlapping content, and every field stays reachable on the narrowest pane.
- Mind container-query side effects: size containment changes containing-block behavior, so fullscreen overlays portal to `document.body`. Point-of-use specifics must be encoded in the rule's own declarations or pinned by tests, not in comments.
- Verify layout changes visually before shipping: a spread of widths from desktop down to phone (~390px), in both locales (English labels are the truncation stress case), on a long session, including the `/context` modal.

## Build & run
- **Build**: run `pnpm run build` after applying code changes.
- **Watch**: run `pnpm run watch` to hot-reload the local plugin in dsh while developing in the browser. The watch build is the lean profile — unminified JavaScript, no source maps, no declaration file — which keeps the watcher's resident set low; `pnpm run build` emits the full release artifacts.
- **Windows**: `pnpm run watch` and `pnpm run web` are pure Node; the bash-backed scripts locate Git for Windows automatically, and `DSH_CTX_BASH` overrides the `bash.exe` path.
- **Web server**: it may already be running at `http://127.0.0.1:3080/`. To restart, run `pnpm run web` (kills the running `dsh web`, then starts `dsh web --no-open`).
- **Tokenized URL**: always open the full URL printed at startup, `http://127.0.0.1:3080/?token=XXXXXXXXX`. Save it to `.tmp/dsh-web-url.txt` and read it from there for later browser runs; each restart prints a new token and the old URL stops working, so overwrite the file every time.
- **Auth-token errors**: kill the dsh process, restart with `dsh web --no-open`, and open the newly printed tokenized URL.

## Compatibility - Important!
- MUST install and work correctly on every supported `@deepseek-ai/dsh` release, with no regressions in runtime dependencies, message parsing, or any user-visible behavior.
- **`docs/compatibility.md` is the single source of truth** — supported set, admission gates, fold rules, metering parity, client seams, projection-cache protocol, packaging pins, and the verification gates. Read it BEFORE any compatibility-relevant change, and keep it current whenever the code or the supported set changes. Keep it minimal — less is always better: record only decisions and declared limitations that no other artifact carries, with evidence pointers into the dsh source tree; never narrate what code, tests, or git history already say.
- Consider updating dependencies to the latest version where possible — deepseek-harness evolves rapidly.

## I18n
- Chinese (Simplified) and English are supported for UI elements.
- Update all the supported languages translations when adding or modifying the UI elements.
- Do not keep the deprecated or unused language keys.

## Docs
- `docs` directory contains only end-user faced documents.
- `docs/social-preview.png` (GitHub social preview) must be exactly **1280 × 640 pixels**.
- `README.md` images must use external URLs so they render on both GitHub and NPM — put the file in `docs/` and embed it as `![alt](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/docs/<image>.png)`.

## Git
- When asked to commit, please commit the possibly mixed changes separately for each task or purpose.
- `gh` cli is installed and logged in.
- Run `git push` after creating commits.

## Releasing
- Version X.Y.Z, 大版本.次版本.小版本。
- Review all the commits/changes since last tagged release.
- Review relevant recent issues and PRs; mention them in release notes and close resolved issues.
- Releases are cut by tagging: `git tag vX.Y.Z && gh release create vX.Y.Z`.
- A [GitHub Actions workflow](.github/workflows/release.yml) then builds, tests, and publishes the package to npm automatically — no manual action needed.
- Write the release notes from the [release template](.github/release_template.md)

<!-- CODEGRAPH_START -->
## CodeGraph
This repo is indexed by CodeGraph (a `.codegraph/` directory exists at the repo root, if not run `codegraph init` to initialize it).
- MUST reach for it BEFORE any grep/find or reading files when you need to understand or locate code:
- **Shell** (always works): ALWAYS run and collect ALL output of `codegraph sync -q && codegraph explore --path /some-path "<symbol names or question>"` without truncating text
- Queries are fast and cheap — issue several `codegraph explore` calls in one turn, each from a different question or angle, and use them liberally instead of stopping after the first one.
<!-- CODEGRAPH_END -->
