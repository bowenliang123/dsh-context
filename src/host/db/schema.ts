import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const STORAGE_VERSION = 10

export const APPLICATION_ID = 0x44534358

export const FOLD_STATUSES = [
  'pending', 'folding', 'deleting', 'ok', 'failed', 'unsupported',
] as const

export type FoldStatus = (typeof FOLD_STATUSES)[number]

const FOLD_STATUS_SQL = sql.raw(FOLD_STATUSES.map(value => `'${value}'`).join(', '))

const SURFACE_CATEGORIES = ['user', 'inject', 'skill', 'assistant', 'tool'] as const

const SURFACE_CATEGORY_SQL = sql.raw(SURFACE_CATEGORIES.map(value => `'${value}'`).join(', '))

const EVENT_KINDS = ['inject', 'compaction', 'prune', 'model', 'mode'] as const

const EVENT_KIND_SQL = sql.raw(EVENT_KINDS.map(value => `'${value}'`).join(', '))

const FILE_OP_KINDS = ['read', 'write', 'search'] as const

const FILE_OP_KIND_SQL = sql.raw(FILE_OP_KINDS.map(value => `'${value}'`).join(', '))

const SPAN_KINDS = ['ttft', 'reasoning', 'text', 'toolarg', 'tools', 'other'] as const

const SPAN_KIND_SQL = sql.raw(SPAN_KINDS.map(value => `'${value}'`).join(', '))

const SKILL_SOURCES = ['invocation', 'result', 'dispatch'] as const

const SKILL_SOURCE_SQL = sql.raw(SKILL_SOURCES.map(value => `'${value}'`).join(', '))

const TOMBSTONE_REASONS = ['missing-from-list', 'log-file-missing'] as const

const TOMBSTONE_REASON_SQL = sql.raw(TOMBSTONE_REASONS.map(value => `'${value}'`).join(', '))

export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  createdAt: integer('created_at').notNull(),
  cwd: text('cwd'),
  parentSession: text('parent_session'),
  origin: text('origin'),
  isSeeded: integer('is_seeded').notNull().default(0),
  delegationDepth: integer('delegation_depth'),
  agentPreset: text('agent_preset'),
  familyRoot: text('family_root').notNull(),
  seedCutSeq: integer('seed_cut_seq'),
  createdDay: text('created_day'),
  title: text('title').notNull().default(''),
  blank: integer('blank').notNull().default(1),
  lastPromptAt: integer('last_prompt_at'),
  updatedAt: integer('updated_at').notNull(),
  archived: integer('archived').notNull().default(0),
  workspaceTitle: text('workspace_title'),
  running: integer('running').notNull().default(0),
  searchText: text('search_text').notNull().default(''),
  model: text('model'),
  provider: text('provider'),
  reasoningEffort: text('reasoning_effort'),
  contextWindow: integer('context_window'),
  maxOutputTokens: integer('max_output_tokens'),
  curTotal: integer('cur_total').notNull().default(0),
  lastUser: text('last_user'),
  billedTokens: integer('billed_tokens').notNull().default(0),
  foldStatus: text('fold_status', { enum: FOLD_STATUSES }).notNull(),
  foldError: text('fold_error'),
  lastSeq: integer('last_seq').notNull().default(-1),
  logPath: text('log_path'),
  logSize: integer('log_size'),
  logMtime: real('log_mtime'),
  logRevision: text('log_revision'),
  detailRev: integer('detail_rev').notNull().default(0),
  foldedAt: integer('folded_at').notNull().default(0),
}, t => [
  check('ck_sessions_fold_status', sql`${t.foldStatus} in (${FOLD_STATUS_SQL})`),
  check('ck_sessions_origin', sql`${t.origin} is null or ${t.origin} = 'subagent'`),
  index('idx_sessions_updated').on(t.updatedAt),
  index('idx_sessions_archived_updated').on(t.archived, t.updatedAt),
  index('idx_sessions_workspace').on(t.workspaceTitle),
  index('idx_sessions_parent').on(t.parentSession),
  index('idx_sessions_family').on(t.familyRoot),
  index('idx_sessions_billed').on(t.billedTokens),
  index('idx_sessions_cur_total').on(t.curTotal),
  index('idx_sessions_model').on(t.model),
  index('idx_sessions_running').on(t.running),
  index('idx_sessions_origin').on(t.origin),
])

