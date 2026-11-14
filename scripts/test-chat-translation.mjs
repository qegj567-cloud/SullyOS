import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = 'output/chat-translation';
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
const fontRequests = [];
page.on('request', request => { if (request.resourceType() === 'font' && request.url().includes('subtitle-rounded-bold')) fontRequests.push(request.url()); });
page.on('pageerror', e => errors.push(e.message));
async function checkAnchors() {
    await page.waitForFunction(() => {
        const sources = [...document.querySelectorAll('[data-chat-translation-source]')];
        const subtitles = [...document.querySelector('[data-chat-subtitle-layer]').shadowRoot.querySelectorAll('[data-chat-subtitle]')];
        return sources.length >= 6 && subtitles.length === sources.length && sources.every((source, i) => {
            const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
            let last;
            while (walker.nextNode()) if (walker.currentNode.textContent.trim()) last = walker.currentNode;
            const range = document.createRange(); range.selectNodeContents(last);
            const rects = [...range.getClientRects()];
            const subtitle = subtitles[i].getBoundingClientRect();
            return Math.abs(subtitle.top - rects.at(-1).bottom) < 2 && subtitle.width > 100 && subtitle.right <= innerWidth;
        });
    });
}
try {
    await page.goto(process.env.CHAT_TRANSLATION_TEST_URL || 'http://127.0.0.1:5198/test/fixtures/chat-translation.html');
    assert(await page.getByLabel('气泡内', { exact: true }).isChecked());
    assert.equal(await page.locator('[data-chat-subtitle]').count(), 0);
    assert.equal(fontRequests.length, 0, 'default bubble mode does not download the subtitle font');
    await page.getByLabel('外挂字幕', { exact: true }).check();
    assert(await page.evaluate(async () => (await document.fonts.load('700 16px "Sully Subtitle Rounded"', '今天去海边散步')).length > 0), 'bundled rounded font loads');
    await checkAnchors();
    await page.screenshot({ path: `${output}/subtitle-390.png` });
    await page.locator('.scroll').screenshot({ path: `${output}/rounded-subtitle-390.png` });
    for (const theme of ['clipped', 'flat', 'dark']) {
        await page.getByLabel('测试气泡').selectOption(theme);
        await checkAnchors();
        await page.screenshot({ path: `${output}/${theme}-390.png` });
    }
    // A later image/quote resize above the source must move all subsequent subtitles.
    await page.getByRole('button', { name: '改变上方内容高度' }).click();
    await checkAnchors();
    await page.locator('.scroll').evaluate(el => { el.scrollTop = 95; });
    await checkAnchors();
    await page.setViewportSize({ width: 320, height: 740 });
    await checkAnchors();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${output}/subtitle-320.png` });
    await page.locator('.scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await checkAnchors();
    const tail = await page.locator('[data-chat-subtitle]').last().boundingBox();
    const viewport = await page.locator('.scroll').boundingBox();
    assert(tail.y + tail.height <= viewport.y + viewport.height + 1, 'last subtitle remains reachable above the input bar');
    await page.locator('.scroll').evaluate(el => { el.scrollTop = 95; });
    // Overlay is click-through, and clipping belongs to the scroll viewport only.
    const subtitle = await page.locator('[data-chat-subtitle]').nth(1).boundingBox();
    await page.mouse.click(subtitle.x + 5, subtitle.y + 5);
    assert(Number(await page.locator('[data-clicks]').textContent()) > 0);
    await page.getByRole('button', { name: '追加双语消息' }).click();
    await checkAnchors();
    const appended = await page.locator('[data-chat-subtitle]').last().boundingBox();
    assert(appended.y + appended.height <= viewport.y + viewport.height + 1, 'new long translation follows the latest message to the bottom');
    await page.getByLabel('测试角色').selectOption('qa-b');
    assert(await page.getByLabel('气泡内', { exact: true }).isChecked());
    assert.equal(await page.locator('[data-chat-subtitle]').count(), 0);
    await page.getByLabel('测试角色').selectOption('qa-a');
    await checkAnchors();
    await page.reload();
    assert(await page.getByLabel('外挂字幕', { exact: true }).isChecked());
    await checkAnchors();
    await page.getByLabel('同时展开', { exact: true }).uncheck();
    assert.equal(await page.locator('[data-chat-subtitle]').count(), 0);
    await page.getByRole('button', { name: '翻译', exact: true }).first().click();
    assert((await page.locator('[data-example="0"]').textContent()).includes('今天去海边'));
    await page.getByLabel('同时展开', { exact: true }).check();
    await checkAnchors();
    await page.getByLabel('消息翻译', { exact: true }).uncheck();
    assert.equal(await page.locator('[data-chat-subtitle]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: defaults, 4 themes, last-line anchors, resize/scroll, 320px, click-through, per-character persistence, reload, toggles');
} catch (error) {
    console.error('Page errors:', errors);
    console.error((await page.locator('body').innerText()).slice(0, 2000));
    await page.screenshot({ path: `${output}/failure.png` });
    throw error;
} finally { await browser.close(); }
