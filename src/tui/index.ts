/** The terminal (dsh-TUI) half: loaded only by the host half when a dsh-TUI session-data service exists (host/terminal.ts). The
 * factories and view models are exported for headless harnesses that mount the surfaces over fixture data. */

export { COMMAND_NAMES, PANEL_ID, SCENE_ID, mountTerminal, sourceOf, type TerminalOptions } from './mount'
export { createContextCompact, createContextPanel, type PanelDeps } from './panel'
export {
  SCENE_TABS, createContextScene, initialSceneState, sceneDefaultsOf, sceneKey, sceneTabOf,
  type SceneCounts, type SceneDefaults, type SceneDeps, type SceneEffect, type SceneState, type SceneTab,
} from './scene'
export { createContextSource, createDetailReader, type ContextData, type ContextSource, type DetailReader } from './source'
export {
  eventRows, fileRows, headlineText, legendItems, nodeLabel, occupancyBars, occupancyOf, panelLayout, truncateStart, wrapCells,
  type EventRow, type FileRow, type Occupancy,
} from './model'
export { stepBrief, trendColumns, visibleRange, type TrendColumn } from './trend'
export { PREVIEW_INDENT, browserRows, browserView, type BrowserRow, type BrowserView } from './browser'
export { sessionRows, timingRows, tokenRows } from './stats'
export { kitOf, surfaceFactsOf, type HostUsage, type SurfaceFacts } from './detect'
export { langOf, translatorOf } from './i18n'
export type * from './hostTypes'
