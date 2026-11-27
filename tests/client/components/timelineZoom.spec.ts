import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  ZOOM_CAP_FLOOR,
  ZOOM_FIT,
  ZOOM_MAX,
  ZOOM_PITCH_PX,
  anchoredScrollLeft,
  clampZoom,
  maxZoomOf,
  wheelZoomFactor,
  zoomAnchorOf,
  zoomLabelOf,
} from '../../../src/client/components/timelineZoom'
import { WHEEL_LINE_PX, wheelDeltaPx } from '../../../src/client/wheel'

describe('timelineZoom', () => {

describe('wheel normalization', () => {
  test('turns pixel, line and page deltas into pixels', () => {
    assert.equal(wheelDeltaPx(120, 0, 400), 120)
    assert.equal(wheelDeltaPx(3, 1, 400), 3 * WHEEL_LINE_PX)
    assert.equal(wheelDeltaPx(1, 2, 400), 400)
  })

  test('maps the wheel direction onto a multiplicative factor, sharper for line deltas', () => {
    assert.equal(wheelZoomFactor(-120, 0, 400), Math.exp(0.18))
    assert.ok(wheelZoomFactor(120, 0, 400) < 1)
    assert.ok(wheelZoomFactor(-3, 1, 400) > wheelZoomFactor(-3, 0, 400))
  })
})

describe('zoom bounds', () => {
  test('caps a dense history at the readable pitch, floors a sparse one, and keeps the hard ceiling', () => {
    assert.equal(maxZoomOf(0, 100), ZOOM_MAX)
    assert.equal(maxZoomOf(400, 0), ZOOM_MAX)
    assert.equal(maxZoomOf(400, 2), ZOOM_CAP_FLOOR)
    assert.equal(maxZoomOf(1000, 1), ZOOM_CAP_FLOOR)
    assert.equal(maxZoomOf(400, 100), ZOOM_PITCH_PX * 100 / 400)
    assert.equal(maxZoomOf(100, 10_000), ZOOM_MAX)
  })

  test('clamps the factor into the supported band', () => {
    assert.equal(clampZoom(0.5, 4), ZOOM_FIT)
    assert.equal(clampZoom(9, 4), 4)
    assert.equal(clampZoom(2, 4), 2)
    assert.equal(clampZoom(2, 0.5), ZOOM_FIT)
  })

  test('prints a compact factor label', () => {
    assert.equal(zoomLabelOf(1.24), '×1.2')
    assert.equal(zoomLabelOf(3), '×3')
  })
})

describe('cursor anchoring', () => {
  test('records the cursor fraction and resolves the scroll that keeps it in place', () => {
    const anchor = zoomAnchorOf(150, 100, 500)
    assert.deepEqual(anchor, { frac: 0.5, vx: 100 })
    assert.equal(anchoredScrollLeft(anchor, 1000, 500), 400)
    assert.equal(anchoredScrollLeft(zoomAnchorOf(0, 0, 500), 1000, 500), 0)
    assert.equal(anchoredScrollLeft(zoomAnchorOf(400, 500, 500), 1000, 500), 500)
    assert.equal(anchoredScrollLeft(zoomAnchorOf(0, 0, 0), 0, 500), 0)
  })

  test('keeps the fraction inside the content for a pointer outside the plot', () => {
    assert.equal(zoomAnchorOf(-40, -20, 500).frac, 0)
    assert.equal(zoomAnchorOf(999, 20, 500).frac, 1)
  })
})
})
