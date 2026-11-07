import { chromium } from 'playwright-core'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const htmlPath = path.join(here, 'social-preview.html')
const outPath = path.join(here, '..', '..', 'docs', 'social-preview.png')
const tmpDir = path.join(here, '..', '..', '.tmp')
const hiResPath = path.join(tmpDir, 'social-preview-2x.png')
const executablePath = process.env.DSH_CTX_CHROME

fs.mkdirSync(tmpDir, { recursive: true })
const launch = async () => {
  try {
    return await chromium.launch(executablePath === undefined ? {} : { executablePath })
  } catch (error) {
    throw new Error(`cannot launch a browser for the social preview: ${(error as Error).message}. Set DSH_CTX_CHROME to a Chrome/Chromium executable or install one with \`pnpm exec playwright-core install chromium\`.`)
  }
}

const browser = await launch()
try {
  const page1 = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 })
  await page1.goto(pathToFileURL(htmlPath).href)
  await page1.waitForLoadState('load')
  await page1.screenshot({ path: hiResPath, clip: { x: 0, y: 0, width: 1280, height: 640 } })
  await page1.close()

  const dataUrl = `data:image/png;base64,${fs.readFileSync(hiResPath).toString('base64')}`
  const page2 = await browser.newPage({ viewport: { width: 1280, height: 640 } })
  await page2.setContent(
    `<style>*{margin:0}img{display:block;width:1280px;height:640px}</style>`
      + `<img src="${dataUrl}" width="1280" height="640"/>`,
  )
  await page2.waitForLoadState('load')
  await page2.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 1280, height: 640 } })
  await page2.close()
} finally {
  await browser.close()
  fs.rmSync(hiResPath, { force: true })
}
console.log(`Wrote ${outPath}`)
