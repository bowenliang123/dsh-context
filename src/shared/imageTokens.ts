const PATCH_SIZE = 14
const DOWNSAMPLE_RATIO = 3
export const MAX_IMAGE_TOKENS = 1024
const MIN_PIXELS = 544 * 544
const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO

const intDiv = (value: number, divisor: number): number => Math.floor(value / divisor)
const ceilDiv = (value: number, divisor: number): number => Math.floor((value + divisor - 1) / divisor)

interface GridResize {
  gridHeight: number
  gridWidth: number
  bestHeight: number
  bestWidth: number
  numTokens: number
}

function gridTokens(gridHeight: number, gridWidth: number): number {
  return gridHeight * (gridWidth + 1) + 2
}

function gridCells(paddedLength: number): number {
  return ceilDiv(intDiv(paddedLength, PATCH_SIZE), DOWNSAMPLE_RATIO)
}

function solveResizeRatio(height: number, width: number, budget: number): GridResize {
  const aspect = height / width
  const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5
  const idealGridHeight = idealGridWidth * aspect
  let bestHeight: number
  let bestWidth: number
  if (idealGridWidth < 1) {
    const solvedGridWidth = 1
    const solvedGridHeight = intDiv(budget - 2, solvedGridWidth + 1)
    bestWidth = solvedGridWidth * CELL_SIZE
    bestHeight = solvedGridHeight * CELL_SIZE
  } else if (idealGridHeight < 1) {
    const solvedGridHeight = 1
    const solvedGridWidth = intDiv(budget - 2, solvedGridHeight) - 1
    bestWidth = solvedGridWidth * CELL_SIZE
    bestHeight = solvedGridHeight * CELL_SIZE
  } else {
    const solvedGridWidth = Math.trunc(idealGridWidth)
    const solvedGridHeight = Math.trunc(idealGridHeight)
    const scale = Math.min(solvedGridWidth * CELL_SIZE / width, solvedGridHeight * CELL_SIZE / height)
    bestWidth = Math.trunc(width * scale / PATCH_SIZE) * PATCH_SIZE
    bestHeight = Math.trunc(height * scale / PATCH_SIZE) * PATCH_SIZE
  }
  const gridHeight = gridCells(bestHeight)
  const gridWidth = gridCells(bestWidth)
  return { gridHeight, gridWidth, bestHeight, bestWidth, numTokens: gridTokens(gridHeight, gridWidth) }
}

function safeResize(height: number, width: number, paddedHeight: number, paddedWidth: number): GridResize {
  const gridHeight = gridCells(paddedHeight)
  const gridWidth = gridCells(paddedWidth)
  const direct: GridResize = {
    gridHeight,
    gridWidth,
    bestHeight: paddedHeight,
    bestWidth: paddedWidth,
    numTokens: gridTokens(gridHeight, gridWidth),
  }
  if (direct.numTokens <= MAX_IMAGE_TOKENS) return direct
  const solved = solveResizeRatio(height, width, MAX_IMAGE_TOKENS)
  /* v8 ignore next 3 */
  if (solved.numTokens > MAX_IMAGE_TOKENS) {
    throw new Error(`image tokens: no grid fits ${width}x${height}`)
  }
  return solved
}

function resizeOnce(width: number, height: number): GridResize {
  let scaledWidth = width
  let scaledHeight = height
  const pixels = scaledWidth * scaledHeight
  if (pixels < MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(MIN_PIXELS / pixels)
    scaledWidth = Math.trunc(scaledWidth * scale)
    scaledHeight = Math.trunc(scaledHeight * scale)
  }
  const paddedWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE
  const paddedHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE
  return safeResize(scaledHeight, scaledWidth, paddedHeight, paddedWidth)
}

function sameResize(a: GridResize, b: GridResize): boolean {
  return a.gridHeight === b.gridHeight
    && a.gridWidth === b.gridWidth
    && a.bestHeight === b.bestHeight
    && a.bestWidth === b.bestWidth
    && a.numTokens === b.numTokens
}

export function estimateImageTokens(width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  try {
    let result = resizeOnce(width, height)
    for (let iteration = 1; iteration < 10; iteration += 1) {
      const next = resizeOnce(result.bestWidth, result.bestHeight)
      if (sameResize(next, result)) return result.numTokens
      result = next
    }
    /* v8 ignore next */
    return null
  } catch {
    /* v8 ignore next */
    return null
  }
}
