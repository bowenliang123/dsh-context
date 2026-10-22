/** Structural mirrors of the dsh-TUI plugin surfaces this module consumes; dsh-TUI is never a dependency, every face is
 * feature-detected at runtime (detect.ts), and React is always the host's injected instance. */

import type * as React from 'react'
import type { ComponentType, ReactNode } from 'react'

export type HostReact = Pick<typeof React,
  'createElement' | 'useState' | 'useEffect' | 'useMemo' | 'useRef' | 'useSyncExternalStore'>

/** A categorical palette slot (`chart1`… cycling) or a semantic theme key — never a literal color. */
export type ChartColor = number | string

export interface BoxProps {
  flexDirection?: 'row' | 'column'
  width?: number | string
  height?: number
  flexGrow?: number
  flexShrink?: number
  paddingX?: number
  paddingLeft?: number
  marginTop?: number
  columnGap?: number
  justifyContent?: 'flex-start' | 'space-between' | 'flex-end'
  overflow?: 'hidden' | 'visible'
  children?: ReactNode
}

export interface TextProps {
  color?: string
  dimColor?: boolean
  bold?: boolean
  inverse?: boolean
  wrap?: 'wrap' | 'truncate-end' | 'truncate-middle' | 'truncate-start'
  children?: ReactNode
}

export interface StackedBarSegment {
  value: number
  color: ChartColor
  hatch?: boolean
}

export interface StackedBarProps {
  segments: readonly StackedBarSegment[]
  width: number
  capacity?: number
  emptyColor?: string
}

export interface ColumnChartColumn {
  segments: readonly { value: number; color: ChartColor }[]
  marker?: string
  markerColor?: ChartColor
}

export interface ColumnChartProps {
  columns: readonly ColumnChartColumn[]
  height: number
  columnWidth?: number
  gap?: number
  max?: number
  selected?: number
}

export interface LegendItem {
  color: ChartColor
  label: string
  value?: string
}

export interface LegendProps {
  items: readonly LegendItem[]
  width: number
  maxRows?: number
}

export type TableCell = string | number | { text: string; color?: ChartColor; bold?: boolean }

export interface TableColumn {
  key: string
  title?: string
  width?: number
  grow?: number
  align?: 'left' | 'right'
  color?: ChartColor
}

export interface TableProps {
  columns: readonly TableColumn[]
  rows: readonly Readonly<Record<string, TableCell | undefined>>[]
  width: number
  selected?: number
  header?: boolean
}

export interface ChartFormat {
  relativeTime: (at: number, now?: number) => string
  cells: (text: string) => number
  truncate: (text: string, cells: number) => string
}

/** The chart-kit members this plugin draws with (dsh-TUI docs/plugin-ui-kit-design.md §1). */
export interface ChartKit {
  StackedBar: ComponentType<StackedBarProps>
  ColumnChart: ComponentType<ColumnChartProps>
  Legend: ComponentType<LegendProps>
  Table: ComponentType<TableProps>
  format: ChartFormat
  seriesColor: (index: number) => string
  hashSeries: (key: string) => number
}

export interface BaseUi {
  Box: ComponentType<BoxProps>
  Text: ComponentType<TextProps>
}

export type SurfaceUi = BaseUi & Partial<ChartKit>

export interface PanelKeyFlags {
  upArrow?: boolean
  downArrow?: boolean
  return_?: boolean
}

export interface PanelKeyEvent {
  input: string
  key: PanelKeyFlags
  preventDefault: () => void
}

/** The panel/scene host verbs; every member is optional because older hosts lack them. */
export interface SurfaceHost {
  snapshot?: () => unknown
  onKey?: (listener: (event: PanelKeyEvent) => void) => () => void
  openFile?: (path: string, options?: { line?: number }) => boolean
  toast?: (text: string) => boolean
  useParams?: () => unknown
}

export interface PanelProps {
  React: HostReact
  ui: SurfaceUi
  host: SurfaceHost
  width: number
  height: number
  focused: boolean
}

export interface CompactProps {
  React: HostReact
  ui: Pick<BaseUi, 'Box' | 'Text'> & Partial<Pick<ChartKit, 'StackedBar'>>
  width: number
  /** The panel's curated snapshot (with `usage`), on hosts that hand it to compact rows. */
  snapshot?: () => unknown
}

export interface SceneKey {
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  return?: boolean
  escape?: boolean
  tab?: boolean
  shift?: boolean
  home?: boolean
  end?: boolean
  pageUp?: boolean
  pageDown?: boolean
}

export interface SceneUi extends SurfaceUi {
  useInput: (handler: (input: string, key: SceneKey) => void) => void
  useTerminalSize: () => { columns: number; rows: number }
}

export interface SceneProps {
  React: HostReact
  ui: SceneUi
  close: () => void
  host?: SurfaceHost
}

export interface ProjectionWatch {
  readonly sessionId: string | undefined
  read: () => unknown
  subscribe: (listener: () => void) => () => void
}

export interface SessionDataService {
  watchProjection: (key: string) => ProjectionWatch | undefined
}

export interface PanelDescriptor {
  apiVersion: 1
  id: string
  title: string
  icon?: string
  minColumns?: number
  component: (props: PanelProps) => ReactNode
  compact?: { maxRows: 1 | 2 | 3; component: (props: CompactProps) => ReactNode }
}

export interface PanelsService {
  register: (descriptor: PanelDescriptor) => (() => void) | undefined
}

export interface ScenesService {
  register: (descriptor: { id: string; title?: string; component: (props: SceneProps) => ReactNode }) => () => void
  open: (id: string, params?: unknown) => boolean
}

export type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

export interface CommandDefinition {
  name: string
  description: string
  handler: (invocation: { rawInput: string }) => CommandResult
}

export interface CommandsService {
  register: (definition: CommandDefinition) => () => void
}

export interface PluginHostService {
  registerCommand?: (pluginCtx: unknown, definition: CommandDefinition) => () => void
}
