import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  FIRST_PARTY_SOURCES,
  MCP_PREFIX,
  mcpServerOf,
  mcpSourceOf,
  pinnedSourceOf,
} from '../../src/host/toolSources'

describe('mcpServerOf', () => {
  test('recovers the server from a plain or hash-appended mcp__server__tool name', () => {
    assert.equal(mcpServerOf('mcp__github__get_issue'), 'github')
    assert.equal(mcpServerOf('mcp__my_server__send_message'), 'my_server')
    assert.equal(mcpServerOf('mcp__a__b__c'), 'a__b', 'server names may themselves contain __')
    const hex64 = '0123456789abcdef'.repeat(4)
    assert.equal(mcpServerOf(`mcp__github__tool_${hex64}`), 'github')
    const cutThrough = `mcp__github__${'y'.repeat(37)}__tail`.slice(0, 51)
    assert.equal(mcpServerOf(`${cutThrough}_0123456789ab`), `github__${'y'.repeat(37)}`)
  })

  test('non-MCP names and malformed prefixes resolve to undefined', () => {
    assert.equal(mcpServerOf('bash'), undefined)
    assert.equal(mcpServerOf('mcp_server_tool'), undefined, 'no mcp__ prefix')
    assert.equal(mcpServerOf('mcp__alone'), undefined, 'the prefix separator is not a server separator')
    assert.equal(mcpServerOf('mcp____'), undefined, 'a second separator right at the prefix edge')
    assert.equal(mcpServerOf('mcp____tool'), undefined, 'an empty server between separators')
  })
})

describe('mcpSourceOf', () => {
  test('labels proxied tools with their server; other names stay unattributed', () => {
    assert.equal(mcpSourceOf('mcp__github__get_issue'), 'mcp:github')
    assert.equal(mcpSourceOf('mcp__alone'), undefined)
    assert.equal(mcpSourceOf('bash'), undefined)
  })
})

describe('FIRST_PARTY_SOURCES', () => {
  test('the pinned map is frozen and carries every attributed first-party name', () => {
    assert.ok(Object.isFrozen(FIRST_PARTY_SOURCES))
    for (const name of ['read', 'write', 'edit', 'apply_patch', 'bash', 'pwsh', 'glob', 'grep',
      'web_search', 'web_fetch', 'job_kill', 'ask_user_question', 'plan', 'skill',
      'todo_write', 'subagent', 'send_message', 'ralph', 'workflow', 'run_code',
      'schedule_view', 'schedule_edit', 'schedule_update', 'working_directory']) {
      assert.ok(name in FIRST_PARTY_SOURCES, `expected ${name} in the first-party map`)
    }
    assert.equal(FIRST_PARTY_SOURCES.apply_patch, '@deepseek-ai/dsh-tool-fs')
    assert.equal(FIRST_PARTY_SOURCES.working_directory, '@deepseek-ai/dsh-tool-working-directory')
    assert.equal(FIRST_PARTY_SOURCES.schedule_view, '@deepseek-ai/dsh-tool-schedule')
    assert.equal(FIRST_PARTY_SOURCES.schedule_edit, '@deepseek-ai/dsh-tool-schedule')
    assert.equal(FIRST_PARTY_SOURCES.schedule_update, '@deepseek-ai/dsh-tool-schedule')
    assert.equal(MCP_PREFIX, 'mcp__')
  })
})

describe('pinnedSourceOf', () => {
  test('the schedule tools keep the 0.2.0 package label only on the 0.2.0 line', () => {
    assert.equal(pinnedSourceOf('schedule_create', '0.2.0-rc.2'), '@deepseek-ai/dsh-schedule')
    assert.equal(pinnedSourceOf('schedule_delete', '0.2.0'), '@deepseek-ai/dsh-schedule')
    assert.equal(pinnedSourceOf('schedule_create', '0.2.1-rc.2'), '@deepseek-ai/dsh-tool-schedule')
    assert.equal(pinnedSourceOf('schedule_list', '0.2.2-rc.1'), '@deepseek-ai/dsh-tool-schedule')
    assert.equal(pinnedSourceOf('schedule_list'), '@deepseek-ai/dsh-tool-schedule', 'an undetectable version uses the current package')
    assert.equal(pinnedSourceOf('schedule_view', '0.2.0-rc.2'), '@deepseek-ai/dsh-tool-schedule', 'the 0.2.2 tool never moved')
    assert.equal(pinnedSourceOf('schedule_create', 'nightly'), '@deepseek-ai/dsh-tool-schedule')
    assert.equal(pinnedSourceOf('schedule_create', '1.0.0'), '@deepseek-ai/dsh-tool-schedule')
    assert.equal(pinnedSourceOf('schedule_create', '0.3.0'), '@deepseek-ai/dsh-tool-schedule')
    assert.equal(pinnedSourceOf('read', '0.2.0-rc.2'), '@deepseek-ai/dsh-tool-fs')
    assert.equal(pinnedSourceOf('unknown_tool', '0.2.2-rc.1'), undefined)
  })
})
