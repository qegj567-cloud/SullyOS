import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = 'output/sar-fishing-sale'; mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
await context.addInitScript(() => localStorage.setItem('sar-facility-guide-water-v1', 'done'));
const page = await context.newPage(), errors = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.fulfill({ status: 200, body: '', headers: { 'access-control-allow-origin': '*' } }));
const button = name => page.getByRole('button', { name, exact: true });
const market = () => page.evaluate(() => JSON.parse(localStorage.getItem('vr_fishing_market_v1')));
try {
    await page.goto(`${process.env.SAR_QA_URL || 'http://127.0.0.1:5173'}/test/fixtures/sar-facilities.html?facility=water`);
    await page.waitForFunction(() => window.facilityQA?.os.characters.length >= 60);
    await page.evaluate(async () => {
        const os = window.facilityQA.os;
        await os.updateUserProfile({ name: '雨眠' });
        await os.updateCharacter('qa-facility-0', current => ({ vrState: { ...current.vrState, enabled: true, activityMode: 'manual' } }));
        const m = await import('/utils/vrWorld/fishingMarket.ts');
        await m.mutateFishingMarket(s => m.addCatchToState(s, { id: 'qa-user-sale', speciesId: 'glass-minnow', ownerId: 'user', ownerName: 'user', caughtAt: Date.now(), weather: 'clear', weatherLabel: '晴朗', weatherSource: 'simulated', sizeCm: 20, quality: 3 }));
    });
    await button('图鉴').click(); await page.getByRole('button', { name: /玻璃米鱼/ }).click();
    const sell = page.getByRole('button', { name: /^卖给艾文 ·/ });
    const before = await market();
    // A failed local write must not show the NPC's success reply or consume the fish.
    await page.evaluate(() => {
        const save = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) { if (key === 'vr_fishing_market_v1' && window.failSaleWrite) throw new Error('QA 保存失败'); return save.call(this, key, value); };
        window.failSaleWrite = true;
    });
    await sell.click();
    const confirmSell = page.getByRole('button', { name: '确认卖出', exact: true });
    await confirmSell.waitFor();
    await confirmSell.click();
    await page.getByRole('dialog', { name: '玻璃米鱼', exact: true }).getByRole('alert').filter({ hasText: 'QA 保存失败' }).waitFor();
    assert.equal((await market()).accounts.user, before.accounts.user);
    assert.equal(await page.getByRole('dialog', { name: '艾文的收鱼摊' }).count(), 0);
    await page.evaluate(() => { window.failSaleWrite = false; });
    await sell.click();
    await confirmSell.waitFor();
    await confirmSell.evaluate(node => { node.click(); node.click(); });
    const receipt = page.getByRole('dialog', { name: '艾文的收鱼摊', exact: true }); await receipt.waitFor();
    await receipt.locator('.sar-npc-portrait[data-speaker="aiven"] img:not([aria-hidden])').waitFor();
    const saved = await market(), transaction = saved.ledger.find(e => e.id === 'aiven_fish_sale_qa-user-sale');
    assert.equal(saved.accounts.user, before.accounts.user + transaction.aivenSale.amount);
    assert.equal(saved.inventory.filter(c => c.id === 'qa-user-sale').length, 0);
    assert((await receipt.innerText()).includes('雨眠获得'));
    await page.screenshot({ path: `${out}/user-sale.png`, animations: 'disabled' });
    await page.setViewportSize({ width: 320, height: 640 });
    await page.screenshot({ path: `${out}/user-sale-320.png`, animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await button('关闭详情').click(); await button('钓鱼').click(); await page.locator('.fishing-companions summary').click();
    await page.getByLabel('选择去水域的角色', { exact: true }).selectOption('qa-facility-0');
    await page.evaluate(() => {
        window.facilityTripHandler = async () => {
            const m = await import('/utils/vrWorld/fishingMarket.ts');
            const actor = { id: 'qa-facility-0', name: 'Sully', kind: 'character' };
            await m.mutateFishingMarket(s => {
                const pending = m.beginFishingTrip(s, actor, { kind: 'clear', label: '晴朗', source: 'simulated', detail: '' }, () => 0);
                return m.settleFishingTrip(pending, actor, m.pendingFishingTrip(pending, actor.id).catch.id, { disposition: 'sell', reaction: '今天有收获。', saleWords: '这一条交给你。', shareToUser: null });
            });
            return { ok: true };
        };
    });
    await page.getByRole('button', { name: /让 ta 去钓鱼|让 ta 钓鱼/ }).click();
    await page.locator('.fishing-companions').getByText(/已卖给艾文，获得/).waitFor();
    await page.locator('.fishing-companions .fish-aiven-sale').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${out}/character-sale.png`, animations: 'disabled' });
    assert((await market()).fishingTrips.at(-1).sale);
    assert.deepEqual(errors, []);
    writeFileSync(`${out}/report.json`, JSON.stringify({ userSale: true, writeFailureAtomic: true, doubleClickSinglePayment: true, characterPostFishingSale: true, mobile320: true, errors }, null, 2));
    console.log('Aiven fish sale passed: user, character, write failure, double click, mobile receipt.');
} finally { await browser.close(); }
