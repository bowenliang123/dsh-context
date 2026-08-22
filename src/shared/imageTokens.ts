/**
 * Per-image token estimate for DeepSeek's vision model — a faithful port of
 * the official "图片 Token 计算器" (Image Token Calculator) shipped on the
 * DeepSeek API docs (https://api-docs.deepseek.com/zh-cn/quick_start/token_usage),
 * which implements the provider's own image→token conversion:
 *
 *   - every image is aspect-preserved rescaled before entering the model:
 *     below ~384×384 total pixels it is enlarged, above it is shrunk;
 *   - tokens follow the patch grid (patch 14px, downsample 3), so every
 *     image costs at least 117 and at most ~384 tokens (the documented cap).
 *
 * Verified against the docs calculator itself: 2048×1365→313, 800×600→341,
 * 2048×2048→349, 512×512→201, 100×100→117, 1920×1080→369, 400×900→249.
 * The DSH request pipeline's own 640k-pixel pre-resize does not change the
 * result (the provider formula rescales to the same patch grid), so the
 * durable attachment dimensions can be fed in directly.
 *
 * Pure math shared by the Host fold (message pricing) and the Client
 * (attachment card token badges) — no dependencies, never mutates.
 */

const PATCH_SIZE = 14
const DOWNSAMPLE_RATIO = 3
/** Documented per-image token cap ( DeepSeek vision guide ). */
const MAX_TOKENS = 384
const COMPRESS_PAD_TO = 4
const MAX_WH_RATIO = 8
/** ~384×384 total pixels: smaller images are enlarged before patching. */
const MIN_PIXELS = 147456

const floorDiv = (a: number, b: number): number => Math.floor(a / b)
const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b)

/** Token count of one patch grid (rows×cols) under the v4 layout rule. */
function gridTokens(rows: number, cols: number): number {
  let n = rows * (cols + 1) + 2
  if (rows % 2 === 1) n += cols + 1
  n += (ceilDiv(rows, 2) * (cols + 1) % 2) * 2
  return n
}

interface ResizeSolution {
  nLlmH: number
  nLlmW: number
  bestHeight: number
  bestWidth: number
  numTokens: number
}

/** Solve the largest in-grid resize whose token count fits `budget`. */
function solveResizeRatio(height: number, width: number, budget: number): ResizeSolution {
  const ratio = height / width
  const gridW = Math.sqrt((budget - 2) / ratio + 0.25) - 0.5
  const gridH = gridW * ratio
  const unit = PATCH_SIZE * DOWNSAMPLE_RATIO
  let bestHeight: number
  let bestWidth: number
  if (gridW < 1) {
    // Tall image: width collapses to one unit, height takes the budget.
    let rows = floorDiv(budget - 2, 2)
    if (rows % 2 === 1) rows -= 1
    bestWidth = unit
    bestHeight = rows * unit
  } else if (gridH < 2) {
    // Wide image: height collapses to two units, width takes the budget.
    const cols = floorDiv(budget - 2, 2) - 1
    if (cols <= 1) throw new Error('image tokens: budget too small to solve')
    bestHeight = 2 * unit
    bestWidth = cols * unit
  } else {
    const cols = Math.trunc(gridW)
    // The row grid carries the pairing constraint: odd counts round down.
    let rows = Math.trunc(gridH)
    if (rows % 2 === 1) rows -= 1
    const scale = Math.min(cols * unit / width, rows * unit / height)
    bestWidth = Math.trunc(width * scale / PATCH_SIZE) * PATCH_SIZE
    bestHeight = Math.trunc(height * scale / PATCH_SIZE) * PATCH_SIZE
  }
  const nLlmH = ceilDiv(floorDiv(bestHeight, PATCH_SIZE), DOWNSAMPLE_RATIO)
  const nLlmW = ceilDiv(floorDiv(bestWidth, PATCH_SIZE), DOWNSAMPLE_RATIO)
  return { nLlmH, nLlmW, bestHeight, bestWidth, numTokens: gridTokens(nLlmH, nLlmW) }
}

/** Resize so the patch grid fits the cap, then re-add the pad reserve. */
function safeResize(height: number, width: number, paddedHeight: number, paddedWidth: number): ResizeSolution {
  const nLlmH = ceilDiv(floorDiv(paddedHeight, PATCH_SIZE), DOWNSAMPLE_RATIO)
  const nLlmW = ceilDiv(floorDiv(paddedWidth, PATCH_SIZE), DOWNSAMPLE_RATIO)
  const pad = COMPRESS_PAD_TO - 1
  const budget = MAX_TOKENS - pad
  let result: ResizeSolution = {
    nLlmH, nLlmW, bestHeight: paddedHeight, bestWidth: paddedWidth,
    numTokens: gridTokens(nLlmH, nLlmW),
  }
  if (result.numTokens > budget) {
    result = solveResizeRatio(height, width, budget)
    let nextBudget = budget
    while (result.numTokens > budget) {
      nextBudget -= 1
      result = solveResizeRatio(height, width, nextBudget)
    }
  }
  result.numTokens += pad
  return result
}

function calcResizeInner(width: number, height: number): ResizeSolution {
  let w = width
  let h = height
  if (w > h * MAX_WH_RATIO) w = h * MAX_WH_RATIO
  const pixels = w * h
  if (pixels < MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(MIN_PIXELS / pixels)
    w = Math.trunc(w * scale)
    h = Math.trunc(h * scale)
  }
  const paddedWidth = ceilDiv(w, PATCH_SIZE) * PATCH_SIZE
  const paddedHeight = ceilDiv(h, PATCH_SIZE) * PATCH_SIZE
  return safeResize(h, w, paddedHeight, paddedWidth)
}

/**
 * Estimate the tokens one image consumes in a DeepSeek vision request, from
 * its pixel dimensions. Returns null for non-positive/non-finite dimensions
 * or when the official iteration fails to converge — callers fall back to
 * the generic structural price.
 */
export function estimateImageTokens(width: number, height: number): number | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  try {
    let result = calcResizeInner(width, height)
    for (let i = 1; i < 10; i++) {
      const next = calcResizeInner(result.bestWidth, result.bestHeight)
      if (next.nLlmH === result.nLlmH && next.nLlmW === result.nLlmW
        && next.bestHeight === result.bestHeight && next.bestWidth === result.bestWidth
        && next.numTokens === result.numTokens) return result.numTokens
      result = next
    }
    return null
  } catch {
    return null
  }
}
