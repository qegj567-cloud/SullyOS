import { pathToFileURL } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
const out='output/kanata-halloween-qa';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'msedge'});
const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Shanghai',reducedMotion:'reduce'});
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.clock.setFixedTime(new Date('2026-10-29T12:00:00+08:00'));
await context.route('**/*',r=>['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)?r.continue():r.fulfill({status:200,body:''}));
const button=name=>page.getByRole('button',{name,exact:true});
const shot=async name=>{await page.screenshot({path:`${out}/${name}.png`,animations:'disabled'});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);};
const state=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('vr_fishing_market_v1')));
const next=()=>button('继续对话').click();
try{
    await page.goto('http://127.0.0.1:5177/test/fixtures/kanata.html?npcs=show');await button('SAR').waitFor({timeout:90000});
    await page.evaluate(async()=>{
        const {DB}=await import('/utils/db.ts');
        const {SAR_FACILITY_IDS,sarFacilityGuideKey}=await import('/utils/vrWorld/sarFacilityGuides.ts');
        SAR_FACILITY_IDS.forEach(id=>localStorage.setItem(sarFacilityGuideKey(id),'done'));
        await DB.saveCharacter({id:'halloween-guest',name:'小南瓜',avatar:'',systemPrompt:'测试角色',vrState:{enabled:true,activityMode:'manual',intervalMinutes:120,currentRoom:'sar',sarActivity:'fishing',chibi:{img:'/assets/sar/caian-chibi.png',scale:1,offsetY:0,flip:false}}});
        const user=await DB.getUserProfile();await DB.saveUserProfile({...user,name:'小雨'});
        localStorage.setItem('vr_sar_club_state_v1',JSON.stringify({version:1,updateSeenVersion:1,npcPreference:'show',caianMet:true}));
    });
    await page.reload();await button('SAR').click();await page.locator('.kanata-halloween-costume').first().waitFor();await shot('01-room');
    await button('查看 小南瓜').first().click();await button('更换万圣节装扮').waitFor();
    const old=(await state()).kanataHalloween.costumes['halloween-guest'];
    await button('更换万圣节装扮').click();await page.waitForFunction(old=>JSON.parse(localStorage.getItem('vr_fishing_market_v1')).kanataHalloween.costumes['halloween-guest']!==old,old);
    await button('不给糖就捣蛋！！').click();await page.getByText('已收入收藏册 · 万圣节').waitFor();await shot('02-candy');
    await button('去除万圣节装扮').click();await page.waitForFunction(()=>JSON.parse(localStorage.getItem('vr_fishing_market_v1')).kanataHalloween.costumes['halloween-guest']===null);
    await button('关闭角色弹窗').click();await button('与艾文交谈').click();await next();await shot('03-aiven-choices');
    await page.setViewportSize({width:320,height:568});await shot('03-small-choices');
    for(const label of ['不给糖就捣蛋！','……','为什么你们的立绘没有万圣节装扮？']){const box=await button(label).boundingBox();assert(box.y>=0&&box.y+box.height<=568,label);}
    await page.setViewportSize({width:390,height:844});
    await button('为什么你们的立绘没有万圣节装扮？').click();await next();await next();await button('继续').click();await next();
    await page.getByText('收到万圣小恐龙！').waitFor();await shot('04-dinosaur-gift');await button('收好').click();
    assert.equal((await state()).inventory.filter(c=>c.speciesId==='halloween-dinosaur').length,1);
    await button('与凯恩交谈').click();await next();await button('好耶！').click();await next();await button('收好').click();
    await button('打开仓库').click();await button('打开收集图鉴').click();await page.getByRole('button',{name:/万圣节图鉴/}).click();await shot('05-collection');
    assert.equal((await state()).kanataHalloween.completed.length,2);
    await page.getByRole('textbox',{name:'搜索图鉴'}).fill('凯恩');await button('凯恩 · 万圣夜快乐 · 已收录').click();
    const beforeReplay=(await state()).kanataHalloween;
    await button('重看万圣节对话').click();await next();await button('我不喜欢').click();await button('嗯').click();await next();
    assert.deepEqual((await state()).kanataHalloween,beforeReplay);
    // Reset only this isolated browser's event to exercise withdrawal separately.
    await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('vr_fishing_market_v1'));s.kanataHalloween.completed=[];localStorage.setItem('vr_fishing_market_v1',JSON.stringify(s));});
    await page.reload();await button('SAR').click();await button('与凯恩交谈').click();await next();await button('我不喜欢').click();await button('嗯').click();await page.getByText('那我把活动撤下了哦！既然小雨不喜欢的话，我们应该尊重重要成员的意见！').waitFor();await shot('06-withdraw');await next();
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('vr_fishing_market_v1')).kanataHalloween.disabled);
    assert.equal(await page.locator('.kanata-halloween-costume').count(),0);assert.equal(await page.locator('.kanata-pumpkins').count(),0);
    await page.reload();await button('SAR').click();assert.equal(await page.locator('.kanata-halloween-costume').count(),0);
    await page.setViewportSize({width:1100,height:900});await page.goto('http://127.0.0.1:5177/test/fixtures/kanata-halloween.html');await page.getByText('模型已就绪').waitFor();
    await page.waitForFunction(()=>[...document.querySelectorAll('.kanata-halloween-chibi img')].every(i=>i.complete&&i.naturalWidth));
    assert.equal(await page.locator('.kanata-halloween-costume').count(),5);await shot('07-costumes-fish-dinosaur');
    await page.locator('#garden-preview').screenshot({path:`${out}/08-halloween-dinosaur.png`});
    await page.clock.setFixedTime(new Date('2026-11-01T00:00:00+08:00'));await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.waitForFunction(()=>document.querySelectorAll('.kanata-halloween-costume').length===0);
    assert.deepEqual(errors,[]);writeFileSync(`${out}/result.json`,JSON.stringify({passed:true,errors},null,2));
}catch(e){await shot('failure');writeFileSync(`${out}/errors.json`,JSON.stringify(errors));throw e;}finally{await browser.close();}
