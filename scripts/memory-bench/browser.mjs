import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright-core'
import { startBenchmarkWeb } from './webServer.mjs'
import { option } from './options.mjs'

const v2 = option('v2', '.tmp/memory-bench/baseline-plugin')
const v3 = option('v3', '.tmp/memory-bench/candidate-plugin')
const corpus = option('corpus', '.tmp/memory-bench/corpus/corpus-smoke')
const root = resolve(option('root', '.tmp/memory-bench/browser-final'))
const executablePath = option('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe')
const variants = option('variants', 'v2,v3').split(',')

async function dismissPreview(page) {
  const dialog = page.getByRole('dialog', { name: '预览版说明', exact: true })
  if (await dialog.count() === 0) return
  await page.getByRole('button', { name: '继续', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
}

async function waitForComplete(page) {
  await page.waitForFunction(() => {
    const match = document.body.innerText.match(/全部会话\s+(\d+)/)
    return match !== null && Number(match[1]) === 54
      && document.body.innerText.includes('轮次 2.3k')
      && document.body.innerText.includes('18.7k')
  }, undefined, { timeout: 120000 })
  await page.getByRole('button', { name: '选择自定义日期范围', exact: true }).waitFor({ state: 'visible' })
  await dismissPreview(page)
}

async function chooseRange(page) {
  await dismissPreview(page)
  await page.getByRole('button', { name: '选择自定义日期范围', exact: true }).evaluate(element => element.click())
  const dialog = page.getByRole('dialog', { name: '日期范围', exact: true })
  for (let index = 0; index < 48; index++) {
    if ((await dialog.innerText()).includes('2023年11月')) break
    await page.getByRole('button', { name: '上个月', exact: true }).evaluate(element => element.click())
    await page.waitForTimeout(20)
  }
  const start = page.locator('[role="gridcell"][aria-label="2023-11-01"]')
  assert.equal(await start.count(), 1)
  await start.evaluate(element => element.click())
  const end = page.locator('[role="gridcell"][aria-label="2023-11-30"]')
  assert.equal(await end.count(), 1)
  await end.evaluate(element => element.click())
  await page.waitForFunction(() => document.body.innerText.includes('2023-11-01') && document.body.innerText.includes('2023-11-30'))
}

async function memoryOf(cdp) {
  await cdp.send('HeapProfiler.collectGarbage')
  const [performance, dom] = await Promise.all([
    cdp.send('Performance.getMetrics'),
    cdp.send('Memory.getDOMCounters'),
  ])
  const metrics = Object.fromEntries(performance.metrics.map(entry => [entry.name, entry.value]))
  return {
    jsHeapUsedSize: metrics.JSHeapUsedSize,
    jsHeapTotalSize: metrics.JSHeapTotalSize,
    documents: dom.documents,
    nodes: dom.nodes,
    jsEventListeners: dom.jsEventListeners,
  }
}

async function openInsights(page, waitComplete = true) {
  await page.getByRole('button', { name: '上下文洞察', exact: true }).evaluate(element => element.click())
  if (waitComplete) {
    const fixed = await page.locator('body').innerText()
    if (!fixed.includes('2023-11-01') || !fixed.includes('2023-11-30')) await chooseRange(page)
    await waitForComplete(page)
  } else {
    await page.getByRole('region', { name: '上下文洞察', exact: true }).waitFor({ state: 'visible' })
  }
}

async function openPlugins(page) {
  await page.getByRole('button', { name: '插件', exact: true }).evaluate(element => element.click())
  await page.getByRole('heading', { name: '插件', exact: true }).waitFor({ state: 'visible' })
  await page.waitForTimeout(100)
}

async function checkContextModal(page) {
  const session = page.getByRole('button', { name: /^project-3 [\s\S]*2181 轮/ })
  assert.equal(await session.count(), 1)
  await session.evaluate(element => element.click())
  const input = page.getByRole('textbox', { name: /发消息或创建任务/ })
  await input.waitFor({ state: 'visible', timeout: 120000 })
  await input.fill('/context')
  await input.press('Enter')
  const close = page.getByRole('button', { name: '关闭', exact: true })
  await close.waitFor({ state: 'visible', timeout: 120000 })
  assert.equal(await page.getByText('当前上下文', { exact: true }).count(), 1)
  await close.click()
  await close.waitFor({ state: 'hidden' })
}

async function measureContextHistory(page, cdp, full) {
  await page.evaluate(() => {
    window.__benchLongTasks = []
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__benchLongTasks.push(entry.duration)
      }).observe({ type: 'longtask', buffered: true })
    } catch {}
  })
  const tab = page.getByRole('tab', { name: '上下文', exact: true })
  assert.equal(await tab.count(), 1)
  const started = performance.now()
  await tab.click()
  await page.locator('.lc-chart').waitFor({ state: 'visible', timeout: 120000 })
  const firstChartMs = performance.now() - started
  const firstMemory = await memoryOf(cdp)
  const stepsText = await page.locator('.lc-core-kv-steps').innerText()
  const steps = Number((stepsText.match(/\d+/) ?? ['0'])[0])
  let complete = false
  try {
    await page.waitForFunction(expected => {
      const chart = document.querySelector('.lc-chart')
      return chart !== null && Number(chart.getAttribute('data-lc-bars') ?? '0') >= expected
    }, steps, { timeout: full ? 180000 : 8000 })
    complete = true
  } catch {}
  const fullMs = performance.now() - started
  const fullMemory = await memoryOf(cdp)
  const dom = await page.evaluate(() => ({
    bars: document.querySelectorAll('.lc-bar').length,
    masts: document.querySelectorAll('.lc-ms').length,
    events: document.querySelectorAll('.lc-event').length,
    barsAttr: Number(document.querySelector('.lc-chart')?.getAttribute('data-lc-bars') ?? '0'),
    longTasks: window.__benchLongTasks ?? [],
    historyRequests: performance.getEntriesByType('resource')
      .filter(entry => entry.name.includes('dsh-context/history'))
      .map(entry => ({ ms: entry.duration, bytes: entry.transferSize })),
  }))
  return {
    steps,
    complete,
    firstChartMs,
    fullMs,
    firstMemory,
    fullMemory,
    bars: dom.bars,
    barsAttr: dom.barsAttr,
    masts: dom.masts,
    events: dom.events,
    historyRequests: dom.historyRequests.length,
    historyMs: dom.historyRequests.reduce((sum, entry) => sum + entry.ms, 0),
    historyBytes: dom.historyRequests.reduce((sum, entry) => sum + entry.bytes, 0),
    longTasks: dom.longTasks.length,
    longTaskMaxMs: Math.max(0, ...dom.longTasks),
    longTaskTotalMs: dom.longTasks.reduce((sum, value) => sum + value, 0),
  }
}