export const requests = sqliteTable('requests', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  time: integer('time').notNull(),
  day: text('day').notNull(),
  turn: integer('turn'),
  step: integer('step'),
  startsTurn: integer('starts_turn').notNull().default(0),
  isInherited: integer('is_inherited').notNull().default(0),
  systemTokens: integer('system_tokens').notNull().default(0),
  toolsTokens: integer('tools_tokens').notNull().default(0),
  userTokens: integer('user_tokens').notNull().default(0),
  injectTokens: integer('inject_tokens').notNull().default(0),
  skillTokens: integer('skill_tokens').notNull().default(0),
  assistantTokens: integer('assistant_tokens').notNull().default(0),
  toolTokens: integer('tool_tokens').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  model: text('model'),
  provider: text('provider'),
  period: text('period'),
  promptTokens: integer('prompt_tokens'),
  inputTokens: integer('input_tokens'),
  cacheReadTokens: integer('cache_read_tokens'),
  cacheWriteTokens: integer('cache_write_tokens'),
  outputTokens: integer('output_tokens'),
  reasoningTokens: integer('reasoning_tokens'),
  genMs: integer('gen_ms'),
  activeMs: integer('active_ms'),
}, t => [
  primaryKey({ columns: [t.sessionId, t.seq] }),
  check('ck_requests_period', sql`${t.period} is null or ${t.period} in ('peak', 'off')`),
  index('idx_requests_day').on(t.day, t.sessionId),
  index('idx_requests_turn').on(t.sessionId, t.turn),
  index('idx_requests_model').on(t.model),
  index('idx_requests_provider').on(t.provider),
])

export const steps = sqliteTable('steps', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  turn: integer('turn'),
  step: integer('step'),
  startTime: integer('start_time').notNull(),
  endTime: integer('end_time'),
  day: text('day').notNull(),
  requestSeq: integer('request_seq'),
  wallMs: integer('wall_ms').notNull().default(0),
  activeMs: integer('active_ms').notNull().default(0),
  waitMs: integer('wait_ms').notNull().default(0),
  idleMs: integer('idle_ms').notNull().default(0),
  toolBusyMs: integer('tool_busy_ms').notNull().default(0),
  ttftMs: integer('ttft_ms'),
  beatsFull: integer('beats_full').notNull().default(0),
}, t => [
  primaryKey({ columns: [t.sessionId, t.seq] }),
  index('idx_steps_start').on(t.sessionId, t.startTime),
  index('idx_steps_day').on(t.day),
])

