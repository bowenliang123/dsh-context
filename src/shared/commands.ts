import type { CommandRecord } from './types'
import { parseCallArgs } from './fileOps'

export type CommandTool = 'bash' | 'pwsh' | 'run_code'

export function commandTool(tool: string | undefined): CommandTool | null {
  if (tool === 'bash' || tool === 'pwsh' || tool === 'run_code') return tool
  return null
}

export interface CommandArgs {
  cmd: string
  description?: string
  cwd?: string
  timeoutMs?: number
  background?: true
  sandbox?: string
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function commandArgsRecordOf(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') return parseCallArgs(value)
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  return null
}

export function commandArgsOf(tool: string, raw: unknown, maxChars: number): (CommandArgs & { truncated?: true }) | null {
  const args = commandArgsRecordOf(raw)
  const cmd = tool === 'run_code' ? stringOf(args?.code) : stringOf(args?.command)
  if (cmd === undefined) return null
  const out: CommandArgs & { truncated?: true } = {
    cmd: cmd.length > maxChars ? cmd.slice(0, maxChars) : cmd,
    ...(cmd.length > maxChars ? { truncated: true as const } : {}),
  }
  const description = stringOf(args?.description)
  if (description !== undefined) out.description = description
  const workdir = stringOf(args?.workdir)
  if (workdir !== undefined) out.cwd = workdir
  const timeoutMs = args?.timeoutMs
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) out.timeoutMs = timeoutMs
  if (args?.run_in_background === true) out.background = true
  const sandbox = stringOf(args?.sandbox_permissions)
  if (sandbox !== undefined) out.sandbox = sandbox
  return out
}

export interface CommandMarkers {
  exit?: number
  signal?: string
  timedOut?: true
  stopped?: true
  denied?: true
  truncated?: true
  stderr?: true
  backgroundAck?: true
}

const PROMOTED_ACK = new RegExp(
  '(?:^|\\n)\\[still running after \\d+ms; moved to background job [^\\]\\n]+\\]'
  + '(?:\\nThe command keeps running in the background\\.[^\\n]*)?\\s*$',
)

export function markersOfText(text: string): CommandMarkers {
  const out: CommandMarkers = {}
  const acked = /(?:^|\n)started background job \S+\s*$/.test(text) || PROMOTED_ACK.test(text)
  if (acked) {
    out.backgroundAck = true
    return out
  }
  const signal = /(?:^|\n)\[killed by signal: ([^\]\n]+)\]\s*$/.exec(text)
    ?? /(?:^|\n)\[shell killed by signal: ([^\]\n]+)\](?=\n|$)/.exec(text)
  if (signal?.[1] !== undefined) out.signal = signal[1]
  else {
    const exit = /(?:^|\n)\[exit code: (\d+)\]\s*$/.exec(text)
      ?? /(?:^|\n)\[Command finished with exit code (\d+)\]\s*$/.exec(text)
      ?? /(?:^|\n)\[shell exited: code (\d+)\](?=\n|$)/.exec(text)
    if (exit?.[1] !== undefined) out.exit = Number(exit[1])
    else if (/(?:^|\n)\[shell exited\](?=\n|$)/.test(text)) out.stopped = true
  }
  if (/(?:^|\n)\[timed out after \d+ms\](?=\n|$)/.test(text)) out.timedOut = true
  if (/(?:^|\n)\[Command timed out or OOM\](?=\n|$)/.test(text)) out.timedOut = true
  if (/(?:^|\n)\[stopped: [^\]\n]+\](?=\n|$)/.test(text)) out.stopped = true
  if (/(?:^|\n)\[sandbox: file access denied under [^\]\n]+\](?=\n|$)/.test(text)) out.denied = true
  if (/(?:^|\n)\[output truncated; /.test(text)) out.truncated = true
  if (/(?:^|\n)\[stderr\]\n/.test(text)) out.stderr = true
  return out
}

