import type { Command } from '../../../src/client/commands'
import { makeCommandPanel } from '../../../src/client/components/commandPanel'
import { makeKit, query, queryAll, text, typeText } from '../helpers/kit'

const kit = makeKit()
export const Panel = makeCommandPanel(kit)
export const T0 = 1700000000000

export function cmd(seq: number, over: Partial<Command> = {}): Command {
  return {
    seq,
    time: T0 + seq * 1000,
    tool: 'bash',
    cmd: 'git status',
    start: T0 + seq * 1000,
    end: T0 + seq * 1000 + 100,
    status: 'completed',
    err: false,
    ...over,
  }
}

export function rowTexts(container: ParentNode): string[] {
  return queryAll(container, '.lc-cmd-row').map(r => text(r))
}

export function chipCounts(container: ParentNode): string[] {
  return queryAll(container, '.lc-cmd-chips .lc-gran-btn b').map(b => text(b))
}

export async function typeInto(container: ParentNode, selector: string, value: string): Promise<void> {
  await typeText(query<HTMLInputElement>(container, selector), value)
}

export async function typeSearch(container: ParentNode, value: string): Promise<void> {
  await typeInto(container, 'input.lc-fa-search', value)
}

export function boxValue(container: ParentNode): string {
  return query<HTMLInputElement>(container, 'input.lc-fa-search').value
}
