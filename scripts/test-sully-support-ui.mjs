import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import path from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const out = 'output/sully-support-qa';
mkdirSync(out, { recursive: true });
console.log('Bundling real Settings fixture.');
if (!process.env.SULLY_QA_SKIP_BUILD) await build({
    configFile: false,
    plugins: [react()],
    publicDir: false,
    logLevel: 'warn',
    define: { __BUILD_BADGE_VISIBLE__: 'false' },
    build: { outDir: `${out}/site`, emptyOutDir: false, minify: false, rollupOptions: { input: 'test/fixtures/sully-support.html', external: ['katex'] } },
});
const site = path.resolve(`${out}/site`);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp' };
const server = createServer((request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const file = pathname === '/vendor/tailwind-3.4.17.js' ? path.resolve('public/vendor/tailwind-3.4.17.js') : path.resolve(site, '.' + pathname);
        if (pathname !== '/vendor/tailwind-3.4.17.js' && !file.startsWith(site + path.sep)) { response.writeHead(403).end(); return; }
        response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
    } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;
console.log(`Isolated local server: ${base}`);
let browser;
let page;
try {
    browser = await chromium.launch({ headless: true, ...(process.env.SULLY_QA_BROWSER_CHANNEL ? { channel: process.env.SULLY_QA_BROWSER_CHANNEL } : {}) });
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
    page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text().slice(0, 400)); });
    page.on('requestfailed', request => { if (request.url().startsWith(base)) console.error('Local request failed:', request.url(), request.failure()); });
    await page.route('**/*', route => {
        const url = new URL(route.request().url());
        return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort();
    });
    await page.addInitScript(() => {
        Object.assign(window, { __BUILD_BRANCH__: 'qa', __BUILD_COMMIT__: '0000000', __BUILD_TIME__: 'QA', __APP_BUILD_ID__: 'sully-support-qa' });
        Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    });
    const fixture = `${base}test/fixtures/sully-support.html`;
    await page.goto(`${fixture}?notices`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const notice = page.locator('dialog.november-notice');
    await notice.getByRole('heading', { name: 'Sully-11 答疑与表情包更新' }).waitFor();
    await notice.getByRole('button', { name: '知道了', exact: true }).click();
    await notice.waitFor({ state: 'detached' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await notice.getByRole('heading', { name: '最近的主动消息更新', exact: true }).waitFor();
    for (const [width, height] of [[390, 844], [320, 568], [844, 390]]) {
        await page.setViewportSize({ width, height });
        assert.equal(await notice.evaluate(el => el.scrollWidth <= el.clientWidth), true);
        const footer = await notice.locator('footer').boundingBox();
        assert.ok(footer.y >= 0 && footer.y + footer.height <= height);
        await notice.locator('.november-notice-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
        await page.screenshot({ path: `${out}/notice-amsg-${width}.png`, animations: 'disabled' });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await notice.locator('.november-notice-body').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: `${out}/notice-amsg-top.png`, animations: 'disabled' });
    await notice.getByRole('button', { name: '知道了', exact: true }).click();
    await notice.getByRole('heading', { name: '打赏 Sully', exact: true }).waitFor();
    await notice.locator('img').evaluate(image => image.decode());
    for (const [width, height] of [[390, 844], [320, 568]]) {
        await page.setViewportSize({ width, height });
        assert.equal(await notice.evaluate(el => el.scrollWidth <= el.clientWidth), true);
        const footer = await notice.locator('footer').boundingBox();
        assert.ok(footer.y >= 0 && footer.y + footer.height <= height);
        await page.screenshot({ path: `${out}/notice-support-${width}.png`, animations: 'disabled' });
    }
    await page.keyboard.press('Tab');
    assert.equal(await notice.evaluate(el => el.contains(document.activeElement)), true);
    await notice.getByRole('button', { name: '去看看', exact: true }).click();
    await notice.waitFor({ state: 'detached' });
    await page.locator('.support-page .funding-note').waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('button[aria-label="打开打赏 Sully 页面"]').waitFor();
    assert.equal(await notice.count(), 0);
    console.log('Passed: three once-only notices, fixed actions at 320/390/landscape, native focus trap, support CTA, no repeat after reload.');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(fixture, { waitUntil: 'domcontentloaded', timeout: 120000 });
    console.log('Loaded isolated Settings fixture.');
    // Keep the DOM locator usable while the underlying Settings becomes inert.
    const entry = page.locator('button[aria-label="打开打赏 Sully 页面"]');
    await entry.waitFor();
    console.log('Settings entry rendered.');
    const apiDraft = page.getByPlaceholder('https://...', { exact: true });
    await apiDraft.fill('https://unsaved.example.invalid/v1');
    await entry.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/app-settings-entry.png`, animations: 'disabled' });
    const scroll = await entry.evaluate(el => el.closest('.overflow-y-auto').scrollTop);
    await entry.click();
    const panel = page.locator('.support-page');
    await panel.locator('.funding-note').waitFor();
    await panel.locator('.charm-character').evaluate(image => image.decode());
    assert.equal(await panel.getByText('DC 陪聊小猫 · 工号 Sully-08', { exact: true }).count(), 0);
    assert.equal(await panel.locator('input').count(), 0);
    assert.equal(await panel.locator('.funding-note').evaluate(el => Boolean(el.compareDocumentPosition(document.querySelector('.payment-heading')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    assert.equal(await entry.evaluate(el => Boolean(el.closest('[inert]'))), true);
    await page.screenshot({ path: `${out}/app-detail-390.png`, animations: 'disabled' });
    await panel.locator('summary').click();
    assert.deepEqual(await panel.locator('.menu-price').allTextContents(), ['¥2.33', '¥6.66', '¥18.80', '¥18.88', '¥23.33', '¥66.66', '¥88.88']);
    await panel.locator('summary').click();
    assert.equal(await panel.getByRole('tab').count(), 0);
    assert.equal((await panel.textContent()).includes('支付宝'), false);
    await panel.locator('.qr-crop img').evaluate(image => image.decode());
    await panel.locator('.ticket').screenshot({ path: `${out}/app-wechat-ticket.png`, animations: 'disabled' });
    const pending = page.waitForEvent('download');
    await panel.getByRole('button', { name: '保存投喂小票', exact: true }).click();
    const download = await pending;
    await download.saveAs(`${out}/app-wechat-download.png`);
    assert.deepEqual(readFileSync(`${out}/app-wechat-download.png`), readFileSync('assets/sully-support/wechat-support-card.png'));
    await panel.locator('.original-link').click();
    assert.match(await panel.locator('.original-page img').getAttribute('src'), /wechat-original/);
    await page.evaluate(() => window.sullySupportBack());
    await panel.locator('.original-page').waitFor({ state: 'detached' });
    await page.evaluate(() => {
        Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
        Object.defineProperty(navigator, 'share', { configurable: true, value: async data => {
            window.sullyShareCapture = { activeGesture: navigator.userActivation.isActive, name: data.files[0].name, size: data.files[0].size };
        } });
    });
    await panel.getByRole('button', { name: '保存投喂小票', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.sullyShareCapture), {
        activeGesture: true, name: 'Sully-微信投喂小票.png', size: readFileSync('assets/sully-support/wechat-support-card.png').length,
    });
    await panel.getByRole('button', { name: '摸摸 Sully，也很好' }).click();
    assert.match(await panel.locator('.pet-response').textContent(), /摸摸收到/);
    for (const width of [320, 390, 900]) {
        await page.setViewportSize({ width, height: 844 });
        await panel.locator('.support-scroll').evaluate(el => { el.scrollTop = 0; });
        assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), true);
        assert.equal(await panel.locator('.support-scroll').evaluate(el => el.scrollWidth <= el.clientWidth), true);
        await page.screenshot({ path: `${out}/app-detail-${width}.png`, animations: 'disabled' });
        if (width === 320) {
            await panel.locator('.qr-crop img').evaluate(image => image.decode());
            await panel.locator('.ticket').screenshot({ path: `${out}/app-wechat-ticket-320.png`, animations: 'disabled' });
        }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.sullySupportBack());
    await panel.waitFor({ state: 'detached' });
    assert.equal(await entry.evaluate(el => Boolean(el.closest('[inert]'))), false);
    assert.equal(await entry.evaluate(el => document.activeElement === el), true);
    assert.equal(await entry.evaluate(el => el.closest('.overflow-y-auto').scrollTop), scroll);
    assert.equal(await apiDraft.inputValue(), 'https://unsaved.example.invalid/v1');
    await entry.click();
    await page.getByRole('button', { name: '返回设置', exact: true }).click();
    await panel.waitFor({ state: 'detached' });
    await page.goto(`${fixture}?support`, { waitUntil: 'domcontentloaded' });
    await panel.locator('.funding-note').waitFor();
    await page.getByRole('button', { name: '返回设置', exact: true }).click();
    await panel.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    console.log('Passed: real Settings entry, funding-first order, seven amounts, WeChat-only donation, downloaded file bytes, synchronous Web Share gesture, original-code back, parent back/focus/scroll/unsaved draft, pet interaction, 320/390/900 layouts, no runtime errors.');
} catch (error) {
    console.error(error);
    if (page) {
        console.error('Page text:', (await page.locator('body').innerText().catch(() => '')).slice(0, 1500));
        await page.screenshot({ path: `${out}/app-failure.png` }).catch(() => {});
    }
    process.exitCode = 1;
} finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
