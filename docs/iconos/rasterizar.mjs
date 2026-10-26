// Rasteriza SVG a PNG con Chromium (Playwright). Uso: node rasterizar.mjs trabajos.json
// trabajos.json = [{ "svg": "...", "png": "...", "size": 512, "opaque": false }] (o "w"/"h" en vez de "size")
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { readFileSync } from 'node:fs';
const jobs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const j of jobs) {
  const w = j.w ?? j.size, h = j.h ?? j.size;
  const src = readFileSync(j.svg, 'utf8').replace(/width="[\d.]+" height="[\d.]+"/, `width="${w}" height="${h}"`);
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;background:transparent">${src.replace('<svg ', '<svg style="display:block" ')}</body></html>`);
  await page.screenshot({ path: j.png, omitBackground: !j.opaque, clip: { x: 0, y: 0, width: w, height: h } });
}
await browser.close();
