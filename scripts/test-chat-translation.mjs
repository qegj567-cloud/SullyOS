import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
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
    assert(await page.getByLabel('同时展开', { exact: true }).isChecked());
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
    assert(await page.getByLabel('同时展开', { exact: true }).isChecked());
    assert.equal(await page.locator('[data-chat-subtitle]').count(), 0);
    await page.getByLabel('测试角色').selectOption('qa-a');
    await checkAnchors();
    await page.reload();
    assert(await page.getByLabel('外挂字幕', { exact: true }).isChecked());
    await checkAnchors();
    await page.getByLabel('点击切换', { exact: true }).check();
    assert.equal(await page.locator('[data-chat-subtitle]').count(), 0);
    await page.getByRole('button', { name: '翻译', exact: true }).first().click();
    assert((await page.locator('[data-example="0"]').textContent()).includes('今天去海边'));
    await page.getByLabel('外挂字幕', { exact: true }).check();
    await checkAnchors();
    await page.getByRole('button', { name: '字幕设置与预览' }).click();
    await page.getByLabel('字幕字号').fill('24');
    await page.getByLabel('字幕字体', { exact: true }).selectOption('system');
    await page.getByLabel('字幕文字颜色').fill('#ffeeaa');
    await page.getByLabel('字幕描边颜色').fill('#333333');
    await page.waitForFunction(() => {
        const subtitle = document.querySelector('.subtitle-settings-page [data-chat-subtitle-layer]')?.shadowRoot?.querySelector('[data-chat-subtitle]');
        return subtitle && getComputedStyle(subtitle).fontSize === '24px' && getComputedStyle(subtitle).color === 'rgb(255, 238, 170)';
    });
    assert.equal(await page.evaluate(() => localStorage.getItem('chat_translate_subtitle_qa-a')), null, 'preview edits do not persist');
    assert.equal(await page.locator('.scroll [data-chat-subtitle]').first().evaluate(el => getComputedStyle(el).fontSize), '16px', 'chat still uses the saved style');
    assert.equal(await page.evaluate(() => document.querySelector('dialog').scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${output}/subtitle-settings-320.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${output}/subtitle-settings-390.png` });
    await page.getByRole('button', { name: '返回聊天设置' }).click();
    await page.getByRole('alertdialog', { name: '保存字幕修改？' }).waitFor();
    await page.screenshot({ path: `${output}/subtitle-save-confirm-390.png` });
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    assert.equal(await page.getByLabel('字幕字号').inputValue(), '24');
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    assert(await page.getByRole('dialog', { name: '外挂字幕设置' }).isVisible(), 'Escape on the confirmation returns only to editing');
    assert(await page.evaluate(() => window.subtitleQA.handleLocalBack()));
    await page.getByRole('alertdialog').waitFor();
    assert(await page.evaluate(() => window.subtitleQA.handleLocalBack()));
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    assert.equal(await page.getByLabel('字幕字号').inputValue(), '24', 'global back keeps the draft when dismissing confirmation');
    await page.getByRole('button', { name: '返回聊天设置' }).click();
    await page.getByRole('button', { name: '保存并返回', exact: true }).click();
    await page.locator('dialog').waitFor({ state: 'detached' });
    await checkAnchors();
    assert.equal(await page.locator('[data-chat-subtitle]').first().evaluate(el => getComputedStyle(el).fontSize), '24px');
    await page.reload();
    await checkAnchors();
    assert.equal(await page.locator('[data-chat-subtitle]').first().evaluate(el => getComputedStyle(el).color), 'rgb(255, 238, 170)');
    await page.getByRole('button', { name: '字幕设置与预览' }).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('dialog').count(), 0);
    // Restore is a draft too, and discarding never alters the saved preference.
    await page.getByRole('button', { name: '字幕设置与预览' }).click();
    await page.getByRole('button', { name: '还原', exact: true }).click();
    assert.equal(await page.getByLabel('字幕字号').inputValue(), '16');
    assert.equal(await page.getByLabel('字幕字体', { exact: true }).inputValue(), 'rounded');
    assert.equal(await page.getByLabel('字幕文字颜色').inputValue(), '#ffffff');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('chat_translate_subtitle_qa-a')).fontSize), 24);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '不保存并返回', exact: true }).click();
    await page.locator('dialog').waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-chat-subtitle]').first().evaluate(el => getComputedStyle(el).fontSize), '24px');
    await page.getByRole('button', { name: '字幕设置与预览' }).click();
    await page.getByLabel('字幕字号').fill('25');
    await page.getByLabel('字幕字号').fill('24');
    await page.getByRole('button', { name: '返回聊天设置' }).click();
    await page.locator('dialog').waitFor({ state: 'detached' });
    // Save failures must keep the editor and draft, including the confirmation path.
    await page.getByRole('button', { name: '字幕设置与预览' }).click();
    await page.getByLabel('字幕字号').fill('25');
    await page.evaluate(() => {
        window.subtitleQA.originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
            if (key.startsWith('chat_translate_subtitle_')) throw new Error('Test storage unavailable');
            return window.subtitleQA.originalSetItem.call(this, key, value);
        };
    });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByLabel('字幕字号').inputValue(), '25');
    assert.equal(await page.locator('.scroll [data-chat-subtitle]').first().evaluate(el => getComputedStyle(el).fontSize), '24px');
    await page.getByRole('button', { name: '返回聊天设置' }).click();
    await page.getByRole('button', { name: '保存并返回', exact: true }).click();
    assert(await page.getByRole('alertdialog').getByRole('alert').isVisible());
    await page.evaluate(() => { Storage.prototype.setItem = window.subtitleQA.originalSetItem; });
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await page.getByLabel('字幕字号').fill('24');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('dialog').waitFor({ state: 'detached' });
    // Both nonzero iOS insets and the contain-mode zero inset follow shared chrome.
    await page.getByRole('button', { name: '字幕设置与预览' }).click();
    await page.evaluate(() => {
        document.documentElement.style.setProperty('--chrome-top', '47px');
        document.documentElement.style.setProperty('--safe-bottom', '34px');
    });
    await page.setViewportSize({ width: 320, height: 568 });
    assert((await page.getByRole('button', { name: '返回聊天设置' }).boundingBox()).y >= 47);
    assert((await page.getByRole('button', { name: '保存', exact: true }).boundingBox()).y >= 47);
    await page.getByRole('button', { name: '还原', exact: true }).scrollIntoViewIfNeeded();
    const resetBounds = await page.getByRole('button', { name: '还原', exact: true }).boundingBox();
    assert(resetBounds.y + resetBounds.height <= 568);
    assert.equal(await page.locator('.subtitle-settings-content').evaluate(el => getComputedStyle(el).paddingBottom), '62px');
    assert.equal(await page.locator('.subtitle-settings-page').evaluate(el => el.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${output}/subtitle-settings-safe-area-320.png` });
    await page.evaluate(() => {
        document.documentElement.style.setProperty('--chrome-top', '0px');
        document.documentElement.style.setProperty('--safe-top', '0px');
        document.documentElement.style.removeProperty('--safe-bottom');
    });
    assert.equal(await page.locator('.subtitle-settings-header').evaluate(el => getComputedStyle(el).paddingTop), '8px', 'zero safe inset does not add a second status bar gap');
    await page.getByRole('button', { name: '返回聊天设置' }).click();
    await page.locator('dialog').waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 390, height: 844 });
    const fontBytes = readFileSync('assets/fonts/subtitle-rounded-bold.woff2');
    await page.evaluate(async data => window.subtitleQA.DB.saveAsset('custom_font_data', data), 'data:font/woff2;base64,' + fontBytes.toString('base64'));
    await page.getByRole('button', { name: '字幕设置与预览' }).click();
    await page.getByRole('option', { name: '外观里正在使用的字体' }).waitFor({ state: 'attached' });
    await page.getByLabel('字幕字体', { exact: true }).selectOption('appearance-current');
    await page.waitForFunction(() => document.querySelector('select[aria-label="字幕字体"]').value.startsWith('font_library_'));
    const importedId = await page.getByLabel('字幕字体', { exact: true }).inputValue();
    await page.getByLabel('导入字幕字体').setInputFiles({ name: '自定义字体.woff2', mimeType: 'font/woff2', buffer: fontBytes });
    await page.getByRole('button', { name: '导入字体文件', exact: true }).waitFor();
    assert.equal(await page.getByLabel('字幕字体', { exact: true }).inputValue(), importedId, 'same font file is shared across imports');
    await page.waitForFunction(() => {
        const subtitle = document.querySelector('.subtitle-settings-page [data-chat-subtitle-layer]')?.shadowRoot?.querySelector('[data-chat-subtitle]');
        return subtitle && getComputedStyle(subtitle).fontFamily.includes('SullyFont_');
    });
    await page.getByLabel('导入字幕字体').setInputFiles({ name: '损坏字体.ttf', mimeType: 'font/ttf', buffer: Buffer.from('invalid-font') });
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByLabel('字幕字体', { exact: true }).inputValue(), importedId, 'bad file preserves working font');
    await page.screenshot({ path: `${output}/subtitle-imported-font-390.png` });
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('dialog').waitFor({ state: 'detached' });
    await page.reload();
    await page.waitForFunction(() => {
        const subtitle = document.querySelector('[data-chat-subtitle-layer]')?.shadowRoot?.querySelector('[data-chat-subtitle]');
        return subtitle && getComputedStyle(subtitle).fontFamily.includes('SullyFont_');
    });
    await page.getByLabel('消息翻译', { exact: true }).uncheck();
    assert.equal(await page.locator('[data-chat-subtitle]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS: defaults, 4 themes, anchors, resize/scroll, 320px, click-through, per-character persistence, fonts, draft isolation, restore, save/discard/continue, Escape/global back, save failure recovery, iOS safe insets');
} catch (error) {
    console.error('Page errors:', errors);
    console.error((await page.locator('body').innerText()).slice(0, 2000));
    await page.screenshot({ path: `${output}/failure.png` });
    throw error;
} finally { await browser.close(); }
