import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.SULLY_HELP_QA_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin
        ? route.continue() : route.abort());
    await page.goto(origin + '/test/fixtures/sully-help.html');
    const openDesk = () => page.getByRole('button', { name: '问 Sully-11' }).click();
    await openDesk();
    const field = page.getByRole('textbox', { name: '你的糯米机问题' });
    const send = page.getByRole('button', { name: '发送文字' });
    const log = page.getByRole('log');
    await field.click();
    // Real keyboard events allow a microtask between React's capture and bubble listeners.
    // dispatchEvent and Playwright fill() alone do not reproduce the lost keystroke.
    await field.pressSequentially('API');
    assert.equal(await field.inputValue(), 'API', '逐键输入后应保留每一个字');
    assert.equal(await send.isEnabled(), true);
    await field.press('Shift+Enter');
    const ime = await page.context().newCDPSession(page);
    await ime.send('Input.imeSetComposition', { text: 'zenme', selectionStart: 5, selectionEnd: 5 });
    await ime.send('Input.insertText', { text: '怎么设置？' });
    const question = 'API\n怎么设置？';
    assert.equal(await field.inputValue(), question);
    await send.click();
    await log.getByText(question, { exact: true }).waitFor();
    assert.equal(await field.inputValue(), '');
    assert.equal(await send.isEnabled(), false);
    await field.click();
    // Typing just before the 20-minute idle cutoff must keep this consultation active.
    const started = await page.evaluate(() => Date.now());
    await page.clock.setSystemTime(started + 19 * 60_000);
    await page.keyboard.insertText('补充一个问题');
    await page.clock.setSystemTime(started + 21 * 60_000);
    await field.press('Enter');
    await log.getByText('补充一个问题', { exact: true }).waitFor();
    await page.reload();
    await openDesk();
    await log.getByText('补充一个问题', { exact: true }).waitFor();
    assert.equal(await log.getByText(question, { exact: true }).count(), 1);
    await page.getByRole('button', { name: '功能目录' }).click();
    const search = page.getByRole('textbox', { name: '搜索功能目录' });
    await search.click();
    await page.keyboard.insertText('世界书');
    assert.equal(await search.inputValue(), '世界书');
    await page.getByRole('button', { name: /世界书/ }).first().waitFor();
    assert.deepEqual(errors, []);
    console.log('通过：逐键输入、中文组词、换行、纸飞机与回车发送、重开记录及目录搜索。');
} finally {
    await browser.close();
}
