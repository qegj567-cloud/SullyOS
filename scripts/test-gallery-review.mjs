import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 320, height: 568 }, hasTouch: true });
    const touch = await page.context().newCDPSession(page);
    let requests = 0;
    await page.route('**/gallery-test/chat/completions', route => {
        const request = route.request().postDataJSON();
        assert.equal(request.model, 'vision-test');
        assert.match(request.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
        const message = ++requests === 1 ? { reasoning_content: '只有思考' } : { content: '<think>待分离</think>新的点评。' };
        return route.fulfill({ json: { choices: [{ message }] } });
    });
    await page.goto('http://127.0.0.1:5198/test/fixtures/gallery-review.html', { timeout: 120000 });
    await page.getByRole('button', { name: /测试角色/ }).click();
    await page.locator('.aspect-square').click();
    const review = page.getByRole('region', { name: '照片点评' });
    const regenerate = page.getByRole('button', { name: '重新生成' });
    for (const viewport of [{ width: 320, height: 568 }, { width: 640, height: 320 }]) {
        await page.setViewportSize(viewport);
        assert(await review.evaluate(el => el.scrollHeight > el.clientHeight && el.scrollWidth === el.clientWidth));
        const box = await review.boundingBox();
        const x = box.x + box.width / 2;
        const start = box.y + box.height * .85;
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
        for (let step = 1; step <= 5; step++) {
            await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start - step * box.height / 8 }] });
        }
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForFunction(() => document.querySelector('[aria-label="照片点评"]').scrollTop > 0);
        await review.evaluate(el => { el.scrollTop = el.scrollHeight; });
        assert(await review.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop < 2));
        const bounds = await regenerate.boundingBox();
        assert(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height);
        await page.getByRole('button', { name: '当时的对话' }).click();
        await regenerate.click({ trial: true });
        await page.getByRole('button', { name: '收起对话' }).click();
        await review.evaluate(el => { el.scrollTop = 0; });
    }
    await regenerate.tap();
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).tap();
    await page.waitForFunction(() => document.body.dataset.toast?.includes('没有返回点评正文'));
    assert((await review.innerText()).includes('最后一句'));
    await regenerate.tap();
    await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).tap();
    await review.getByText('"新的点评。"').waitFor();
    assert.equal(requests, 2);
    console.log('PASS: long review scrolls, context expands, retry preserves the original, a valid review replaces it.');
} finally { await browser.close(); }
