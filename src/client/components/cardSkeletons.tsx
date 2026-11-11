import type { ReactElement } from 'react'
import { IconApi, IconBrowse, IconContextInjection, IconFolderOpen } from '../primitives'
import type { ViewKit } from '../viewkit'
import { EVENT_KINDS } from './events'
import { LoadingLane, SkeletonRows } from './skeleton'

export interface CardSkeletons {
  Browser: () => ReactElement
  Events: () => ReactElement
  Files: () => ReactElement
  Commands: () => ReactElement
}

const FILE_KINDS = ['all', 'read', 'write', 'search', 'image'] as const

const FILE_SORTS = ['count', 'lines', 'latest', 'path', 'name'] as const

const COMMAND_FILTERS = ['all', 'failed', 'slow', 'background'] as const

export function makeCardSkeletons(kit: ViewKit): CardSkeletons {
  const { t } = kit
  function Browser(): ReactElement {
    return (
      <div className="lc-card lc-br" aria-hidden="true">
        <div className="lc-br-head">
          <div className="lc-card-title">
            <span className="lc-card-title-text">
              <IconBrowse size={14} />
              {t('browser.title')}
            </span>
          </div>
        </div>
        <div className="lc-br-scroll"><SkeletonRows rows={8} /></div>
      </div>
    )
  }
  function Events(): ReactElement {
    return (
      <div className="lc-card lc-events-card lc-col flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconContextInjection size={14} />
            {t('events.title')}
          </span>
          <div className="lc-kinds @max-[380px]/lc-card:flex-wrap">
            {EVENT_KINDS.map(k => (
              <span key={k} className="lc-gran-btn">
                {t('kind.' + k)}
                <span className="lc-kind-n">0</span>
              </span>
            ))}
          </div>
        </div>
        <LoadingLane />
      </div>
    )
  }
  function Files(): ReactElement {
    return (
      <div className="lc-card lc-fa-card lc-col flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconFolderOpen size={14} />
            {t('files.title')}
          </span>
          <span className="lc-fa-meta"><span>{t('files.files', { n: 0 })}</span></span>
          <div className="lc-gran lc-fa-chips @max-[380px]/lc-card:flex-wrap">
            {FILE_KINDS.map(k => (
              <span key={k} className="lc-gran-btn">
                {t('files.kind.' + k)}
                <b className="lc-fa-n">0</b>
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="lc-fa-ctl">
            <span className="lc-searchbox"><span className="lc-skel-bar lc-skel-search" /></span>
            <span className="lc-gran lc-fa-sort">
              {FILE_SORTS.map(k => <span key={k} className="lc-gran-btn">{t('files.sort.' + k)}</span>)}
            </span>
          </div>
          <LoadingLane />
        </div>
      </div>
    )
  }
  function Commands(): ReactElement {
    return (
      <div className="lc-card lc-cmd-card lc-col flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconApi size={14} />
            {t('cmds.title')}
          </span>
          <div className="lc-gran lc-cmd-chips @max-[380px]/lc-card:flex-wrap">
            {COMMAND_FILTERS.map(f => (
              <span key={f} className="lc-gran-btn">
                {t('cmds.filter.' + f)}
                <b className="lc-fa-n">0</b>
              </span>
            ))}
          </div>
        </div>
        <LoadingLane className="lc-cmd-lane" />
      </div>
    )
  }
  return { Browser, Events, Files, Commands }
}
