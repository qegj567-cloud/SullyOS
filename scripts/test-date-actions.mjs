import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
await page.route('https://date-companion.example.invalid/**', async route => {
    requests.push(route.request().postDataJSON());
    const n = requests.length;
    const body = `[happy] "茶好了，坐一会儿吧。"\n⟦ACTIONS⟧\ndaily｜接过第${n}杯茶，问今天读了什么。\nplot｜（请求窗外出现第${n}个小变数，不离开房间。）\njoke｜打趣第${n}杯茶是不是会员专享。\noppose｜明确说现在不想喝第${n}杯茶。\n⟦/ACTIONS⟧`;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: body } }] }) });
});
try {
    await page.addInitScript(() => localStorage.setItem('sully-date-entry-guide-v1', 'seen'));
    await page.goto((process.env.DATE_TEST_BASE_URL || 'http://127.0.0.1:4181') + '/test/fixtures/date-companion.html', { timeout: 180000 });
    await page.getByText('林间', { exact: true }).click({ timeout: 180000 });
    await page.getByRole('button', { name: '打开见面设置', exact: true }).click();
    await page.getByText('行动选择', { exact: true }).click();
    await page.getByLabel('开启行动选择').check();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '确认进入见面' }).click();
    await page.getByRole('button', { name: '走过去', exact: true }).click({ timeout: 90000 });
    const suggestions = page.getByLabel('行动建议', { exact: true });
    await suggestions.waitFor();
    assert.equal(await suggestions.getByRole('button').count(), 5);
    assert.equal(requests.length, 1);
    assert.notEqual(await page.locator('[data-sar-gal-text]').textContent(), '');
    for (const [width, height] of [[320, 640], [390, 844]]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(150);
        const fits = await page.evaluate(() => {
            const panel = document.querySelector('.date-actions__panel')?.getBoundingClientRect();
            const stage = document.querySelector('.date-actions')?.getBoundingClientRect();
            return !!panel && !!stage && panel.top >= stage.top && panel.bottom <= stage.bottom
                && Math.abs((panel.top + panel.bottom) / 2 - (stage.top + stage.bottom) / 2) < 2
                && document.documentElement.scrollWidth <= innerWidth;
        });
        assert.equal(fits, true, `dialogue and choices fit ${width}`);
    }
    const before = await page.locator('[data-sar-gal-text]').boundingBox();
    await page.getByRole('button', { name: '收起建议', exact: true }).click();
    assert.deepEqual(await page.locator('[data-sar-gal-text]').boundingBox(), before, 'overlay does not move dialogue');
    await page.getByRole('button', { name: '展示输入框', exact: true }).click();
    assert.deepEqual(await page.locator('[data-sar-gal-text]').boundingBox(), before, 'composer does not move or shrink dialogue');
    await page.getByRole('button', { name: '重新选择行动建议', exact: true }).click();
    const screenshot = join(tmpdir(), 'sully-date-actions.png');
    await page.waitForTimeout(250);
    await page.screenshot({ path: screenshot, fullPage: true });
    await suggestions.getByRole('button').filter({ hasText: '申请变数' }).click();
    assert.equal(requests.length, 1, 'selecting never sends');
    const input = page.getByLabel('见面输入', { exact: true });
    assert.match(await input.inputValue(), /^（.*）$/);
    const selectedDraft = await input.inputValue();
    await page.getByRole('button', { name: '展开输入框', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '展开输入框', exact: true });
    await editor.waitFor();
    assert.equal(await input.inputValue(), selectedDraft);
    await input.fill(selectedDraft + '\n' + '长草稿可以滚动，但不显示原生滚动条。\n'.repeat(30));
    for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: width === 320 ? 640 : 844 });
        const layout = await editor.evaluate(el => {
            const box = el.getBoundingClientRect(), parent = el.parentElement.getBoundingClientRect();
            return { fits: box.left >= 0 && box.right <= innerWidth && box.top >= parent.top && box.bottom <= parent.bottom,
                centerOffset: Math.abs((box.top + box.bottom) / 2 - (parent.top + parent.bottom) / 2) };
        });
        assert.ok(layout.fits && layout.centerOffset < 2, JSON.stringify(layout));
    }
    assert.equal(await input.evaluate(el => getComputedStyle(el).scrollbarWidth), 'none');
    assert.ok(await input.evaluate(el => el.scrollHeight > el.clientHeight));
    await page.screenshot({ path: join(tmpdir(), 'sully-date-expanded-input.png'), fullPage: true });
    const expandedDraft = await input.inputValue();
    await page.getByRole('button', { name: '缩小输入框', exact: true }).click();
    assert.equal(await editor.count(), 0);
    assert.equal(await input.inputValue(), expandedDraft);
    await page.getByRole('button', { name: '展开输入框', exact: true }).click();
    await input.press('Escape');
    assert.equal(await editor.count(), 0);
    await input.fill(selectedDraft);
    assert.deepEqual(await page.locator('[data-sar-gal-text]').boundingBox(), before);
    await page.screenshot({ path: join(tmpdir(), 'sully-date-composer.png'), fullPage: true });
    await input.fill(`${await input.inputValue()}\n我还是想坐在窗边。`);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await suggestions.waitFor();
    assert.equal(requests.length, 2);
    const second = JSON.stringify(requests[1].messages);
    assert.ok(second.includes('我还是想坐在窗边。'));
    assert.ok(second.includes('请求窗外出现第1个小变数'));
    assert.ok(!second.includes('第1杯茶是不是会员专享'), 'unused suggestions never enter model history');
    const saved = await page.evaluate(async () => {
        const { DB } = await import('/utils/db.ts');
        return DB.getRecentMessagesByCharIdAndSource('fixture-date-companion', 'date', 10);
    });
    assert.equal(saved.filter(row => row.role === 'assistant').every(row => !row.content.includes('ACTIONS') && row.metadata.dateActionChoices.length === 4), true);
    assert.equal(saved.filter(row => row.role === 'user').length, 1);
    await page.getByRole('button', { name: '收起建议', exact: true }).click();
    await page.getByRole('button', { name: '打开见面菜单', exact: true }).click();
    await page.getByRole('button', { name: '阅读模式', exact: true }).click();
    await page.getByRole('button', { name: '展示输入框', exact: true }).click();
    await page.getByRole('button', { name: '重新选择行动建议', exact: true }).click();
    await suggestions.waitFor();
    await page.getByRole('button', { name: '测试挂起', exact: true }).click();
    await page.getByRole('button', { name: '测试恢复', exact: true }).click();
    await suggestions.waitFor();
    assert.ok((await suggestions.textContent()).includes('第2杯茶'));
    await page.getByRole('button', { name: '收起建议', exact: true }).click();
    await page.getByRole('button', { name: '打开见面菜单', exact: true }).click();
    await page.getByRole('button', { name: '布置场景', exact: true }).click();
    await page.getByText('行动选择', { exact: true }).click();
    await page.getByLabel('开启行动选择').uncheck();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    assert.equal(await suggestions.count(), 0);
    if (!(await page.getByLabel('见面输入', { exact: true }).count())) await page.getByRole('button', { name: '展示输入框', exact: true }).click();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByText('Typing...', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(requests.length, 3);
    assert.ok(!JSON.stringify(requests[2].messages).includes('⟦ACTIONS⟧'));
    assert.equal(await suggestions.count(), 0);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, requests: requests.length, screenshot }));
} catch (error) {
    await page.screenshot({ path: join(tmpdir(), 'sully-date-actions-failure.png'), fullPage: true });
    console.error(JSON.stringify({ errors, body: (await page.locator('body').textContent()).slice(-1400) }));
    throw error;
} finally { await browser.close(); }
