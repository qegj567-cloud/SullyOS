// Render original Sully art + CSS. No generated imagery or QR re-encoding.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = 'art/sully-support/exports/readme-support-1600x860.png';
const qa = 'output/sully-support-qa';
mkdirSync(path.dirname(output), { recursive: true });
mkdirSync(qa, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: process.env.SULLY_QA_BROWSER_CHANNEL || 'msedge' });
try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 860 }, deviceScaleFactor: 1 });
    await page.route('**/*', route => route.request().url().startsWith('file:') ? route.continue() : route.abort());
    await page.goto(pathToFileURL(path.resolve('art/sully-support/readme-banner.html')).href);
    await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(img => img.decode())); });
    const bounds = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { banner: rect('.banner'), letter: rect('.letter'), footer: rect('.voluntary'), remark: rect('.remark') };
    });
    assert.equal(bounds.banner.width, 1600);
    assert.equal(bounds.banner.height, 860);
    assert.ok(bounds.letter.bottom < bounds.footer.top && bounds.remark.bottom < bounds.footer.top);
    await page.locator('.banner').screenshot({ path: output, animations: 'disabled' });
    for (const channel of ['wechat', 'alipay']) {
        await page.locator(`#${channel}-code`).screenshot({ path: `${qa}/readme-${channel}-code.png` });
    }
    // Inspect the exported PNG at a typical README width and on a narrow screen.
    for (const width of [800, 360]) {
        await page.setViewportSize({ width, height: Math.ceil(width * 860 / 1600) });
        await page.setContent(`<style>html,body{margin:0}img{display:block;width:100%;height:auto}</style><img src="${pathToFileURL(path.resolve(output)).href}" alt="Sully 赞赏横图">`);
        await page.locator('img').evaluate(img => img.decode());
        await page.screenshot({ path: `${qa}/readme-banner-${width}.png` });
    }
    console.log(`Exported ${output}; checked bounds and README-width previews.`);
} finally { await browser.close(); }
