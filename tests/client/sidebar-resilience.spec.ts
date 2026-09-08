// The right Sidebar tab against a PARTIAL primitives module (src/client/sidebar.ts):
// the guide glyph is optional, and a namespace that throws on the icon read —
// vitest's ESM mock proxy does exactly that for an unserved export — must cost
// the glyph, never the whole tab. This is the client-side half of the
// "a missing capability degrades, it never breaks the view" contract.

import { describe, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { TestClientCtx, asClientCtx } from './helpers/harness'

// No `IconContextInjectionOutline16` export: the read throws.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({}))

const { watchSidebarContextTab } = await import('../../src/client/sidebar')
type SidebarTabDefinitionLike = import('../../src/client/services').SidebarTabDefinitionLike

describe('watchSidebarContextTab — partial primitives module', () => {
  test('the tab still registers, without a guide glyph', () => {
    const ctx = new TestClientCtx()
    const definitions: SidebarTabDefinitionLike[] = []
    ctx.setService('sidebarRightTabs', {
      register: (definition: SidebarTabDefinitionLike) => {
        definitions.push(definition)
        return () => {}
      },
    })
    watchSidebarContextTab(asClientCtx(ctx), () => 'view', key => key, 'dsh-context')
    assert.equal(definitions.length, 1, 'the missing icon did not cost the tab')
    assert.equal(definitions[0].guide?.length, 1)
    assert.equal(definitions[0].guide?.[0].icon, undefined, 'no glyph, still a guide entry')
    assert.equal(ctx.slots.of('sidebar.right.pane.tab').length, 1, 'the body seat registered too')
    ctx.dispose()
  })
})
