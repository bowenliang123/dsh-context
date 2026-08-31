/**
 * Tool-to-plugin attribution for the Context browser's tool schema rows.
 *
 * The durable `request/header` event logs each tool as a plain `ToolSchema`
 * (`name`/`description`/`parameters` only) — the harness strips everything
 * else at assembly, so the registering plugin is not in the session log. This
 * module recovers what it can without a harness change:
 *
 * 1. A `plugin` field a (future) harness or MCP client carries on the raw
 *    header entry — passed through verbatim by headers.ts's recordOf, ahead
 *    of everything here.
 * 2. MCP tools: `dsh-mcp-client` names every proxied tool
 *    `mcp__<server>__<rawName>`, so the server is recoverable from the name.
 * 3. Shipped first-party tools: a PINNED name → package map derived from the
 *    deepseek-harness tool-schema catalog (packages/core/tools + the shipped
 *    `tool-*` packages at dsh 0.1.1-rc.2; names are stable across the plugin's
 *    supported 0.1.1-rc2+ / 0.1.2-alpha2+ range). Third-party tools stay
 *    unattributed rather than guessed.
 *
 * Pure string functions: fully unit-testable, no harness imports.
 */

/** MCP server-name prefix of `dsh-mcp-client` proxied tools. */
export const MCP_PREFIX = 'mcp__'

/**
 * Recover the MCP server display label from a proxied tool name, or undefined
 * for non-MCP names. `dsh-mcp-client` names tools `mcp__<server>__<rawName>`
 * (normalized, and hash-appended when overlong/invalid — the label then shows
 * whatever of the server survived the truncation). The separating `__` is the
 * LAST one in the name, and it must sit AFTER the `mcp__` prefix: the prefix's
 * own separator (or an empty server right after it) is not a server.
 */
export function mcpServerOf(name: string): string | undefined {
  if (!name.startsWith(MCP_PREFIX)) return undefined
  const cut = name.lastIndexOf('__')
  if (cut < MCP_PREFIX.length) return undefined
  const server = name.slice(MCP_PREFIX.length, cut)
  return server.length > 0 ? server : undefined
}

/** The `mcp:<server>` display label of a proxied tool name, or undefined. */
export function mcpSourceOf(name: string): string | undefined {
  const server = mcpServerOf(name)
  return server !== undefined ? `mcp:${server}` : undefined
}

/** The pinned package of a first-party tool name, or undefined. */
export function pinnedSourceOf(name: string): string | undefined {
  return FIRST_PARTY_SOURCES[name]
}

/**
 * Pinned first-party tool → plugin package map (see header comment). One entry
 * per model-facing name of the shipped tool packages at dsh 0.1.1-rc.2, from
 * the official tool-schema catalog; names are stable across the supported
 * harness range. Packages that mount under distinct names per composition
 * (bash/pwsh persistent variants, subagent fork) map to their primary package.
 */
export const FIRST_PARTY_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  read: '@deepseek-ai/dsh-tool-fs',
  write: '@deepseek-ai/dsh-tool-fs',
  edit: '@deepseek-ai/dsh-tool-fs',
  read_image: '@deepseek-ai/dsh-tool-fs',
  glob: '@deepseek-ai/dsh-tool-fs-search',
  grep: '@deepseek-ai/dsh-tool-fs-search',
  str_replace_editor: '@deepseek-ai/dsh-tool-str-replace-editor',
  bash: '@deepseek-ai/dsh-tool-bash',
  pwsh: '@deepseek-ai/dsh-tool-pwsh',
  web_search: '@deepseek-ai/dsh-tool-web',
  web_fetch: '@deepseek-ai/dsh-tool-web',
  job_output: '@deepseek-ai/dsh-tool-jobs',
  job_list: '@deepseek-ai/dsh-tool-jobs',
  job_kill: '@deepseek-ai/dsh-tool-jobs',
  ask_user_question: '@deepseek-ai/dsh-tool-ask-user',
  plan: '@deepseek-ai/dsh-plan-mode',
  exit_plan_mode: '@deepseek-ai/dsh-plan-mode',
  skill: '@deepseek-ai/dsh-tool-skill',
  todo_write: '@deepseek-ai/dsh-tool-todo',
  subagent: '@deepseek-ai/dsh-tool-subagent',
  subagent_fork: '@deepseek-ai/dsh-tool-subagent',
  send_message: '@deepseek-ai/dsh-tool-subagent-control',
  interrupt_agent: '@deepseek-ai/dsh-tool-subagent-control',
  list_agents: '@deepseek-ai/dsh-tool-subagent-control',
  ralph: '@deepseek-ai/dsh-tool-ralph',
  workflow: '@deepseek-ai/dsh-tool-workflow',
  run_code: '@deepseek-ai/dsh-tools',
  schedule_create: '@deepseek-ai/dsh-schedule',
  schedule_list: '@deepseek-ai/dsh-schedule',
  schedule_delete: '@deepseek-ai/dsh-schedule',
  create_goal: '@deepseek-ai/dsh-tool-goal',
  get_goal: '@deepseek-ai/dsh-tool-goal',
  update_goal: '@deepseek-ai/dsh-tool-goal',
  lsp: '@deepseek-ai/dsh-tool-lsp',
})