export const toolCalls = sqliteTable('tool_calls', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  callId: text('call_id').notNull(),
  resultSeq: integer('result_seq'),
  name: text('name').notNull(),
  plugin: text('plugin'),
  transport: integer('transport').notNull().default(0),
  codeMode: integer('code_mode').notNull().default(0),
  parentSeq: integer('parent_seq'),
  turn: integer('turn'),
  step: integer('step'),
  day: text('day').notNull(),
  startTime: integer('start_time').notNull(),
  endTime: integer('end_time'),
  durationMs: integer('duration_ms'),
  commandStartTime: integer('command_start_time'),
  commandEndTime: integer('command_end_time'),
  commandDurationMs: integer('command_duration_ms'),
  isError: integer('is_error').notNull().default(0),
  status: text('status'),
  exitCode: integer('exit_code'),
  exitInferred: integer('exit_inferred').notNull().default(0),
  signal: text('signal'),
  timedOut: integer('timed_out').notNull().default(0),
  stopped: integer('stopped').notNull().default(0),
  denied: integer('denied').notNull().default(0),
  derived: integer('derived').notNull().default(0),
  background: integer('background').notNull().default(0),
  timeoutMs: integer('timeout_ms'),
  sandbox: text('sandbox'),
  cmd: text('cmd'),
  cmdTruncated: integer('cmd_truncated').notNull().default(0),
  cmdDescription: text('cmd_description'),
  cmdCwd: text('cmd_cwd'),
  program: text('program'),
  outChars: integer('out_chars'),
  outTruncated: integer('out_truncated').notNull().default(0),
  stderr: integer('stderr').notNull().default(0),
}, t => [
  primaryKey({ columns: [t.sessionId, t.seq] }),
  uniqueIndex('uq_tool_calls_call').on(t.sessionId, t.callId),
  index('idx_tool_calls_start').on(t.sessionId, t.startTime),
  index('idx_tool_calls_scope_start').on(t.startTime, t.seq),
  index('idx_tool_calls_day').on(t.day, t.sessionId),
  index('idx_tool_calls_session_name').on(t.sessionId, t.name),
  index('idx_tool_calls_name').on(t.name),
  index('idx_tool_calls_program').on(t.program),
  index('idx_tool_calls_duration').on(t.durationMs, t.seq),
])

export const surfaceNodes = sqliteTable('surface_nodes', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  time: integer('time'),
  cat: text('cat', { enum: SURFACE_CATEGORIES }).notNull(),
  tokens: integer('tokens').notNull(),
  reasoningTokens: integer('reasoning_tokens'),
  answerTokens: integer('answer_tokens'),
  callTokens: integer('call_tokens'),
  imgs: integer('imgs'),
  form: text('form'),
  name: text('name'),
  agent: text('agent'),
  tool: text('tool'),
  skill: text('skill'),
  isError: integer('is_error').notNull().default(0),
  calls: text('calls'),
  preview: text('preview'),
  previewTruncated: integer('preview_truncated').notNull().default(0),
  goneSeq: integer('gone_seq'),
}, t => [
  primaryKey({ columns: [t.sessionId, t.seq] }),
  check('ck_surface_cat', sql`${t.cat} in (${SURFACE_CATEGORY_SQL})`),
  index('idx_surface_gone').on(t.sessionId, t.goneSeq).where(sql`${t.goneSeq} is not null`),
])

export const systemPrompts = sqliteTable('system_prompts', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  time: integer('time').notNull(),
  tokens: integer('tokens').notNull(),
  goneSeq: integer('gone_seq'),
}, t => [
  primaryKey({ columns: [t.sessionId, t.seq] }),
  index('idx_system_gone').on(t.sessionId, t.goneSeq).where(sql`${t.goneSeq} is not null`),
])

export const headerEpochs = sqliteTable('header_epochs', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  time: integer('time').notNull(),
  reason: text('reason'),
}, t => [
  primaryKey({ columns: [t.sessionId, t.seq] }),
])

export const headerTools = sqliteTable('header_tools', {
  sessionId: text('session_id').notNull(),
  epochSeq: integer('epoch_seq').notNull(),
  ordinal: integer('ordinal').notNull(),
  name: text('name').notNull(),
  tokens: integer('tokens').notNull(),
  plugin: text('plugin'),
}, t => [
  primaryKey({ columns: [t.sessionId, t.epochSeq, t.ordinal] }),
  foreignKey({
    columns: [t.sessionId, t.epochSeq],
    foreignColumns: [headerEpochs.sessionId, headerEpochs.seq],
  }).onDelete('cascade'),
  index('idx_header_tools_epoch').on(t.sessionId, t.epochSeq),
])

export const events = sqliteTable('events', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  time: integer('time').notNull(),
  kind: text('kind', { enum: EVENT_KINDS }).notNull(),
  sub: text('sub'),
  form: text('form'),
  name: text('name'),
  agent: text('agent'),
  detail: text('detail'),
  tokens: integer('tokens'),
  grossTokens: integer('gross_tokens'),
  nodeCount: integer('node_count'),
  modelFrom: text('model_from'),
  modelTo: text('model_to'),
}, t => [
  primaryKey({ columns: [t.sessionId, t.seq] }),
  check('ck_events_kind', sql`${t.kind} in (${EVENT_KIND_SQL})`),
  index('idx_events_kind').on(t.sessionId, t.kind),
])

