import type { Category, ContextHeaders, ContextTimeline } from '../../shared/types'
import type { AttachmentOpener, ContentFetcher, ConversationNodeLike, HeaderFetcher, ImageLoader } from '../services'
import type { DeltaFetcher, DetailState } from '../timelineSource'
import type { CatFocus } from './browserHelpers'

export interface ContextBrowserProps {
  locale?: string
  data: ContextTimeline
  headers: ContextHeaders | null
  convNodes?: readonly ConversationNodeLike[]
  fetchContent?: ContentFetcher
  fetchHeader?: HeaderFetcher
  fetchDelta?: DeltaFetcher
  previewSeq?: number | null
  pinSeq?: number | null
  dna?: boolean
  onDnaChange?: (on: boolean) => void
  delta?: boolean
  onDeltaChange?: (on: boolean) => void
  nodeFocus?: { step: number | 'live'; key: string; cat: Category | 'system' | 'tools' } | null
  onNodeFocusHandled?: () => void
  catFocus?: CatFocus | null
  onCatFocusHandled?: () => void
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  onOpenCat?: (cat: string | null) => void
  loadImage?: ImageLoader
  openAttachment?: AttachmentOpener
  detailState?: DetailState
  onDetailRetry?: () => void
  session?: string
}
