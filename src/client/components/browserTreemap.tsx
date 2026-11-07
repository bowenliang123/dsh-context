import { useRef, useState, type CSSProperties, type ReactElement } from 'react'
import type { Assembled } from '../assemble'
import { CAT_COLOR } from '../categories'
import type { ViewKit } from '../viewkit'
import { mapOf, squarify, type MapBlock, type MapCat } from '../treemap'
import { TipBubble, tipShiftTransform, useTipShift } from './tip'
import { useElementSize } from './useElementMetrics'

export interface BrowserTreemapProps {
  view: Assembled
  openCat: string | null
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  onPickCat: (cat: string) => void
  onPickBlock: (cat: string, block: MapBlock) => void
}

export function MapIcon(): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.2" y="1.2" width="8" height="6" rx="1" />
      <rect x="10.6" y="1.2" width="4.2" height="6" rx="1" />
      <rect x="1.2" y="8.6" width="5" height="6.2" rx="1" />
      <rect x="7.6" y="8.6" width="7.2" height="6.2" rx="1" />
    </svg>
  )
}

const FALLBACK_W = 640
const FALLBACK_H = 240

const GAP = 2
const FRAME = 1
const PAD = 2
const HEAD = 16
const HEAD_MIN_W = 56
const HEAD_MIN_H = 40
const LABEL_MIN_W = 42
const LABEL_MIN_H = 22
const NUM_MIN_H = 36
const MIN_RECT = 6
const TIP_FLIP_Y = 64

interface LaidBlock {
  b: MapBlock
  sx: number
  sy: number
  sw: number
  sh: number
  px: number
  py: number
}

interface LaidCat {
  c: MapCat
  x: number
  y: number
  w: number
  h: number
  showHead: boolean
  blocks: LaidBlock[]
}

interface MapTip {
  head: string
  fig: string
  note?: string
  cx: number
  top: number
  bottom: number
}

function layoutTree(cats: MapCat[], w: number, h: number): LaidCat[] {
  const out: LaidCat[] = []
  for (const lc of squarify(cats, { x: 0, y: 0, w, h })) {
    const rw = lc.rect.w - GAP
    const rh = lc.rect.h - GAP
    if (rw < MIN_RECT || rh < MIN_RECT) continue
    const showHead = rw >= HEAD_MIN_W && rh >= HEAD_MIN_H
    const headH = showHead ? HEAD : 0
    const iw = rw - 2 * FRAME - 2 * PAD
    const ih = rh - 2 * FRAME - headH - 2 * PAD
    const blocks: LaidBlock[] = []
    if (iw >= MIN_RECT && ih >= MIN_RECT) {
      for (const lb of squarify(lc.item.blocks, { x: 0, y: 0, w: iw, h: ih })) {
        const bw = lb.rect.w - GAP
        const bh = lb.rect.h - GAP
        if (bw < MIN_RECT || bh < MIN_RECT) continue
        blocks.push({
          b: lb.item,
          sx: PAD + lb.rect.x,
          sy: headH + PAD + lb.rect.y,
          sw: bw,
          sh: bh,
          px: lc.rect.x + GAP / 2 + FRAME + PAD + lb.rect.x,
          py: lc.rect.y + GAP / 2 + FRAME + headH + PAD + lb.rect.y,
        })
      }
    }
    out.push({ c: lc.item, x: lc.rect.x + GAP / 2, y: lc.rect.y + GAP / 2, w: rw, h: rh, showHead, blocks })
  }
  return out
}

