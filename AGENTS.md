# dsh-context

A DeepSeek Harness plugin for context insight, actions, and management.

## Background

- DeepSeek Harness:
  - an open-source agent harness developed by DeepSeek AI.
  - Dive deep in to the code when you are preparing for development
  - Github: deepseek-ai/deepseek-harness
  - NPM: @deepseek-ai/dsh
  - Local code: 
    - may be found in the `~/dev/deepseek-harness` directory
    - `git pull` on the `main` branch to update

- DeepSeek Harness Plugin:
  - docs:
    - Reference: https://deepseek-harness.github.io/deepseek-harness/en/reference/
  - Example plugins:
    - Available on GitHub topic `dsh-plugin`: https://github.com/topics/dsh-plugin

## Coding
- Always consider the minimal change and the most performance efficient implementation.
- Try best to use the existing classes, utilities, styles, events, presets and lifecycles provided by DeepSeek Harness.ess.
- Use English in code comments and documentation.
- Smaller, less-coupling and modulized code and tests are preferred for better maintainability and testability.
- Avoid adding unnecessary code comments (unless for the pinned major decision or for those provide significant value) and code duplication.

## Building
- Run `pnpm run build` after code changes applied.
- Run `pnpm run watch` to keep hot-reloaded on dsh with local plugin installed. It also helps developer to see the code changes in the browser.

## Dependency
- Consider updating the dependencies to the latest version if possible, as the deepseek-harness is evolving rapidly.

## Compatibility
- Must be able to install and work correctly on `@deepseek-ai/dsh` **0.1.0-rc7+** and **0.1.2-rc2+** — no regressions in runtime dependencies, message parsing, or any user-visible behavior.
- Low-level logic (e.g. token counting) should track the implementation of the newest supported dsh version.

## I18n
- Chinese (Simplified) and English are supported for UI elements.

## Docs
- `docs/social-preview.png` (GitHub social preview) must be exactly **1280 × 640 pixels**.

## Temp files
- Generate one-time temp files in the `.tmp` directory, and properly clean them up right after use.

## Git
- When asked to commit, please commit the possibly mixed changes separately for each purpose.

## Releasing
- Version X.Y.Z, 大版本.次版本.小版本。
- Releases are cut by tagging: `git tag vX.Y.Z && gh release create vX.Y.Z`.
- A [GitHub Actions workflow](.github/workflows/release.yml) then builds, tests, and publishes the package to npm automatically by github workflow. Agent don't have to do or check it manually.
- Write the release notes from the [release template](.github/release_template.md)
