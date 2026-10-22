/** Terminal-only strings, layered over the client dictionaries so shared labels (categories, events, stats) stay one source. */

import { DICT_EN, DICT_ZH, type Translate } from '../client/i18n'

export const TUI_ZH = {
  'tui.title': '上下文',
  'tui.waiting': '等待第一次模型请求…',
  'tui.partial': '本会话的明细暂不可读，仅显示汇总',
  'tui.unsupported': 'dsh {current} 低于支持的 {minimum}，升级 dsh 后可查看上下文',
  'tui.needsKit': '需要带插件 UI 套件的 dsh-TUI',
  'tui.tab.overview': '概览',
  'tui.tab.trend': '趋势',
  'tui.tab.browser': '浏览',
  'tui.tab.events': '事件',
  'tui.tab.files': '文件',
  'tui.hint.overview': '只读摘要',
  'tui.hint.scene': 'Tab/1-5 切换 · Esc 关闭',
  'tui.hint.trend': '←→ 选择 · t 步/轮',
  'tui.hint.browser': '↑↓/PgUp/PgDn 移动 · ↵ 展开 · l 实时/选中步',
  'tui.hint.events': '↑↓/PgUp/PgDn 移动 · f 筛选',
  'tui.hint.files': '↑↓/PgUp/PgDn 移动 · ↵ 打开 · s 排序',
  'tui.filter': '筛选：{kind}',
  'tui.sort': '排序：{sort}',
  'tui.brief.user': '用户',
  'tui.brief.in': '输入',
  'tui.brief.response': '回复',
  'tui.vsPrev': '较上一步 {n}',
  'tui.openFailed': '无法打开 {path}',
}

export const TUI_EN: Record<keyof typeof TUI_ZH, string> = {
  'tui.title': 'Context',
  'tui.waiting': 'Waiting for the first model request…',
  'tui.partial': 'This session’s detail is unreadable; showing the totals only',
  'tui.unsupported': 'dsh {current} is below the supported {minimum}; upgrade dsh to see the context',
  'tui.needsKit': 'Needs a dsh-TUI with the plugin UI kit',
  'tui.tab.overview': 'Overview',
  'tui.tab.trend': 'Trend',
  'tui.tab.browser': 'Browser',
  'tui.tab.events': 'Events',
  'tui.tab.files': 'Files',
  'tui.hint.overview': 'Read-only summary',
  'tui.hint.scene': 'Tab/1-5 switch · Esc close',
  'tui.hint.trend': '←→ select · t step/turn',
  'tui.hint.browser': '↑↓/PgUp/PgDn move · ↵ expand · l live/selected',
  'tui.hint.events': '↑↓/PgUp/PgDn move · f filter',
  'tui.hint.files': '↑↓/PgUp/PgDn move · ↵ open · s sort',
  'tui.filter': 'Filter: {kind}',
  'tui.sort': 'Sort: {sort}',
  'tui.brief.user': 'User',
  'tui.brief.in': 'In',
  'tui.brief.response': 'Response',
  'tui.vsPrev': 'vs prev {n}',
  'tui.openFailed': 'Cannot open {path}',
}

export type Lang = 'zh' | 'en'

export function langOf(value: unknown): Lang {
  return typeof value === 'string' && value.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

const translators: Partial<Record<Lang, Translate>> = {}

export function translatorOf(lang: Lang): Translate {
  const cached = translators[lang]
  if (cached !== undefined) return cached
  const dict: Record<string, string> = lang === 'zh' ? { ...DICT_ZH, ...TUI_ZH } : { ...DICT_EN, ...TUI_EN }
  const t: Translate = (key, params) => {
    let text = Object.hasOwn(dict, key) ? dict[key] : key
    if (params !== undefined) {
      for (const name of Object.keys(params)) text = text.split(`{${name}}`).join(String(params[name]))
    }
    return text
  }
  translators[lang] = t
  return t
}