export function makeBrowserTreemap(kit: ViewKit): (props: BrowserTreemapProps) => ReactElement {
  const { t, fmt, catLabel } = kit
  return function BrowserTreemap(props: BrowserTreemapProps): ReactElement {
    const wrapRef = useRef<HTMLDivElement | null>(null)
    const tipRef = useRef<HTMLDivElement | null>(null)
    const [tipKey, setTipKey] = useState<string | null>(null)
    const size = useElementSize(wrapRef, 'content')

    const cats = mapOf(props.view, t, catLabel)
    let total = 0
    for (const c of cats) total += c.tokens

    const tree = layoutTree(cats, size.width > 0 ? size.width : FALLBACK_W, size.height > 0 ? size.height : FALLBACK_H)

    let tip: MapTip | null = null
    if (tipKey !== null) {
      const catHit = tree.find(lc => 'cat:' + lc.c.cat === tipKey)
      let blockHit: LaidBlock | null = null
      if (catHit === undefined) {
        for (const lc of tree) {
          blockHit = lc.blocks.find(lb => lb.b.key === tipKey) ?? null
          if (blockHit !== null) break
        }
      }
      if (catHit !== undefined) {
        const pct = Math.round(catHit.c.tokens / total * 100)
        let items = 0
        for (const b of catHit.c.blocks) items += b.count
        tip = {
          head: catLabel(catHit.c.cat),
          fig: `≈${fmt(catHit.c.tokens)} · ${pct}% ${t('overview.ofUsed')}`,
          note: t('browser.items', { n: items }),
          cx: catHit.x + catHit.w / 2,
          top: catHit.y,
          bottom: catHit.y + catHit.h,
        }
      } else if (blockHit !== null) {
        const b = blockHit.b
        const pct = Math.round(b.tokens / total * 100)
        tip = {
          head: b.count > 1 ? `${b.label} ×${b.count}` : b.label,
          fig: `≈${fmt(b.tokens)} · ${pct}% ${t('overview.ofUsed')}`,
          cx: blockHit.px + blockHit.sw / 2,
          top: blockHit.py,
          bottom: blockHit.py + blockHit.sh,
        }
      }
    }

    const tipShift = useTipShift(wrapRef, tipRef, tip === null ? null : { unit: 'px', value: tip.cx })
    const flip = tip !== null && tip.top < TIP_FLIP_Y
    const shiftX = tipShiftTransform(tipShift)
    const tipStyle = tip === null
      ? { left: '0px', top: '0px' }
      : {
        left: `${Math.round(tip.cx)}px`,
        top: flip ? `${Math.round(tip.bottom + 4)}px` : `${Math.round(tip.top - 4)}px`,
        transform: flip ? shiftX : shiftX + ' translateY(-100%)',
      }

    const enter = (key: string, cat: string) => (): void => {
      setTipKey(key)
      if (props.onHoverKey !== undefined) props.onHoverKey(cat)
    }
    const leave = (): void => {
      setTipKey(null)
      if (props.onHoverKey !== undefined) props.onHoverKey(null)
    }

    if (cats.length === 0) {
      return <div className="lc-map-empty">{t('browser.mapEmpty')}</div>
    }

    return (
      <div className={'lc-map' + (tip !== null ? ' lc-map-dim' : '')} ref={wrapRef} onMouseLeave={leave}>
        {tree.map((lc) => {
          const c = lc.c
          const frameCls = 'lc-map-cat'
            + (props.openCat === c.cat ? ' lc-map-cat-open' : '')
            + (props.hoverKey === c.cat ? ' lc-map-cat-on' : '')
          return (
            <div
              key={c.cat}
              className={frameCls}
              style={{ left: lc.x, top: lc.y, width: lc.w, height: lc.h, '--lc-map-c': CAT_COLOR[c.cat] } as CSSProperties}
            >
              {lc.showHead
                ? (
                  <button
                    type="button"
                    className="lc-map-cat-head"
                    onMouseEnter={enter('cat:' + c.cat, c.cat)}
                    onFocus={enter('cat:' + c.cat, c.cat)}
                    onBlur={leave}
                    onClick={() => { props.onPickCat(c.cat) }}
                  >
                    <span className="lc-map-cat-label">{catLabel(c.cat)}</span>
                    <b>{'≈' + fmt(c.tokens)}</b>
                  </button>
                )
                : null}
              {lc.blocks.map((lb) => {
                const b = lb.b
                const alpha = Math.round(14 + 30 * Math.sqrt(b.tokens / c.tokens))
                const on = tipKey === b.key
                return (
                  <button
                    key={b.key}
                    type="button"
                    className={'lc-map-block' + (on ? ' lc-map-block-on' : '')}
                    style={{
                      left: lb.sx,
                      top: lb.sy,
                      width: lb.sw,
                      height: lb.sh,
                      '--lc-map-a': `${alpha}%`,
                    } as CSSProperties}
                    onMouseEnter={enter(b.key, c.cat)}
                    onFocus={enter(b.key, c.cat)}
                    onBlur={leave}
                    onClick={() => { props.onPickBlock(c.cat, b) }}
                  >
                    {lb.sw >= LABEL_MIN_W && lb.sh >= LABEL_MIN_H
                      ? (
                        <span className="lc-map-label">
                          {b.label}
                          {b.count > 1 ? <em>{'×' + String(b.count)}</em> : null}
                        </span>
                      )
                      : null}
                    {lb.sw >= LABEL_MIN_W && lb.sh >= NUM_MIN_H ? <span className="lc-map-num">{'≈' + fmt(b.tokens)}</span> : null}
                  </button>
                )
              })}
            </div>
          )
        })}
        <TipBubble
          tipRef={tipRef}
          className="lc-tip lc-map-tip"
          onClass="lc-map-tip-on"
          shown={tip !== null}
          style={tipStyle}
          head={tip?.head}
          figure={tip?.fig}
          note={tip?.note}
        />
      </div>
    )
  }
}
