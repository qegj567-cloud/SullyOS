import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const out = 'output/sar-board-refresh'; mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript(() => localStorage.setItem('sar-facility-guide-board-v1', 'done'));
const page = await context.newPage(), errors = [], modelCalls = [];
page.on('pageerror', error => errors.push(error.message));
let failNext=false;
await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/chat/completions')) {
        modelCalls.push(url.pathname);
        if(failNext){failNext=false;return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{message:'qa offline'}})});}
        const scene=JSON.parse(route.request().postDataJSON().messages[1].content),ids=scene.visitors.map(v=>v.id);
        const actions=[{actorId:ids[0],action:'post',ref:'n1',title:'鱼价辩论第'+modelCalls.length+'回',words:'隔壁说鱼会自己砍价，到底谁教的？'},...ids.slice(1).map(actorId=>({actorId,action:'comment',targetId:'n1',words:'你先让鱼开口，我负责记账。'})),{actorId:ids[0],action:'comment',targetId:'n1',words:'它刚吐的那个泡算不算口头报价？'}];
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:JSON.stringify({actions})}}]})});
    }
    return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.fulfill({ status: 200, body: '', headers: { 'access-control-allow-origin': '*' } });
});
const refresh = () => page.getByRole('button', { name: '刷新布告板', exact: true });
const view = name => page.evaluate(name => window.facilityQA.setView(name), name);
try {
    await page.goto(`${process.env.SAR_QA_URL || 'http://127.0.0.1:5183'}/test/fixtures/sar-facilities.html?facility=board`);
    await page.waitForFunction(() => window.facilityQA?.os.characters.length >= 60);
    await page.evaluate(async () => {
        const os = window.facilityQA.os;
        for (const [id, activityMode] of [['qa-facility-0', 'scheduled'], ['qa-facility-1', 'manual']])
            os.updateCharacter(id, current => ({ vrState: { ...current.vrState, enabled: true, activityMode } }));
        Math.random = () => .1;
    });
    await page.waitForFunction(() => window.facilityQA.os.characters.find(char => char.id === 'qa-facility-0').vrState.enabled);
    await refresh().click(); await page.getByRole('status').filter({ hasText: '来过了' }).waitFor();
    assert.equal(await page.evaluate(() => window.facilityTripCalls?.length || 0), 0, 'the NPC roll does not invoke a character');
    assert.equal(modelCalls.length,1);
    await refresh().click(); await page.waitForFunction(()=>!document.querySelector('[aria-label="刷新布告板"]').disabled);assert.equal(modelCalls.length,2);
    const board=await page.evaluate(()=>JSON.parse(localStorage.getItem('vr_fishing_market_v1')));assert.equal(board.requests.filter(p=>p.itemLabel.startsWith('鱼价辩论')).length,2);assert.equal(board.requests.filter(p=>p.itemLabel.startsWith('鱼价辩论'))[0].comments.length,2);
    await page.screenshot({ path: `${out}/local-npcs.png`, animations: 'disabled' });
    await page.evaluate(() => { Math.random = () => .9; window.facilityTripHandler = () => new Promise(resolve => { window.finishBoardTrip = resolve; }); });
    await refresh().evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => window.finishBoardTrip);
    assert(await refresh().isDisabled());
    assert.deepEqual(await page.evaluate(() => window.facilityTripCalls), [{ id: 'qa-facility-0', mode: 'market' }]);
    await page.evaluate(() => window.finishBoardTrip({ ok: true }));
    await page.getByRole('status').filter({ hasText: 'Sully来过了' }).waitFor();
    await page.getByRole('button', { name: '指定角色', exact: true }).click();
    await page.getByLabel('选择逛布告板的角色', { exact: true }).selectOption('qa-facility-1');
    const invite = page.getByRole('button', { name: '让 ta 逛布告板', exact: true });
    await page.screenshot({ path: `${out}/choose-character.png`, animations: 'disabled' });
    await invite.evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => window.facilityTripCalls.length === 2);
    assert.deepEqual(await page.evaluate(() => window.facilityTripCalls), [
        { id: 'qa-facility-0', mode: 'market' }, { id: 'qa-facility-1', mode: 'market' }
    ], 'manual-only character can be explicitly invited through the existing activity callback');
    await page.evaluate(() => window.finishBoardTrip({ ok: true }));
    await invite.waitFor();
    await page.getByRole('button', { name: '返回布告板', exact: true }).click();
    await refresh().waitFor();
    await page.evaluate(() => window.facilityQA.os.updateCharacter('qa-facility-0', current => ({ vrState: { ...current.vrState, activityMode: 'manual' } })));
    await page.waitForFunction(() => window.facilityQA.os.characters.find(char => char.id === 'qa-facility-0').vrState.activityMode === 'manual');
    await refresh().click();await page.waitForFunction(()=>!document.querySelector('[aria-label="刷新布告板"]').disabled);assert.equal(modelCalls.length,3);
    assert.equal(await page.evaluate(() => window.facilityTripCalls.length), 2, 'when nobody is roaming a refresh stays with NPCs');
    assert.equal(await page.evaluate(() => localStorage.getItem('vr_sar_board_llm_enabled_v1')), null, 'no separate model permission required');
    await page.setViewportSize({ width: 320, height: 640 });
    await page.screenshot({ path: `${out}/board-320.png`, animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    const count=await page.evaluate(()=>JSON.parse(localStorage.getItem('vr_fishing_market_v1')).requests.length);failNext=true;await refresh().click();await page.waitForFunction(()=>!document.querySelector('[aria-label="刷新布告板"]').disabled);assert.equal(modelCalls.length,4);assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('vr_fishing_market_v1')).requests.length),count);
    await page.evaluate(()=>{const key='vr_sar_club_state_v1';localStorage.setItem(key,JSON.stringify({...JSON.parse(localStorage.getItem(key)||'{}'),npcPreference:'hide'}));});await refresh().click();await page.waitForFunction(()=>!document.querySelector('[aria-label="刷新布告板"]').disabled);assert.equal(modelCalls.length,4);
    writeFileSync(`${out}/report.json`, JSON.stringify({ randomNPCOrRoamingCharacter: true, explicitCharacterInvitation: true, manualCharactersExcludedFromRandom: true, doubleClickGuard: true, errors, modelCalls }, null, 2));
    console.log('Board refresh passed: random NPC/roaming visits, direct character invitation and double-click guard.');
} finally { await browser.close(); }
