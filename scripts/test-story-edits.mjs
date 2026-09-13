import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
const out='output/story-edits';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:390,height:844},permissions:['clipboard-read','clipboard-write']});
await context.addInitScript(()=>localStorage.setItem('sar-facility-guide-cabinet-v1','done'));
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const calls=[];let fail=false;
await page.route('**/sar-qa-api/chat/completions',route=>{
    calls.push(route.request().postDataJSON());
    return route.fulfill(fail?{status:500,json:{error:{message:'API临时故障'}}}:{json:{choices:[{message:{content:JSON.stringify({worldNarration:'新的旁白',character:'重新生成的角色回复'})}}]}});
});
const btn=name=>page.getByRole('button',{name,exact:true});
async function open(){await page.goto('http://127.0.0.1:5183/test/fixtures/sar-simulation.html?open=story');await page.locator('[data-sar-message-id]').last().waitFor();}
try{
    await open();
    await btn('第 1 幕回复操作').click();await btn('复制').click();
    assert((await page.evaluate(()=>navigator.clipboard.readText())).includes('怎么凉成这样'));
    await btn('第 1 幕回复操作').click();await btn('修改').click();
    await page.getByLabel('修改角色回复',{exact:true}).fill('我修改后的回复');
    await page.getByLabel('修改世界旁白',{exact:true}).fill('我修改后的旁白');
    await page.screenshot({path:out+'/edit-dialog.png'});
    await btn('保存修改').click();await page.getByText('修改已保存',{exact:true}).waitFor();
    await open();assert(await page.getByText('我修改后的回复',{exact:true}).isVisible());
    fail=true;await btn('第 1 幕回复操作').click();await btn('重新生成').click();
    await page.getByRole('alert').waitFor();assert(await page.getByText('我修改后的回复',{exact:true}).isVisible());
    fail=false;await btn('第 1 幕回复操作').click();await btn('删除').click();await btn('确认删除回复').click();
    await btn('生成').waitFor();await open();await btn('生成').click();
    await page.getByText('重新生成的角色回复',{exact:true}).waitFor();
    assert(calls.at(-1).messages.at(-1).content.includes('我坐到他身边'));
    assert(!JSON.stringify(calls.at(-1).messages).includes('先不管别的了'));
    assert.equal(await page.locator('[data-sar-message-id]').count(),4);
    const state=await page.evaluate(()=>JSON.parse(localStorage.getItem('vr_sar_simulations_v1')));
    assert.equal(state.runs[0].interactionsUsed,2);
    await page.setViewportSize({width:320,height:740});await btn('第 2 幕回复操作').click();
    await page.screenshot({path:out+'/reply-menu-320.png'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.goto('http://127.0.0.1:5183/test/fixtures/trpg-archive.html');
    await page.getByText('完整原文测试',{exact:true}).click();
    await page.getByRole('button',{name:/已归档 2 条剧情/}).click();
    await page.getByRole('button',{name:/第 1 段 · 完整原文/}).click();
    const first=page.locator('[data-game-archived-log="l1"]');
    assert((await first.innerText()).includes('第二段结尾标记：旧塔的灯终于亮了。'));
    await page.getByRole('button',{name:/第 2 段 · 完整原文/}).click();
    assert((await page.locator('[data-game-archived-log="l2"]').innerText()).includes('旧版归档也保留的尾句'));
    await page.screenshot({path:out+'/trpg-full-archive.png'});
    assert.deepEqual(errors,[]);
    console.log('PASS: SAR copy/edit/reload/API failure/delete/retry/turn count/320px; TRPG complete long text and legacy archive');
} catch(error){console.log({errors,body:await page.locator('body').innerText()});throw error;}
finally{await browser.close();}
