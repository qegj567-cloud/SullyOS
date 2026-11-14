import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = 'output/chat-translation-library';
mkdirSync(output, { recursive: true });
const themes = [
    ['S-719F61E348EE', '仿QQ 磨砂 iOS适配by秩'],
    ['S-99FB665850AC', '仿微信 iOS适配by秩'],
    ['S-36C07C186D47', '简讯iMessage 黑白 iOS适配by秩'],
    ['S-919767B5AE18', '纸胶带'],
    ['S-F46892363B7E', 'Cyberpunk'],
    ['S-E7480EF4BAF9', '巨无霸简约（日夜）'],
].filter(([code]) => !process.env.THEME_CODES || process.env.THEME_CODES.split(',').includes(code));
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
const errors = [], failedResources = [], results = [];
page.on('pageerror', e => errors.push(e.message));
page.on('requestfailed', request => failedResources.push({ url: request.url(), error: request.failure()?.errorText }));
async function anchors() {
    await page.waitForFunction(() => {
        const sources = [...document.querySelectorAll('[data-chat-translation-source]')];
        const host = document.querySelector('[data-chat-subtitle-layer]');
        const subtitles = [...(host?.shadowRoot?.querySelectorAll('[data-chat-subtitle]') || [])];
        return sources.length >= 6 && sources.length === subtitles.length && sources.every((source, i) => {
            const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT);
            let last;
            while (walker.nextNode()) if (walker.currentNode.textContent.trim()) last = walker.currentNode;
            const range = document.createRange(); range.selectNodeContents(last);
            const rects = [...range.getClientRects()].filter(rect => rect.width && rect.height);
            const subtitle = subtitles[i].getBoundingClientRect();
            return rects.length && Math.abs(subtitle.top - rects.at(-1).bottom) < 2 && subtitle.width > 100 && subtitle.right <= innerWidth + 1;
        });
    }, null, { timeout: 10000 });
    return page.evaluate(() => {
        const host = document.querySelector('[data-chat-subtitle-layer]');
        const subtitle = host.shadowRoot.querySelector('[data-chat-subtitle]');
        const style = getComputedStyle(subtitle);
        return { family: style.fontFamily, color: style.color, stroke: style.webkitTextStrokeWidth, pointerEvents: style.pointerEvents,
            scrollWidth: document.querySelector('[data-qa-scroll]').scrollWidth, viewportWidth: innerWidth };
    });
}
try {
    await page.goto(process.env.CHAT_LIBRARY_TEST_URL || 'http://127.0.0.1:5198/test/fixtures/chat-translation-library.html');
    for (const [code, name] of themes) {
        if (results.length) await page.getByRole('button', { name: '美化库', exact: true }).click();
        await page.getByRole('button', { name: '白框', exact: true }).click();
        await page.getByRole('button', { name: '搜索装扮库', exact: true }).click();
        await page.getByRole('textbox', { name: '搜索作品或作者' }).fill(name);
        await page.getByRole('button', { name: `预览 ${name}`, exact: true }).click();
        await page.getByRole('checkbox', { name: '我已阅读作者的使用规范' }).check();
        await page.getByRole('button', { name: '领取装扮', exact: true }).click();
        await page.locator(`[data-applied-code="${code}"]`).waitFor({ timeout: 60000 });
        await page.evaluate(() => document.fonts.load('700 16px "Sully Subtitle Rounded"', '今天去海边散步'));
        const runs = [];
        for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: width === 390 ? 844 : 740 });
            for (const colorScheme of ['light', 'dark']) {
                await page.emulateMedia({ colorScheme });
                const metrics = await anchors();
                assert(metrics.family.includes('Sully Subtitle Rounded'));
                assert.equal(metrics.color, 'rgb(255, 255, 255)');
                assert.equal(metrics.pointerEvents, 'none');
                if (metrics.scrollWidth > width + 1) {
                    await page.getByRole('button', { name: '样式：外挂字幕', exact: true }).click();
                    metrics.bubbleScrollWidth = await page.locator('[data-qa-scroll]').evaluate(el => el.scrollWidth);
                    await page.getByRole('button', { name: '样式：气泡内', exact: true }).click();
                    await anchors();
                    console.log(`WIDTH ${name} ${width}/${colorScheme}: subtitle=${metrics.scrollWidth}, bubble=${metrics.bubbleScrollWidth}`);
                    assert(metrics.scrollWidth <= metrics.bubbleScrollWidth + 1, 'subtitle must not add horizontal overflow beyond the original theme');
                }
                await page.locator('[data-qa-scroll]').evaluate(el => { el.scrollTop = 0; });
                await page.locator('.qa-phone').screenshot({ path: `${output}/${code}-${width}-${colorScheme}.png` });
                await page.locator('[data-qa-scroll]').evaluate(el => { el.scrollTop = 100; });
                await anchors();
                runs.push({ width, colorScheme, ...metrics });
            }
        }
        await page.getByRole('button', { name: '样式：外挂字幕', exact: true }).click();
        assert.equal(await page.locator('[data-chat-subtitle]').count(), 0);
        await page.getByRole('button', { name: '样式：气泡内', exact: true }).click();
        await anchors();
        await page.getByRole('button', { name: '追加双语消息', exact: true }).click();
        await anchors();
        const tail = await page.locator('[data-chat-subtitle]').last().boundingBox();
        const viewport = await page.locator('[data-qa-scroll]').boundingBox();
        assert(tail.y + tail.height <= viewport.y + viewport.height + 2, 'new subtitle follows the bottom');
        await page.locator('textarea[placeholder="Message..."]').fill('输入测试');
        assert.equal(await page.locator('textarea[placeholder="Message..."]').inputValue(), '输入测试');
        await page.locator('textarea[placeholder="Message..."]').fill('');
        await page.locator('[data-qa-scroll]').evaluate(el => { el.scrollTop = 0; });
        await anchors();
        const pressBefore = await page.locator('.qa-state').textContent();
        const source = await page.locator('[data-chat-translation-source]').first().boundingBox();
        await page.mouse.move(source.x + 10, source.y + source.height - 2);
        await page.mouse.down();
        await page.waitForTimeout(680);
        await page.mouse.up();
        assert.notEqual(await page.locator('.qa-state').textContent(), pressBefore, 'long-press still reaches the message');
        results.push({ code, name, runs });
        console.log(`PASS ${name}: 390/320px × light/dark, scroll, style switch, new message, input, long-press`);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ colorScheme: 'light' });
    }
    assert.deepEqual(errors, []);
} catch (error) {
    console.error('Page errors:', errors);
    console.error((await page.locator('body').innerText()).slice(0, 1800));
    await page.screenshot({ path: `${output}/failure.png` });
    throw error;
} finally {
    writeFileSync(`${output}/results.json`, JSON.stringify({ results, errors, failedResources }, null, 2));
    await browser.close();
}
