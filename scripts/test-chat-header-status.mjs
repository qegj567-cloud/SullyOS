import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
mkdirSync('output/chat-header-status', { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
try {
    await page.goto(`${process.env.SAR_QA_URL || 'http://127.0.0.1:5183'}/test/fixtures/chat-header-status.html`);
    await page.locator('.sully-chat-status').nth(5).waitFor();
    for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const rows = await page.locator('[data-case]').evaluateAll(sections => sections.map(section => {
            const status = section.querySelector('.sully-chat-status'), header = section.querySelector('.sully-chat-header');
            const s = status.getBoundingClientRect(), h = header.getBoundingClientRect(), n = section.querySelector('.sully-chat-name').getBoundingClientRect();
            return { name: section.dataset.case, text: status.textContent.trim().toLowerCase(), height: s.height,
                contained: s.top >= n.bottom - 1 && s.bottom <= h.bottom && s.left >= h.left && s.right <= h.right,
                color: getComputedStyle(status.firstElementChild).color };
        }));
        for (const row of rows) { assert.equal(row.text, 'online', row.name); assert(row.height > 0 && row.contained, JSON.stringify(row)); }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await page.screenshot({ path: `output/chat-header-status/telegram-${width}.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log('PASS: Telegram compact header, left/center, dot/pill/subtle, 390/320px status visible and within header.');
} finally { await browser.close(); }