async function runVariant(label, plugin) {
  const work = resolve(root, `${label}-work`)
  const server = await startBenchmarkWeb({ plugin, corpus, work })
  let browser
  try {
    browser = await chromium.launch({ headless: true, executablePath })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await context.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)) {
        await route.continue()
        return
      }
      await route.abort('blockedbyclient')
    })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')
    await page.goto(server.url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => {
      if (document.querySelector('[role="dialog"]') !== null) return true
      const button = [...document.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === '上下文洞察')
      return button !== undefined && button.closest('[inert]') === null
    })
    await dismissPreview(page)
    const firstStarted = performance.now()
    await openInsights(page, false)
    await chooseRange(page)
    await waitForComplete(page)
    const firstCompleteMs = performance.now() - firstStarted
    assert.match(await page.locator('body').innerText(), /18\.7k/)
    const firstMemory = await memoryOf(cdp)
    for (let index = 0; index < 10; index++) {
      await openPlugins(page)
      await openInsights(page)
    }
    const repeatedMemory = await memoryOf(cdp)
    await openPlugins(page)
    const unmountedMemory = await memoryOf(cdp)
    await openInsights(page)
    await checkContextModal(page)
    const contextMetrics = await measureContextHistory(page, cdp, label === 'v3')
    const logs = server.logs()
    return {
      label,
      chrome: browser.version(),
      firstCompleteMs,
      firstMemory,
      repeatedMemory,
      unmountedMemory,
      contextModal: true,
      context: contextMetrics,
      serverErrors: logs.stderr.split(/\r?\n/).filter(line => line.includes('Error') || line.includes('failed')).slice(0, 20),
    }
  } finally {
    if (browser !== undefined) await browser.close()
    await server.stop()
  }
}

await mkdir(root, { recursive: true })
const reports = []
for (const label of variants) {
  const plugin = label === 'v2' ? v2 : v3
  const report = await runVariant(label, plugin)
  reports.push(report)
  await writeFile(resolve(root, `${label}-report.json`), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(report)}\n`)
}
await writeFile(resolve(root, 'browser-summary.json'), `${JSON.stringify(reports, null, 2)}\n`)
