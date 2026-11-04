// Start Vite, then run with DATE_SCROLL_URL (optional), PLAYWRIGHT_MODULE (if not
// installed locally), and BROWSER_CHANNEL (defaults to msedge on Windows).
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
const results = [];
page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
const settle = () => page.waitForTimeout(250); // Let content-visibility and ResizeObserver complete their layout frames.
const metrics = () => page.locator('.meeting-reading-page').evaluate(element => ({
    top: element.scrollTop, height: element.scrollHeight,
    gap: element.scrollHeight - element.clientHeight - element.scrollTop,
}));
const bottom = async name => {
    await settle();
    await page.waitForFunction(() => {
        const element = document.querySelector('.meeting-reading-page');
        return element && Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) < 2;
    });
    results.push({ scenario: name, ...await metrics() });
    console.log(`PASS ${name}`);
};
const toggleMode = async name => {
    await page.getByRole('button', { name: '打开见面菜单', exact: true }).click();
    await page.getByRole('button', { name, exact: true }).click();
};
const anchor = () => page.locator('.meeting-reading-page').evaluate(element => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll('[data-date-message-id]')].find(row => row.getBoundingClientRect().bottom > top);
    return { id: row.dataset.dateMessageId, offset: row.getBoundingClientRect().top - top };
});
const checkAnchor = async (name, saved) => {
    await settle();
    const offset = await page.locator(`[data-date-message-id="${saved.id}"]`).evaluate(row => row.getBoundingClientRect().top - row.closest('.meeting-reading-page').getBoundingClientRect().top);
    assert.ok(Math.abs(offset - saved.offset) < 2, `${name}: ${saved.offset} -> ${offset}`);
    results.push({ scenario: name, anchorId: saved.id, offset });
    console.log(`PASS ${name}`);
};
try {
    await page.goto(process.env.DATE_SCROLL_URL || 'http://127.0.0.1:4181/test/fixtures/date-reading-scroll.html');
    await page.getByRole('button', { name: '打开见面菜单', exact: true }).waitFor({ timeout: 90000 });
    await toggleMode('阅读模式');
    await bottom('首次切换阅读，动态样式与离屏高度就绪');
    await toggleMode('立绘模式');
    await page.getByRole('button', { name: '模拟生成新回复', exact: true }).click();
    await toggleMode('阅读模式');
    await bottom('立绘生成后再切入，样式已预热');
    await page.getByRole('button', { name: '退出后重新进入', exact: true }).click();
    await toggleMode('阅读模式');
    await bottom('重新进入后切入阅读');
    await page.getByRole('button', { name: '切换默认阅读外观', exact: true }).click();
    await bottom('重进直接使用阅读外观');
    await page.getByRole('button', { name: '模拟读取前的空历史', exact: true }).click();
    await page.getByRole('button', { name: '完成异步历史读取', exact: true }).click();
    await bottom('异步返回历史');
    await page.getByRole('button', { name: '模拟生成新回复', exact: true }).click();
    await bottom('停在末尾时追加回复');

    // Isolate the user-scrolling tests from lazy row-size changes, already covered above.
    await page.locator('.meeting-reading-page').evaluate(element => {
        for (const row of element.querySelectorAll('[data-date-message-id]')) row.style.contentVisibility = 'visible';
    });
    await bottom('全部正文取得真实高度');
    await page.locator('.meeting-reading-page').evaluate(element => { element.scrollTop -= 400; });
    await settle();
    const saved = await anchor();
    await page.getByRole('button', { name: '模拟生成新回复', exact: true }).click();
    await checkAnchor('上翻阅读时追加不抢位置', saved);
    await page.locator('.meeting-reading-page').evaluate((element, id) => {
        for (const row of element.querySelectorAll('[data-date-message-id]')) {
            row.style.contentVisibility = 'visible';
            if (Number(row.dataset.dateMessageId) < Number(id)) { row.style.height = '30px'; row.style.overflow = 'hidden'; }
        }
    }, saved.id);
    await checkAnchor('离屏正文收缩与浏览器自动钳制', saved);
    const beforeOlder = await page.locator('.meeting-reading-page').evaluate(element => {
        element.scrollTop = 20;
        const row = element.querySelector('[data-date-message-id="51"]');
        return { id: '51', offset: row.getBoundingClientRect().top - element.getBoundingClientRect().top };
    });
    await settle();
    await page.locator('[data-date-message-id="1"]').waitFor();
    await checkAnchor('上翻加载更早记录保留消息位置', beforeOlder);
    await page.mouse.move(350, 500);
    await page.mouse.wheel(0, 100000);
    await bottom('真实滚轮回到底部');
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    console.log(JSON.stringify({ passed: results.length, results }, null, 2));
} finally {
    await browser.close();
}
