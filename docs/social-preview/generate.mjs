// Renders social-preview.html to docs/social-preview.png (exactly 1280x640).
// Renders at 2x (2560x1280) first, then downsamples via Chromium's high-quality
// image smoothing, so text and the embedded screenshot stay sharp.
// Usage: node docs/social-preview/generate.mjs (or: npm run social-preview)
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(here, 'social-preview.html');
const outPath = path.join(here, '..', 'social-preview.png');
const tmpDir = path.join(here, '..', '..', '.tmp');
const hiResPath = path.join(tmpDir, 'social-preview-2x.png');

const executablePath = path.join(
  homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell',
);

fs.mkdirSync(tmpDir, { recursive: true });
const browser = await chromium.launch({ executablePath });

// Pass 1: render the design at 2x.
const page1 = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 });
await page1.goto(pathToFileURL(htmlPath).href);
await page1.waitForLoadState('load');
await page1.screenshot({ path: hiResPath, clip: { x: 0, y: 0, width: 1280, height: 640 } });
await page1.close();

// Pass 2: downsample the 2x render to the final 1280x640.
const dataUrl = `data:image/png;base64,${fs.readFileSync(hiResPath).toString('base64')}`;
const page2 = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page2.setContent(
  `<style>*{margin:0}img{display:block;width:1280px;height:640px}</style>` +
    `<img src="${dataUrl}" width="1280" height="640"/>`,
);
await page2.waitForLoadState('load');
await page2.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 1280, height: 640 } });
await page2.close();

await browser.close();
fs.rmSync(hiResPath);
console.log(`Wrote ${outPath}`);
