import { parseVersion } from '../shared/version'

export const MCP_PREFIX = 'mcp__'

const LEGACY_SCHEDULE_PACKAGE = '@deepseek-ai/dsh-schedule'
const SCHEDULE_PACKAGE = '@deepseek-ai/dsh-tool-schedule'
const LEGACY_SCHEDULE_TOOLS = new Set(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'])

export function mcpServerOf(name: string): string | undefined {
  if (!name.startsWith(MCP_PREFIX)) return undefined
  const cut = name.lastIndexOf('__')
  if (cut < MCP_PREFIX.length) return undefined
  const server = name.slice(MCP_PREFIX.length, cut)
  return server.length > 0 ? server : undefined
}

export function mcpSourceOf(name: string): string | undefined {
  const server = mcpServerOf(name)
  return server !== undefined ? `mcp:${server}` : undefined
}

function legacyScheduleTool(name: string, version: string | undefined): boolean {
  if (!LEGACY_SCHEDULE_TOOLS.has(name)) return false
  const parsed = version === undefined ? null : parseVersion(version)
  return parsed !== null && parsed.major === 0 && parsed.minor === 2 && parsed.patch === 0
}

export function pinnedSourceOf(name: string, version?: string): string | undefined {
  return legacyScheduleTool(name, version) ? LEGACY_SCHEDULE_PACKAGE : FIRST_PARTY_SOURCES[name]
}

export const FIRST_PARTY_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  read: '@deepseek-ai/dsh-tool-fs',
  write: '@deepseek-ai/dsh-tool-fs',
  edit: '@deepseek-ai/dsh-tool-fs',
  apply_patch: '@deepseek-ai/dsh-tool-fs',
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
  schedule_create: SCHEDULE_PACKAGE,
  schedule_list: SCHEDULE_PACKAGE,
  schedule_view: SCHEDULE_PACKAGE,
  schedule_edit: SCHEDULE_PACKAGE,
  schedule_update: SCHEDULE_PACKAGE,
  schedule_delete: SCHEDULE_PACKAGE,
  working_directory: '@deepseek-ai/dsh-tool-working-directory',
  create_goal: '@deepseek-ai/dsh-tool-goal',
  get_goal: '@deepseek-ai/dsh-tool-goal',
  update_goal: '@deepseek-ai/dsh-tool-goal',
  lsp: '@deepseek-ai/dsh-tool-lsp',
})
