import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = 'output/sar-release'; mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const base = process.env.SAR_QA_URL || 'http://127.0.0.1:5173';
const errors = [], results = [];
try {
    for (const [width,height] of [[390,844],[320,640],[1100,800]]) {
        const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
        await context.route('**/*', route => ['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.fulfill({ status:200, body:'', headers:{'access-control-allow-origin':'*'} }));
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
        await page.goto(`${base}/test/fixtures/sar-release.html`);
        await page.locator('.sar-release').waitFor();
        await page.locator('.sar-release-caian').evaluate(img => img.decode());
        await page.locator('.sar-release-aiven').evaluate(img => img.decode());
        for (let index=0;index<3;index++) {
            await page.screenshot({ path: `${out}/${width}-page-${index+1}.png`, animations:'disabled' });
            const box = await page.locator('.sar-release-next').boundingBox();
            assert(box && box.y+box.height < height && box.height >= 44);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
            if (index<2) await page.getByRole('button', { name:'下一页', exact:true }).click();
        }
        assert.equal(await page.evaluate(() => localStorage.getItem('sullyos_update_2026_09_11_sar_seen')),null);
        await page.getByRole('button',{name:'去彼方看看'}).click();
        await page.locator('[data-result="visit"]').waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem('sullyos_update_2026_09_11_sar_seen')),'1');
        // Only obsolete announcements unseen must not bring the queue back.
        await page.evaluate(() => {
            localStorage.setItem('sullyos_update_20261119_help_stickers_seen','1');
            localStorage.setItem('sullyos_update_20261115_amsg2_seen','1');
            localStorage.setItem('sullyos_update_20261115_support_seen','1');
            localStorage.removeItem('sullyos_update_2026_09_11_sar_seen');
        });
        await page.goto(`${base}/test/fixtures/sar-release.html?queue`);
        await page.locator('[data-result="queue-closed"]').waitFor();
        results.push({ width, height, pages:3, oldQueueRemoved:true });
        await context.close();
    }
    assert.deepEqual(errors,[]);
    writeFileSync(`${out}/report.json`,JSON.stringify({ results, errors },null,2));
    console.log(JSON.stringify({ results, errors }));
} finally { await browser.close(); }