export function exitOfJobDetail(detail: unknown): number | undefined {
  if (typeof detail !== 'string') return undefined
  const match = /(?:^|;\s*)exit code: (\d+)\b/.exec(detail)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

export function signalOfJobDetail(detail: unknown): string | undefined {
  if (typeof detail !== 'string') return undefined
  const match = /(?:^|;\s*)signal: ([^;]+)/.exec(detail)
  return match?.[1]?.trim() || undefined
}

export function outcomeOfMarkers(markers: CommandMarkers, isError: boolean): Pick<CommandRecord, 'status' | 'exit' | 'exitInferred'> {
  if (markers.signal !== undefined || markers.stopped === true) return { status: 'killed' }
  if (markers.exit !== undefined) return markers.exit === 0 ? { status: 'completed', exit: 0 } : { status: 'failed', exit: markers.exit }
  if (markers.denied === true || markers.timedOut === true || isError) return { status: 'failed' }
  return { status: 'completed', exit: 0, exitInferred: true }
}

export function firstLineOf(cmd: string): string {
  const nl = cmd.indexOf('\n')
  return (nl < 0 ? cmd : cmd.slice(0, nl)).trim()
}

export function hideableCdPrefix(cmd: string, workspace: string | undefined): number {
  if (workspace === undefined || workspace === '') return 0
  const root = workspace.replace(/\/+$/, '')
  if (root === '') return 0
  const match = /^\s*cd\s+(\S+|"[^"]*"|'[^']*')\s*&&\s*/.exec(cmd)
  if (match === null) return 0
  const target = match[1].replace(/^["']|["']$/g, '').replace(/\/+$/, '')
  return target === root ? match[0].length : 0
}

export type CommandDialect = 'bash' | 'pwsh'

const BASH_WRAPPERS = new Set(['env', 'sudo', 'doas', 'command', 'exec', 'time', 'nohup', 'nice', 'stdbuf', 'timeout', 'caffeinate', 'noglob', 'nocorrect'])

const WRAPPER_VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
  sudo: new Set(['-u', '--user', '-g', '--group', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-h', '--host', '-r', '--role', '-t', '--type', '-U', '--other-user', '-R', '--chroot']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n', '--adjustment']),
  time: new Set(['-f', '--format', '-o', '--output']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  stdbuf: new Set(['-i', '--input', '-o', '--output', '-e', '--error']),
  caffeinate: new Set(['-t', '-w']),
  exec: new Set(['-a']),
}

const WRAPPER_VALUE_LETTERS = new Map<string, ReadonlySet<string>>([
  ['sudo', new Set(['u', 'g', 'p', 'C', 'D', 'h', 'r', 't', 'U', 'R'])],
  ['doas', new Set(['u', 'C'])],
  ['env', new Set(['u', 'C', 'S'])],
  ['nice', new Set(['n'])],
  ['timeout', new Set(['s', 'k'])],
  ['stdbuf', new Set(['i', 'o', 'e'])],
  ['caffeinate', new Set(['t', 'w'])],
  ['exec', new Set(['a'])],
])

const BASH_HEADS = new Set(['[', '[[', 'for', 'if', 'while', 'until', 'case', 'do', 'then', 'else', 'elif', 'function', 'select', 'coproc', 'done', 'fi', 'esac'])
const BASH_DECLARATIONS = new Set(['export', 'local', 'declare', 'readonly', 'typeset'])
const PWSH_HEADS = new Set(['if', 'elseif', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'function', 'filter', 'param', 'begin', 'process', 'end', 'try', 'catch', 'finally', 'trap', 'return', 'throw', 'break', 'continue', 'using', 'class', 'enum'])

interface Word {
  word: string
  end: number
}

function readWord(text: string): Word | null {
  let i = 0
  let word = ''
  while (i < text.length) {
    const c = text[i]
    if (c === '"' || c === "'") {
      const quote = c
      i++
      while (i < text.length && text[i] !== quote) {
        if (quote === '"' && text[i] === '\\' && i + 1 < text.length && /[\\$`"\n]/.test(text[i + 1])) { i++; word += text[i]; i++; continue }
        word += text[i]
        i++
      }
      if (i < text.length) i++
      continue
    }
    if (c === '\\' && i + 1 < text.length && /\s/.test(text[i + 1])) { word += text[i + 1]; i += 2; continue }
    if (/\s/.test(c) || c === ';' || c === '&' || c === '|' || c === ')' || c === '}') break
    word += c
    i++
  }
  return word === '' ? null : { word, end: i }
}

function scanParens(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1)
      if (close === -1) return text.length
      i = close
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i + 1
  }
  return text.length
}

function readAssignment(text: string): { name: string; value: string | null; end: number } | null {
  const head = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(text)
  if (head === null) return null
  const compound = head[0].includes('+')
  let i = head[0].length
  const first = text[i]
  let value: string | null = null
  if (first === '"' || first === "'") {
    let j = i + 1
    let raw = ''
    while (j < text.length && text[j] !== first) {
      if (first === '"' && text[j] === '\\' && j + 1 < text.length && /[\\$`"\n]/.test(text[j + 1])) { j++; raw += text[j]; j++; continue }
      raw += text[j]
      j++
    }
    i = j < text.length ? j + 1 : text.length
    value = first === "'" || !/[$`]/.test(raw) ? raw : null
  } else if (text.startsWith('$(', i)) {
    i = scanParens(text, i + 1)
  } else if (first === '`') {
    const end = text.indexOf('`', i + 1)
    i = end === -1 ? text.length : end + 1
  } else if (first === '(') {
    i = scanParens(text, i)
  } else {
    const start = i
    while (i < text.length && !/[\s;&|]/.test(text[i])) i++
    const raw = text.slice(start, i)
    value = /[$`]/.test(raw) ? null : raw
  }
  let tail = i
  while (tail < text.length && !/[\s;&|]/.test(text[tail])) {
    const quote = text[tail]
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, tail + 1)
      if (close === -1) { tail = text.length; break }
      tail = close + 1
      continue
    }
    tail++
  }
  if (tail > i) {
    i = tail
    value = null
  }
  return { name: head[1], value: compound ? null : value, end: i }
}

function readDeclaration(text: string, vars: Map<string, string | null>): string | null {
  const first = readWord(text)
  if (first === null || !BASH_DECLARATIONS.has(first.word)) return null
  let i = first.end
  for (let guard = 0; guard < 16; guard++) {
    const ws = /^[ \t]+/.exec(text.slice(i))
    if (ws === null) break
    i += ws[0].length
    const tail = text.slice(i)
    if (tail === '' || /^[;|&#]/.test(tail)) break
    const assigned = readAssignment(tail)
    if (assigned !== null) {
      vars.set(assigned.name, assigned.value)
      i += assigned.end
      continue
    }
    const word = readWord(tail)
    if (word === null) break
    i += word.end
  }
  return text.slice(i)
}

function trimRedirections(text: string): string {
  let rest = text
  for (let guard = 0; guard < 8; guard++) {
    const op = /^\s*(?:&>|[0-9]*[<>]+&?)\s*/.exec(rest)
    if (op === null) break
    rest = rest.slice(op[0].length)
    const target = readWord(rest)
    if (target === null) break
    rest = rest.slice(target.end)
  }
  return rest
}

function readCdPrefix(text: string): string | null {
  const head = /^cd[ \t]+/.exec(text)
  if (head === null) return null
  const rest = text.slice(head[0].length)
  let at = 0
  for (let guard = 0; guard < 4; guard++) {
    const flag = /^(?:-[PL@e]+|--)[ \t]+/.exec(rest.slice(at))
    if (flag === null) break
    at += flag[0].length
  }
  const dir = readWord(rest.slice(at))
  if (dir === null) return null
  const tail = trimRedirections(rest.slice(at + dir.end))
  const sep = /^[ \t]*(?:&&|;|\r?\n)[ \t]*/.exec(tail)
  if (sep === null) return null
  const next = tail.slice(sep[0].length)
  return next.trim() === '' ? null : next
}

function readPwshCdPrefix(text: string): string | null {
  const head = /^(?:cd|Set-Location|sl)\b[ \t]*/i.exec(text)
  if (head === null) return null
  const rest = text.slice(head[0].length)
  let at = 0
  for (let guard = 0; guard < 8; guard++) {
    const flag = /^-(?:Path|LiteralPath)[ \t]+|^-[A-Z]+[ \t]*/i.exec(rest.slice(at))
    if (flag === null) break
    at += flag[0].length
  }
  const dir = readWord(rest.slice(at))
  if (dir === null) return null
  const tail = trimRedirections(rest.slice(at + dir.end))
  const sep = /^[ \t]*(?:;|&&|\r?\n)[ \t]*/.exec(tail)
  if (sep === null) return null
  const next = tail.slice(sep[0].length)
  return next.trim() === '' ? null : next
}

function readWrapper(text: string): string | null {
  const first = readWord(text)
  if (first === null) return null
  const name = normalizeProgram(first.word)
  if (!BASH_WRAPPERS.has(name)) return null
  if (name === 'command' && /^\s+-[A-Za-z]*[vV][A-Za-z]*\b/.test(text.slice(first.end))) return null
  const valueLetters = WRAPPER_VALUE_LETTERS.get(name)
  let i = first.end
  let duration = false
  for (let guard = 0; guard < 24; guard++) {
    const ws = /^\s+/.exec(text.slice(i))
    if (ws === null) break
    i += ws[0].length
    const tail = text.slice(i)
    if (tail === '' || /^[;|&#]/.test(tail)) return null
    if (/^--(?:\s|$)/.test(tail)) { i += 2; continue }
    if (name === 'env' || name === 'sudo' || name === 'doas') {
      const assigned = readAssignment(tail)
      if (assigned !== null) { i += assigned.end; continue }
    }
    const flag = /^(-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*)(?:=[^\s]+)?/.exec(tail)
    if (flag !== null) {
      i += flag[0].length
      const long = flag[1].startsWith('--')
      const single = flag[1].length === 2
      let takesValue = !flag[0].includes('=') && WRAPPER_VALUE_FLAGS[name]?.has(flag[1])
      if (!long && !single && !flag[0].includes('=') && valueLetters !== undefined) {
        const letters = flag[1].slice(1)
        for (let k = 0; k < letters.length; k++) {
          if (valueLetters.has(letters[k])) {
            takesValue = k === letters.length - 1
            break
          }
        }
      }
      if (takesValue) {
        let space = 0
        while (i + space < text.length && (text[i + space] === ' ' || text[i + space] === '\t')) space++
        const valueWord = readWord(text.slice(i + space))
        if (valueWord !== null) i += space + valueWord.end
      }
      continue
    }
    if (name === 'timeout' && !duration) {
      const durationWord = readWord(tail)
      if (durationWord !== null) { i += durationWord.end; duration = true; continue }
    }
    break
  }
  const next = trimRedirections(text.slice(i)).trimStart()
  return next === '' || /^[;|&#]/.test(next) ? null : next
}

function resolveBashWord(word: string, vars: ReadonlyMap<string, string | null>): string | null {
  if (word === '' || word.startsWith('$(') || word.startsWith('`') || word.includes('`')) return null
  const simple = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(word) ?? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(word)
  if (simple !== null) return vars.get(simple[1]) ?? null
  const prefixed = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(word) ?? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(word)
  if (prefixed !== null) {
    const value = vars.get(prefixed[1])
    const suffix = word.slice(prefixed[0].length)
    if (suffix.includes('$') || suffix.includes('`')) return null
    if (value === undefined || value === null) {
      const cut = Math.max(suffix.lastIndexOf('/'), suffix.lastIndexOf('\\'))
      const tail = cut >= 0 ? suffix.slice(cut + 1) : ''
      return tail === '' ? null : tail
    }
    return value + suffix
  }
  return word.includes('$') ? null : word
}

function skipPwshStatement(text: string, from: number): number {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === '"' || c === "'") {
      const close = text.indexOf(c, i + 1)
      if (close === -1) return text.length
      i = close
      continue
    }
    if (c === '#') {
      const newline = text.indexOf('\n', i)
      if (newline === -1) return text.length
      i = newline - 1
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { if (depth > 0) depth-- }
    else if (depth === 0 && (c === ';' || c === '\n')) return i
  }
  return text.length
}

const PWSH_ASSIGNMENT = new RegExp(
  '^\\s*(?:\\[[^\\]]+\\]\\s*)?\\$('
  + '[A-Za-z_][A-Za-z0-9_]*'
  + '(?:(?::[A-Za-z_][A-Za-z0-9_-]*)|(?:\\[[^\\]]*\\])|(?:\\.[A-Za-z_][A-Za-z0-9_]*))*'
  + ')\\s*(?:\\+|-|\\*|\\/|%|\\?\\?)?=\\s*',
)

function readPwshAssignment(text: string): { name: string; value: string | null; end: number } | null {
  const head = PWSH_ASSIGNMENT.exec(text)
  if (head === null) return null
  const compound = /[-+*/%]=|\?\?=/.test(head[0])
  const i = head[0].length
  const first = text[i]
  let value: string | null = null
  let end = i
  if (first === '"' || first === "'") {
    let j = i + 1
    let raw = ''
    while (j < text.length && text[j] !== first) {
      if (first === '"' && text[j] === '`' && j + 1 < text.length) { j++; raw += text[j]; j++; continue }
      raw += text[j]
      j++
    }
    end = j < text.length ? j + 1 : text.length
    value = first === "'" || !/[$`]/.test(raw) ? raw : null
    const tail = text.slice(end)
    if (!/^[ \t]*(?:;|#|$)/.test(tail) && !/^[ \t]*\r?\n/.test(tail)) {
      end = skipPwshStatement(text, end)
      value = null
    }
  } else {
    end = skipPwshStatement(text, i)
  }
  return { name: head[1], value: compound ? null : value, end }
}

function resolvePwshWord(word: string, vars: ReadonlyMap<string, string | null>): string | null {
  if (word === '' || word.startsWith('$(')) return null
  const scoped = /^\$([A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_-]*)*)$/.exec(word) ?? /^\$\{([^}]+)\}$/.exec(word)
  if (scoped !== null) return vars.get(scoped[1].replace(/^\$/, '')) ?? null
  const prefixed = /^\$([A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_-]*)?)/.exec(word) ?? /^\$\{([^}]+)\}/.exec(word)
  if (prefixed !== null) {
    const name = prefixed[1].replace(/^\$/, '')
    const suffix = word.slice(prefixed[0].length)
    if (suffix.includes('$') || suffix.includes('`')) return null
    const value = vars.get(name)
    if (value !== undefined && value !== null) return value + suffix
    const cut = Math.max(suffix.lastIndexOf('/'), suffix.lastIndexOf('\\'))
    const tail = cut >= 0 ? suffix.slice(cut + 1) : ''
    return tail === '' ? null : tail
  }
  return word.includes('$') || word.includes('`') ? null : word
}

function normalizeProgram(word: string): string {
  let name = word.trim()
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  if (cut >= 0) name = name.slice(cut + 1)
  const dot = name.lastIndexOf('.')
  if (dot > 0 && /\.(?:exe|cmd|bat)$/i.test(name)) name = name.slice(0, dot)
  return name.trim()
}

interface CommandSegment {
  text: string
  separator: string
}

interface Heredoc {
  delimiter: string
  stripTabs: boolean
}

function skipHeredocs(text: string, from: number, pending: readonly Heredoc[]): number {
  let at = from
  for (const heredoc of pending) {
    let closed = false
    while (at < text.length) {
      const newline = text.indexOf('\n', at)
      const end = newline === -1 ? text.length : newline
      let line = text.slice(at, end)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (heredoc.stripTabs) line = line.replace(/^\t+/, '')
      at = newline === -1 ? text.length : newline + 1
      if (line === heredoc.delimiter) { closed = true; break }
    }
    if (!closed) return text.length
  }
  return at
}

function commandSegments(cmd: string, dialect: CommandDialect): CommandSegment[] {
  const out: CommandSegment[] = []
  const heredocs: Heredoc[] = []
  let start = 0
  let i = 0
  let round = 0
  let curly = 0
  const push = (end: number, separator: string, next: number): void => {
    const text = cmd.slice(start, end)
    if (text.trim() !== '') out.push({ text, separator })
    start = next
  }
  while (i < cmd.length) {
    const c = cmd[i]
    if (dialect === 'bash' && c === '\\') { i += 2; continue }
    if (dialect === 'pwsh' && c === '`') { i += 2; continue }
    if (dialect === 'pwsh' && c === '<' && cmd[i + 1] === '#') {
      const end = cmd.indexOf('#>', i + 2)
      i = end === -1 ? cmd.length : end + 2
      continue
    }
    if (dialect === 'pwsh' && c === '@' && (cmd[i + 1] === '"' || cmd[i + 1] === "'")) {
      const quote = cmd[i + 1]
      if (/^\r?\n/.test(cmd.slice(i + 2))) {
        const close = '\n' + quote + '@'
        const end = cmd.indexOf(close, i + 2)
        i = end === -1 ? cmd.length : end + close.length
        continue
      }
    }
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      while (j < cmd.length) {
        const current = cmd[j]
        if (quote === '"' && j + 1 < cmd.length
          && ((dialect === 'bash' && current === '\\' && /[\\$`"\n]/.test(cmd[j + 1])) || (dialect === 'pwsh' && current === '`'))) {
          j += 2
          continue
        }
        if (current === quote) {
          if (dialect === 'pwsh' && cmd[j + 1] === quote) { j += 2; continue }
          break
        }
        j++
      }
      i = j + 1
      continue
    }
    if (c === '#' && (i === 0 || /[\s;&|]/.test(cmd[i - 1]))) {
      const newline = cmd.indexOf('\n', i)
      i = newline === -1 ? cmd.length : newline
      continue
    }
    if (dialect === 'bash' && c === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      let at = i + 2
      const stripTabs = cmd[at] === '-'
      if (stripTabs) at++
      while (cmd[at] === ' ' || cmd[at] === '\t') at++
      const delimiter = readWord(cmd.slice(at))
      if (delimiter !== null) {
        heredocs.push({ delimiter: delimiter.word, stripTabs })
        i = at + delimiter.end
        continue
      }
    }
    if (c === '(') round++
    else if (c === ')' && round > 0) round--
    else if (c === '{') curly++
    else if (c === '}' && curly > 0) curly--
    if (c === '\n') {
      if (heredocs.length > 0) {
        const next = skipHeredocs(cmd, i + 1, heredocs)
        if (round === 0 && curly === 0) push(i, '\n', next)
        heredocs.length = 0
        i = next
        continue
      }
      if (round === 0 && curly === 0) { push(i, '\n', i + 1); i += 1; continue }
    } else if (round === 0 && curly === 0) {
      let separator = ''
      let width = 1
      if (c === ';') separator = ';'
      else if (c === '|') {
        separator = cmd[i + 1] === '|' ? '||' : '|'
        width = cmd[i + 1] === '|' || cmd[i + 1] === '&' ? 2 : 1
      } else if (c === '&' && cmd[i + 1] === '&') { separator = '&&'; width = 2 }
      else if (dialect === 'bash' && c === '&' && cmd[i - 1] !== '>' && cmd[i + 1] !== '>') separator = '&'
      if (separator !== '') { push(i, separator, i + width); i += width; continue }
    }
    i++
  }
  push(cmd.length, '', cmd.length)
  return out
}

function bashProgram(cmd: string, vars = new Map<string, string | null>()): string {
  if (cmd.trim() === '') return ''
  let rest = cmd.trimStart()
  for (let guard = 0; guard < 32 && rest !== ''; guard++) {
    rest = rest.replace(/^[\s;&|]+/, '')
    if (rest === '') break
    if (rest.startsWith('#')) {
      const newline = rest.indexOf('\n')
      if (newline === -1) break
      rest = rest.slice(newline + 1)
      continue
    }
    if (/^\\\r?\n/.test(rest)) { rest = rest.replace(/^\\\r?\n[ \t]*/, ''); continue }
    if (/^!\s/.test(rest)) { rest = rest.slice(1).trimStart(); continue }
    const unredirected = trimRedirections(rest)
    if (unredirected !== rest) {
      rest = unredirected.trimStart()
      if (rest === '') break
      continue
    }
    const cd = readCdPrefix(rest)
    if (cd !== null) { rest = cd; continue }
    const declared = readDeclaration(rest, vars)
    if (declared !== null) { rest = declared; continue }
    const assigned = readAssignment(rest)
    if (assigned !== null) {
      vars.set(assigned.name, assigned.value)
      rest = rest.slice(assigned.end).trimStart()
      continue
    }
    const wrapped = readWrapper(rest)
    if (wrapped !== null) { rest = wrapped; continue }
    break
  }
  if (rest === '' || rest.startsWith('#')) return 'shell'
  if (rest.startsWith('(') || rest.startsWith('{')) return 'shell'
  const head = readWord(rest)
  if (head === null) return 'shell'
  if (/^[A-Za-z_][A-Za-z0-9_-]*\($/.test(head.word) && rest.slice(head.end).startsWith(')')) return 'shell'
  if (/^\s*\(\s*\)/.test(rest.slice(head.end))) return 'shell'
  const word = resolveBashWord(head.word, vars)
  if (word === null || word === '') return 'shell'
  const base = word.split('(')[0]
  if (BASH_HEADS.has(word) || BASH_HEADS.has(base)) return 'shell'
  return normalizeProgram(word)
}

function pwshProgram(cmd: string, vars = new Map<string, string | null>()): string {
  if (cmd.trim() === '') return ''
  let rest = cmd.trimStart()
  for (let guard = 0; guard < 32 && rest !== ''; guard++) {
    rest = rest.replace(/^[\s;]+/, '')
    if (rest === '') break
    if (rest.startsWith('#')) {
      const newline = rest.indexOf('\n')
      if (newline === -1) break
      rest = rest.slice(newline + 1)
      continue
    }
    if (rest.startsWith('<#')) {
      const end = rest.indexOf('#>', 2)
      rest = end === -1 ? '' : rest.slice(end + 2).trimStart()
      continue
    }
    const unredirected = trimRedirections(rest)
    if (unredirected !== rest) {
      rest = unredirected.trimStart()
      if (rest === '') break
      continue
    }
    const cd = readPwshCdPrefix(rest)
    if (cd !== null) { rest = cd; continue }
    if (/^\s*\[[^\]]+\]::[A-Za-z_][A-Za-z0-9_.]*\s*(?:\+|-|\*|\/|%|\?\?)?=/.test(rest)) {
      rest = rest.slice(skipPwshStatement(rest, 0)).trimStart()
      continue
    }
    const assigned = readPwshAssignment(rest)
    if (assigned !== null) {
      vars.set(assigned.name, assigned.value)
      rest = rest.slice(assigned.end).trimStart()
      continue
    }
    break
  }
  if (rest === '' || rest.startsWith('#')) return 'pwsh'
  let invoked = false
  const call = /^&\s*/.exec(rest)
  if (call !== null) {
    invoked = true
    rest = rest.slice(call[0].length)
  } else {
    const dot = /^\.\s+/.exec(rest)
    if (dot !== null) {
      invoked = true
      rest = rest.slice(dot[0].length)
    }
  }
  if (rest === '') return 'pwsh'
  const quoted = rest.startsWith('"') || rest.startsWith("'")
  const head = readWord(rest)
  if (head === null) return 'pwsh'
  if (head.word.startsWith('(') || head.word.startsWith('[') || head.word.startsWith('{') || head.word.startsWith('@')) return 'pwsh'
  const bareNumber = /^\d+(?:\.\d+)?(?:\.\.\d+(?:\.\d+)?)?$/.test(head.word)
  if (!invoked && (quoted || head.word.startsWith('$') || head.word.startsWith('!') || bareNumber || /^-(?:not|join|split)\b/i.test(head.word))) return 'pwsh'
  const word = resolvePwshWord(head.word, vars)
  if (word === null || word === '') return 'pwsh'
  const base = word.split('(')[0].toLowerCase()
  if (PWSH_HEADS.has(word.toLowerCase()) || PWSH_HEADS.has(base)) return 'pwsh'
  return normalizeProgram(word)
}

export function headProgramOf(cmd: string, dialect: CommandDialect = 'bash'): string {
  return programOfText(cmd, dialect)
}

export function programOfCommand(tool: CommandTool, cmd: string): string {
  if (tool === 'run_code') return 'run_code'
  const head = headProgramOf(cmd, tool)
  return head === '' ? (tool === 'pwsh' ? 'pwsh' : 'shell') : head
}

const PROGRAM_SCAN_CHARS = 4096

export function commandProgramOf(tool: string | undefined, raw: unknown): string | null {
  const cmdTool = commandTool(tool)
  if (cmdTool === null) return null
  const parsed = commandArgsOf(cmdTool, raw, PROGRAM_SCAN_CHARS)
  return parsed === null ? null : programOfCommand(cmdTool, parsed.cmd)
}

function programOfText(text: string, dialect: CommandDialect, vars = new Map<string, string | null>()): string {
  return dialect === 'pwsh' ? pwshProgram(text, vars) : bashProgram(text, vars)
}

export function programsOfCommand(cmd: string, dialect: CommandDialect = 'bash'): string[] {
  if (cmd.trim() === '') return []
  const fallback = dialect === 'pwsh' ? 'pwsh' : 'shell'
  const head = headProgramOf(cmd, dialect)
  const vars = new Map<string, string | null>()
  const parsed: string[] = []
  for (const segment of commandSegments(cmd, dialect)) {
    const program = programOfText(segment.text, dialect, vars)
    const navigation = dialect === 'bash' ? program === 'cd' : /^(?:cd|Set-Location|sl)$/i.test(program)
    if (navigation && (segment.separator === '&&' || segment.separator === ';' || segment.separator === '\n')) continue
    if (program !== fallback) parsed.push(program)
  }
  const out = [head]
  if (head !== fallback) {
    const first = parsed.indexOf(head)
    if (first >= 0) parsed.splice(first, 1)
  }
  return out.concat(parsed)
}

export interface CommandShape {
  lines: number
  heredoc: boolean
  inline: boolean
}

export function shapeOfCmd(cmd: string): CommandShape {
  let lines = 1
  for (let i = 0; i < cmd.length; i++) if (cmd[i] === '\n') lines++
  return {
    lines,
    heredoc: /<<-?\s*['"]?\w/.test(cmd),
    inline: /(?:^|[|;&]\s*)(?:node|deno|bun|python3?|ruby|perl|php)\s+(?:[^\n|;&]*\s)?-[ec]\s/.test(cmd),
  }
}