export const fileOps = sqliteTable('file_ops', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  ordinal: integer('ordinal').notNull(),
  time: integer('time'),
  kind: text('kind', { enum: FILE_OP_KINDS }).notNull(),
  tool: text('tool').notNull(),
  path: text('path').notNull(),
  isError: integer('is_error').notNull().default(0),
  linesAdded: integer('lines_added').notNull().default(0),
  linesRemoved: integer('lines_removed').notNull().default(0),
  detail: text('detail'),
  hits: integer('hits'),
  readStart: integer('read_start'),
  readCount: integer('read_count'),
  readEst: integer('read_est').notNull().default(0),
  parentSeq: integer('parent_seq'),
  program: text('program'),
  isPattern: integer('is_pattern').notNull().default(0),
}, t => [
  primaryKey({ columns: [t.sessionId, t.seq, t.ordinal] }),
  check('ck_file_ops_kind', sql`${t.kind} in (${FILE_OP_KIND_SQL})`),
  index('idx_file_ops_path').on(t.sessionId, t.path),
  index('idx_file_ops_time').on(t.sessionId, t.time),
])

export const skillLoads = sqliteTable('skill_loads', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  time: integer('time').notNull(),
  day: text('day').notNull(),
  name: text('name').notNull(),
  source: text('source', { enum: SKILL_SOURCES }).notNull(),
}, t => [
  primaryKey({ columns: [t.sessionId, t.seq] }),
  check('ck_skill_sources', sql`${t.source} in (${SKILL_SOURCE_SQL})`),
  index('idx_skill_loads_name').on(t.name, t.day),
  index('idx_skill_loads_day').on(t.day, t.sessionId),
  index('idx_skill_loads_session').on(t.sessionId, t.name),
])

export const timingSpans = sqliteTable('timing_spans', {
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  spanSeq: integer('span_seq').notNull(),
  seq: integer('seq').notNull(),
  startTime: integer('start_time').notNull(),
  endTime: integer('end_time').notNull(),
  kind: text('kind', { enum: SPAN_KINDS }).notNull(),
}, t => [
  primaryKey({ columns: [t.sessionId, t.spanSeq] }),
  check('ck_spans_kind', sql`${t.kind} in (${SPAN_KIND_SQL})`),
  index('idx_spans_start').on(t.sessionId, t.startTime),
  index('idx_spans_seq').on(t.sessionId, t.seq),
])

export const foldState = sqliteTable('fold_state', {
  sessionId: text('session_id').primaryKey().references(() => sessions.id, { onDelete: 'cascade' }),
  lastSeq: integer('last_seq').notNull().default(-1),
  stateJson: text('state_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const sessionTombstones = sqliteTable('session_tombstones', {
  id: text('id').primaryKey(),
  deletedAt: integer('deleted_at').notNull(),
  reason: text('reason', { enum: TOMBSTONE_REASONS }).notNull(),
}, t => [
  check('ck_tombstone_reason', sql`${t.reason} in (${TOMBSTONE_REASON_SQL})`),
  index('idx_tombstones_deleted').on(t.deletedAt),
])

export const TABLES = [
  meta,
  sessions,
  requests,
  steps,
  toolCalls,
  surfaceNodes,
  systemPrompts,
  headerEpochs,
  headerTools,
  events,
  fileOps,
  skillLoads,
  timingSpans,
  foldState,
  sessionTombstones,
] as const

export const DROP_ORDER = [
  'header_tools',
  'header_epochs',
  'timing_spans',
  'skill_loads',
  'file_ops',
  'events',
  'system_prompts',
  'surface_nodes',
  'tool_calls',
  'steps',
  'requests',
  'fold_state',
  'sessions',
  'session_tombstones',
  'meta',
] as const
