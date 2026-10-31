import type { ReactElement } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

export type IconComponent = (props: IconProps) => ReactElement | null

const ns = primitives as unknown as Record<string, unknown>

function exportOf(name: string, source: Record<string, unknown>): unknown {
  try {
    return source[name]
  } catch {
    return undefined
  }
}

export function resolveIcon(name: string, source: Record<string, unknown> = ns): IconComponent {
  const found = exportOf(name, source)
  return typeof found === 'function' ? found as IconComponent : () => null
}

export const IconBranch = resolveIcon('IconBranchOutlineRegular')
export const IconPlus = resolveIcon('IconPlusOutlineRegular')
export const IconCheck = resolveIcon('IconCheckOutlineRegular')
export const IconCopy = resolveIcon('IconCopyOutlineRegular')
export const IconClose = resolveIcon('IconCloseOutlineRegular')
export const IconSettings = resolveIcon('IconSettingsOutlineMedium')
export const IconChevronDown = resolveIcon('IconChevronDownOutlineMedium')
export const IconChevronUp = resolveIcon('IconChevronUpOutlineMedium')
export const IconSearch = resolveIcon('IconSearchOutlineRegular')
export const IconShare = resolveIcon('IconShareOutlineRegular')
export const IconData = resolveIcon('IconDataOutlineRegular')
export const IconDatabase = resolveIcon('IconDatabaseOutlineRegular')
export const IconClock = resolveIcon('IconClockOutlineRegular')
export const IconGauge = resolveIcon('IconGaugeOutlineRegular')
export const IconCompareSplit = resolveIcon('IconCompareSplitOutlineRegular')
export const IconBrowse = resolveIcon('IconBrowseOutlineRegular')
export const IconContextInjection = resolveIcon('IconContextInjectionOutlineRegular')
export const IconFolderOpen = resolveIcon('IconFolderOpenOutlineRegular')
export const IconApi = resolveIcon('IconApiOutlineRegular')
export const IconInspect = resolveIcon('IconInspectOutlineRegular')
export const IconPlugin = resolveIcon('IconPluginPinwheelOutlineRegular')
export const IconSkill = resolveIcon('IconSkillOutlineRegular')

export interface FileGlyphProps {
  path?: string
  kind?: string
  size?: number
  className?: string
}

export type FileGlyphComponent = (props: FileGlyphProps) => ReactElement | null

export function resolveFileGlyph(source: Record<string, unknown> = ns): FileGlyphComponent {
  const found = exportOf('FileTypeIcon', source)
  return typeof found === 'function' ? found as FileGlyphComponent : () => null
}

export const FileTypeGlyph = resolveFileGlyph()
