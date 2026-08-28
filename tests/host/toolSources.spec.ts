// Unit tests for host/toolSources.ts — best-effort tool-to-plugin attribution:
// MCP server recovery from the `mcp__` name prefix, and the pinned first-party
// package map. (A harness-logged `plugin` field, when one appears, passes
// through headers.ts ahead of everything here.)

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  FIRST_PARTY_SOURCES,
  MCP_PREFIX,
  mcpServerOf,
  mcpSourceOf,
} from '../../src/host/toolSources'

describe('mcpServerOf', () => {
  test('recovers the server from a plain mcp__server__tool name', () => {
    assert.equal(mcpServerOf('mcp__github__get_issue'), 'github')
    assert.equal(mcpServerOf('mcp__my_server__send_message'), 'my_server')
    assert.equal(mcpServerOf('mcp__a__b__c'), 'a__b', 'server names may themselves contain __')
  })

  test('non-MCP names and malformed prefixes resolve to undefined', () => {
    assert.equal(mcpServerOf('bash'), undefined)
    assert.equal(mcpServerOf('mcp_server_tool'), undefined, 'no mcp__ prefix')
    assert.equal(mcpServerOf('mcp__alone'), undefined, 'the prefix separator is not a server separator')
    assert.equal(mcpServerOf('mcp____'), undefined, 'a second separator right at the prefix edge')
    assert.equal(mcpServerOf('mcp____tool'), undefined, 'an empty server between separators')
  })

  test('hash-appended overlong names resolve the server that survived truncation', () => {
    const hex64 = '0123456789abcdef'.repeat(4)
    // Overlong names get '_<64-hex>' appended; the last __ separator survives
    // unless the truncation cut into it.
    assert.equal(mcpServerOf(`mcp__github__tool_${hex64}`), 'github')
    assert.equal(mcpServerOf(`mcp__github__tool_${'z'.repeat(64)}`), 'github')
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
  test('the pinned map is frozen and carries the documented core names', () => {
    assert.ok(Object.isFrozen(FIRST_PARTY_SOURCES))
    for (const name of ['read', 'write', 'edit', 'bash', 'pwsh', 'glob', 'grep',
      'web_search', 'web_fetch', 'job_kill', 'ask_user_question', 'plan', 'skill',
      'todo_write', 'subagent', 'send_message', 'ralph', 'workflow', 'run_code']) {
      assert.ok(name in FIRST_PARTY_SOURCES, `expected ${name} in the first-party map`)
    }
    assert.equal(MCP_PREFIX, 'mcp__')
  })
})
