/**
 * Context-browser spec: step picker, category accordion, per-step
 * reconstruction with archived nodes, header content (system prompt + tool
 * schemas), raw/markdown switches, parameter tables, graceful degradation,
 * and previous-turn delta pills.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { bootViewBed, byClass, catRowOf, textOf } from './helpers/viewBed.mjs'

const bed = await bootViewBed()
const { hookStates, renderView, snapshot } = bed
let tr

test('context browser: picker, accordion, reconstruction, header content, deltas, degradation', async () => {
  // assistant) plus one archived (removed) node that was still alive at the
  // early steps; one header epoch with full prompt/schema content. ----
  bed.dataValue = {
    ...snapshot,
    archive: [{ seq: 0, cat: 'user', tokens: 5, text: 'archived message', gone: 3, time: 500 }],
  }
  bed.headersValue = {
    headers: [{
      seq: 1, time: 900, system: 'SYSTEM-PROMPT-TEXT',
      // Listed in producer order (tiny BEFORE bash) — the tools section must
      // re-rank them by token price, largest first. `bash` carries a real
      // JSON-Schema parameter object so the parsed parameter table has rows
      // to render; `tiny` ships an empty-parameter schema (table falls back
      // to the "no parameters" line).
      tools: [
        { name: 'tiny', tokens: 2, description: 'a tiny helper', schema: { name: 'tiny', parameters: { type: 'object' } } },
        {
          name: 'bash', tokens: 5, description: 'run a command',
          schema: {
            name: 'bash',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'shell command to run' },
                cwd: { type: 'string', description: 'working directory' },
                timeout: { type: 'number' },
                flags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'extra flags',
                },
              },
              required: ['command'],
            },
          },
        },
      ],
    }],
  }
  tr = renderView()
  const brKey = [...hookStates.keys()].find(k => k.includes('ContextBrowser'))
  assert.ok(brKey, 'ContextBrowser fiber registered')
  const brSlots = hookStates.get(brKey) // sel(0) openCat(1) openElem(2)
  const ctxSlots = bed.ctxSlots() // selected(0) hovered(1) hoverTurn(2) tick(3) gran(4) focusTurn(5) hoverCat(6)

  // Live view (default): six category rows; message counts follow the live nodes.
  assert.equal(byClass(tr, 'lc-br-cat-row').length, 6, 'six category sections (system/tools + four message cats)')
  assert.equal(byClass(tr, 'lc-br-pick').length, 1, 'step picker present')
  const pickOptions = byClass(tr, 'lc-br-pick')[0].args.slice(2).flat()
  assert.equal(pickOptions.length, 5, 'picker lists live + one option per retained step')
  assert.equal(byClass(tr, 'lc-br-body').length, 0, 'all categories collapsed by default (no flat dump)')

  // Open the user category -> one live element row; open the element -> content
  // falls back to the preview + the window note (no useSession in this harness).
  assert.ok(catRowOf(tr, 'User'), 'user category row present')
  brSlots[1][1]('user') // openCat('user')
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-body').length, 1, 'one category body open')
  assert.equal(byClass(tr, 'lc-br-elem-row').length, 1, 'live view lists the live user node')
  brSlots[2][1]('n1') // openElem(seq 1)
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-content').length, 1, 'element content area open')
  assert.match(textOf(byClass(tr, 'lc-br-content')[0]), /first message/, 'content falls back to the node preview')
  assert.match(textOf(byClass(tr, 'lc-br-content')[0]), /outside the loaded window/, 'window note follows the fallback preview')
  // The message detail card carries the raw/markdown switch too (a segmented
  // pill like the trend chart's Step/Turn), defaulting to MARKDOWN: the
  // preview renders through MarkdownText while the window note stays.
  const msgSeg = byClass(byClass(tr, 'lc-br-content')[0], 'lc-rich-seg')[0]
  assert.ok(msgSeg, 'message detail card carries the raw/markdown switch')
  const msgSegBtns = byClass(msgSeg, 'lc-rich-seg-btn')
  assert.deepEqual(msgSegBtns.map(b => textOf(b)), ['Raw', 'Markdown'], 'one segment per view')
  assert.match(msgSegBtns[1].args[1].className, /lc-rich-seg-on/, 'markdown segment is active by default')
  assert.equal(msgSegBtns[0].args[1].title, 'View Raw Text', 'raw segment tooltip')
  assert.equal(msgSegBtns[1].args[1].title, 'View as Markdown', 'markdown segment tooltip')
  assert.equal(textOf(byClass(tr, 'lc-md-stub')[0]), 'first message', 'markdown view carries the message text')
  assert.match(textOf(byClass(tr, 'lc-br-content')[0]), /outside the loaded window/, 'window note stays in markdown mode')
  // The Raw segment restores the raw <pre>; picking Markdown again flips back.
  msgSegBtns[0].args[1].onClick()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-md-stub').length, 0, 'raw mode drops the markdown renderer')
  assert.match(textOf(byClass(tr, 'lc-ts-desc-body')[0]), /first message/, 'raw view carries the message text')
  assert.match(byClass(tr, 'lc-rich-seg-btn')[0].args[1].className, /lc-rich-seg-on/, 'raw segment lights up')
  byClass(tr, 'lc-rich-seg-btn')[1].args[1].onClick()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-md-stub').length, 1, 'switching back restores the markdown view')

  // Pick step seq 2 (Turn 1 · Step 1): the reconstruction includes the archived
  // node (gone 3 > 2) — the accordion resets on picking, so reopen the category.
  byClass(tr, 'lc-br-pick')[0].args[1].onChange({ target: { value: '2' } })
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-body').length, 0, 'picking a step collapses the accordion')
  brSlots[1][1]('user')
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-elem-row').length, 2, 'a past step reconstructs archived + live nodes')
  assert.match(textOf(byClass(tr, 'lc-br-body')[0]), /archived message/, 'the archived node appears in its step')

  // The live view must NOT show the archived node.
  byClass(tr, 'lc-br-pick')[0].args[1].onChange({ target: { value: 'live' } })
  tr = renderView()
  brSlots[1][1]('user')
  tr = renderView()
  assert.equal(byClass(tr, 'lc-br-elem-row').length, 1, 'live view excludes removed nodes')

  // Header content sections: the system prompt and tool schemas ride the
  // contextHeaders projection (full content, not just prices).
  brSlots[1][1]('system')
  tr = renderView()
  brSlots[2][1]('sys')
  tr = renderView()
  assert.match(textOf(byClass(tr, 'lc-br-body')[0]), /SYSTEM-PROMPT-TEXT/, 'system section shows the full prompt')

  // Raw/markdown view switch on the system-prompt detail card, defaulting to
  // MARKDOWN; the Raw segment restores the raw <pre> and Markdown flips back.
  assert.ok(byClass(tr, 'lc-rich-seg').length >= 1, 'system detail card carries the raw/markdown switch')
  const sysSegBtns = () => byClass(byClass(tr, 'lc-rich-seg')[0], 'lc-rich-seg-btn')
  assert.match(sysSegBtns()[1].args[1].className, /lc-rich-seg-on/, 'markdown segment is active by default')
  const sysMd = byClass(tr, 'lc-md-stub')
  assert.equal(sysMd.length, 1, 'markdown mode renders the prompt through MarkdownText')
  assert.equal(textOf(sysMd[0]), 'SYSTEM-PROMPT-TEXT', 'markdown view carries the same source text')
  assert.equal(byClass(tr, 'lc-br-body')[0] && byClass(byClass(tr, 'lc-br-body')[0], 'lc-ts-desc-body').length, 0,
    'markdown mode drops the raw <pre>')
  sysSegBtns()[0].args[1].onClick()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-md-stub').length, 0, 'raw mode drops the markdown renderer')
  assert.match(textOf(byClass(tr, 'lc-ts-desc-body')[0]), /SYSTEM-PROMPT-TEXT/, 'raw view shows the prompt')
  sysSegBtns()[1].args[1].onClick()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-md-stub').length, 1, 'switching back restores the markdown view')
  brSlots[1][1]('tools')
  tr = renderView()
  assert.match(textOf(byClass(tr, 'lc-br-body')[0]), /bash/, 'tools section lists the schema rows')
  const toolRowOrder = byClass(tr, 'lc-br-elem-row').map(r => textOf(r))
  assert.equal(toolRowOrder.length, 2, 'both schemas listed')
  assert.match(toolRowOrder[0], /bash/, 'tools ranked by tokens: largest first')
  assert.match(toolRowOrder[1], /tiny/, 'tools ranked by tokens: smallest last')
  brSlots[2][1]('tool:bash')
  tr = renderView()
  const toolContent = textOf(byClass(tr, 'lc-br-content')[0])
  assert.match(toolContent, /run a command/, 'tool row expands to its description')
  // The description sits inside its own titled card, with a "Description" head
  // and a body carrying the prose — the same chrome the parameter table uses.
  const descCards = byClass(tr, 'lc-ts-card').filter(c => {
    const head = byClass(c, 'lc-ts-card-head')[0]
    return head !== undefined && textOf(head).includes('Description')
  })
  assert.equal(descCards.length, 1, 'description is rendered inside a titled card')
  // The description card head carries the same raw/markdown switch, also
  // defaulting to MARKDOWN; the Raw segment restores the raw body (and back).
  const descSeg = byClass(descCards[0], 'lc-rich-seg')[0]
  assert.ok(descSeg, 'description card head carries the raw/markdown switch')
  const descMd = byClass(descCards[0], 'lc-ts-desc-md')
  assert.equal(descMd.length, 1, 'description defaults to the markdown view')
  assert.equal(textOf(byClass(descMd[0], 'lc-md-stub')[0]), 'run a command', 'markdown view carries the description text')
  byClass(descSeg, 'lc-rich-seg-btn')[0].args[1].onClick()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-ts-desc-md').length, 0, 'raw mode drops the markdown body')
  assert.match(textOf(byClass(tr, 'lc-ts-desc-body')[0]), /run a command/, 'raw view carries the prose')
  byClass(tr, 'lc-rich-seg-btn')[1].args[1].onClick()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-ts-desc-md').length, 1, 'switching back restores the markdown view')
  // Parsed parameter table sits above the (still-collapsed) raw JSON: one row
  // per declared property, type labels carry the JSON-Schema type, required
  // ones marked with ✓, descriptions shown on a second line.
  const paramRows = byClass(tr, 'lc-ts-param-row')
  assert.equal(paramRows.length, 4, 'parameter table renders one row per property')
  const bashRowText = paramRows.map(r => textOf(r))
  assert.ok(bashRowText.some(s => /command/.test(s) && /string/.test(s) && /shell command to run/.test(s)),
    'command row carries name + type + description')
  assert.ok(bashRowText.some(s => /command/.test(s) && /✓/.test(s)),
    'command is marked required')
  assert.ok(bashRowText.some(s => /timeout/.test(s) && /number/.test(s) && !/✓/.test(s)),
    'optional property shows type without the required mark')
  assert.ok(bashRowText.some(s => /flags/.test(s) && /array<string>/.test(s)),
    'array parameters render their element type')
  // Raw JSON is collapsed by default — the toggle is visible but the schema
  // string does NOT appear in the rendered text yet.
  assert.equal(byClass(tr, 'lc-ts-desc-body').filter(n => /"parameters"/.test(textOf(n))).length, 0,
    'raw JSON stays collapsed behind the toggle by default')
  const toggle = byClass(tr, 'lc-ts-json-toggle')[0]
  assert.ok(toggle, 'JSON toggle button is rendered')
  assert.match(textOf(toggle), /View Raw JSON|查看原始 JSON/, 'toggle shows the open label')
  // Expanding the toggle reveals the schema; clicking again collapses it.
  toggle.args[1].onClick()
  tr = renderView()
  assert.match(textOf(byClass(tr, 'lc-ts-desc-body')[0]), /"parameters"/, 'expanding reveals the raw JSON')
  const collapseToggle = byClass(tr, 'lc-ts-json-toggle')[0]
  assert.match(textOf(collapseToggle), /Collapse|收起/, 'toggle label flips to the hide label')
  collapseToggle.args[1].onClick()
  tr = renderView()
  assert.equal(byClass(tr, 'lc-ts-desc-body').length, 0, 'collapsing the toggle removes the JSON block')

  // Without the contextHeaders key (older host), those sections degrade to a note.
  bed.headersValue = undefined
  brSlots[1][1]('system')
  brSlots[2][1](null)
  tr = renderView()
  assert.match(textOf(byClass(tr, 'lc-br-body')[0]), /older plugin build/, 'absent headers projection degrades gracefully')
  brSlots[1][1](null)
  bed.dataValue = snapshot
  tr = renderView()

  // ---- Δ pills: count + token swings vs the PREVIOUS TURN's last request
  // (one baseline whatever step/turn granularity; live = last request).
  // The header caption states the baseline; each category row carries a count
  // pill after "n items" and a token pill hugging the left of "≈X", each
  // hidden while its figure held.
  const deltaHint = byClass(tr, 'lc-br-hint')[0]
  assert.ok(deltaHint, 'browser header carries the δ baseline caption')
  assert.match(textOf(deltaHint), /previous turn/, 'caption names the previous-turn baseline')
  bed.headersValue = {
    headers: [{
      seq: 1, time: 900, system: 'SYSTEM-PROMPT-TEXT',
      tools: [
        { name: 'tiny', tokens: 2, description: 'a tiny helper', schema: { name: 'tiny', parameters: { type: 'object' } } },
        { name: 'bash', tokens: 5, description: 'run a command', schema: { name: 'bash', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
      ],
    }],
  }
  bed.dataValue = { ...snapshot, archive: [{ seq: 0, cat: 'user', tokens: 5, text: 'archived message', gone: 3, time: 500 }] }
  tr = renderView()
  // Pick step seq 3 (turn 2): baseline = turn 1's last request, seq 2. That
  // step's assemble (seq 1 user + seq 2 assistant) vs seq 2's (archived seq 0
  // + seq 1 user) reads user 1→2 (-1) and assistant 1→0 (+1); tokens ride the
  // request records (user 40 vs 25, assistant 12 vs 10).
  byClass(tr, 'lc-br-pick')[0].args[1].onChange({ target: { value: '3' } })
  tr = renderView()
  const countPills = byClass(tr, 'lc-br-delta')
  assert.equal(countPills.length, 2, 'count pills: user -1, assistant +1')
  assert.equal(textOf(countPills[0]), '-1', 'user lost one element vs the previous turn')
  assert.equal(textOf(countPills[1]), '+1', 'assistant gained one element vs the previous turn')
  assert.match(countPills[0].args[1].className, /down/, 'a shrunken category is red-tinted')
  const tokenPills = byClass(tr, 'lc-br-tdelta')
  assert.equal(tokenPills.length, 2, 'token pills: user +15, assistant +2')
  assert.equal(textOf(tokenPills[0]), '+15', 'user tokens grew by 15 (40 vs 25)')
  assert.equal(textOf(tokenPills[1]), '+2', 'assistant tokens grew by 2 (12 vs 10)')
  // every category row still carries its count/tokens
  assert.equal(byClass(tr, 'lc-br-tokens-grp').length, 6, 'token figure never leaves a row')

  // ---- the baseline is the previous turn's last step in EITHER dimension:
  // custom fixture, turn 2 has two steps and one user node joins per step, so
  // viewing turn 2's last step (seq 4) reads +2 vs turn 1's last (seq 2, 1
  // node) — stay identical after flipping the trend granularity to turn.
  bed.dataValue = {
    ok: true, model: 'm', provider: 'p', contextWindow: 1000,
    current: { system: 1, tools: 2, user: 99, inject: 0, assistant: 0, tool: 0, total: 102 },
    toolList: [],
    requests: [
      { seq: 1, turn: 1, step: 0, time: 1, system: 1, tools: 2, user: 10, inject: 0, assistant: 0, tool: 0, total: 13 },
      { seq: 2, turn: 1, step: 1, time: 2, system: 1, tools: 2, user: 20, inject: 0, assistant: 0, tool: 0, total: 23 },
      { seq: 3, turn: 2, step: 0, time: 3, system: 1, tools: 2, user: 30, inject: 0, assistant: 0, tool: 0, total: 33 },
      { seq: 4, turn: 2, step: 1, time: 4, system: 1, tools: 2, user: 40, inject: 0, assistant: 0, tool: 0, total: 43 },
      { seq: 5, turn: 3, step: 0, time: 5, system: 1, tools: 2, user: 50, inject: 0, assistant: 0, tool: 0, total: 53 },
    ],
    events: [],
    nodes: [
      { seq: 1, cat: 'user', tokens: 1, time: 1 },
      { seq: 2, cat: 'user', tokens: 2, time: 2 },
      { seq: 3, cat: 'user', tokens: 3, time: 3 },
      { seq: 4, cat: 'user', tokens: 4, time: 4 },
      { seq: 5, cat: 'user', tokens: 5, time: 5 },
    ],
    droppedNodes: 0,
    archive: [],
  }
  tr = renderView()
  byClass(tr, 'lc-br-pick')[0].args[1].onChange({ target: { value: '4' } })
  tr = renderView()
  const readDeltas = () => ({ count: textOf(byClass(tr, 'lc-br-delta')[0]), token: textOf(byClass(tr, 'lc-br-tdelta')[0]) })
  assert.deepEqual(readDeltas(), { count: '+2', token: '+20' }, 'step granularity: seq 4 vs turn 1 last (seq 2)')
  ctxSlots[4][1]('turn') // context view -> turn granularity
  tr = renderView()
  assert.deepEqual(readDeltas(), { count: '+2', token: '+20' }, 'turn granularity keeps the SAME previous-turn baseline, not seq 3')
  // Live view: baseline = last request (seq 5, turn 3) — user 5 vs 4 (+1).
  byClass(tr, 'lc-br-pick')[0].args[1].onChange({ target: { value: 'live' } })
  tr = renderView()
  assert.deepEqual(readDeltas(), { count: '+1', token: '+49' }, 'live compares against the most recent request')

  console.log('✔ context browser test passed (picker, category accordion, per-step reconstruction, archived nodes, header content, graceful degradation)')
})
