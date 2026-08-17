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
- Use English in code comments and documentation.

## Dependency
- Consider updating the dependencies to the latest version if possible, as the deepseek-harness is evolving rapidly.

## I18n
- Chinese (Simplified) and English are supported for UI elements.

## Releasing
- Releases are cut by tagging: `git tag vX.Y.Z && gh release create vX.Y.Z`.
- A [GitHub Actions workflow](.github/workflows/release.yml) then builds, tests, and publishes the package to npm automatically via [npm Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers) — no long-lived token needed, provenance included.
- Write the release notes from the [release template](.github/release_template.md)
