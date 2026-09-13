import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
const out='output/sar-update-notices';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});
const errors=[],modelRequests=[];page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(/chat\/completions|\/responses(?:$|\?)|\/messages(?:$|\?)/.test(request.url()))modelRequests.push(request.url());});
await page.route('**/*',route=>['localhost','127.0.0.1'].includes(new URL(route.request().url()).hostname)?route.continue():route.fulfill({status:200,body:''}));
await page.addInitScript(()=>{
 if(!localStorage.getItem('vr_sar_club_state_v1'))localStorage.setItem('vr_sar_club_state_v1',JSON.stringify({version:1,updateSeenVersion:1,npcPreference:'show',caianMet:true}));
 for(const id of ['cabinet','board'])localStorage.setItem('sar-facility-guide-'+id+'-v1','done');
});
const button=name=>page.getByRole('button',{name,exact:true});
const notice=page.getByRole('dialog',{name:'凯恩的优化通知',exact:true});
const seen=id=>page.evaluate(id=>localStorage.getItem('sar-feature-update-september-v1:'+id),id);
const enter=async()=>{await button('SAR').click();await button('进入异界陈列柜').waitFor();};
const preference=async value=>page.evaluate(async value=>{const {patchSARClubState}=await import('/utils/vrWorld/sarClub.ts');patchSARClubState({npcPreference:value});},value);
const familiarity=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('vr_fishing_market_v1')||'null')?.sarFamiliarity??null);
async function read(id,expressions){
 await notice.waitFor();assert.equal(await notice.getByRole('button').count(),1);assert.equal(await seen(id),null);
 for(let i=0;i<expressions.length;i++){
  const portrait=notice.locator('.sar-npc-portrait');assert.equal(await portrait.count(),1);assert.equal(await portrait.getAttribute('data-speaker'),'caian');assert.equal(await portrait.getAttribute('data-expression'),expressions[i]);
  await page.waitForFunction(()=>document.querySelector('[data-sar-update] .sar-npc-portrait')?.getAttribute('aria-busy')==='false');
  assert.equal(await seen(id),null);
  if(i===1){assert.equal(await notice.locator('strong').count(),1);assert.equal(await notice.locator('em').count(),1);assert(!(await notice.locator('.srf-line').innerText()).includes('*'));}
  if(i===1||i===expressions.length-1){await page.setViewportSize({width:320,height:680});assert.equal(await notice.evaluate(el=>el.scrollWidth>el.clientWidth),false);assert.equal(await notice.locator('.srf-bubble').evaluate(el=>el.scrollHeight>el.clientHeight),false);await page.screenshot({path:out+'/'+id+'-'+i+'.png'});}
  await button('继续对话').click();
 }
 await notice.waitFor({state:'detached'});assert.equal(await seen(id),'done');
}
try{
 await page.goto('http://127.0.0.1:5183/test/fixtures/kanata.html?npcs=show');await enter();const before=await familiarity();
 await button('进入异界陈列柜').click();await notice.waitFor();assert.equal(await page.getByRole('dialog',{name:'SAR 异格陈列柜',exact:true}).count(),0);
 await page.keyboard.press('Escape');await notice.waitFor();assert.equal(await seen('cabinet'),null);
 await read('cabinet',['happy','normal','normal','happy','normal','normal2']);
 await page.getByRole('dialog',{name:'SAR 异格陈列柜',exact:true}).waitFor();assert.deepEqual(await familiarity(),before);
 await button('离开异格陈列柜').click();await button('进入异界陈列柜').click();await page.getByRole('dialog',{name:'SAR 异格陈列柜',exact:true}).waitFor();assert.equal(await notice.count(),0);await button('离开异格陈列柜').click();
 await button('进入布告板').click();await notice.waitFor();await button('继续对话').click();assert.equal(await seen('board'),null);
 await page.reload();await enter();await button('进入布告板').click();await notice.getByText('打扰一下！我来转达优化通知了！',{exact:true}).waitFor();
 await preference('hide');await notice.waitFor({state:'detached'});await page.getByRole('dialog',{name:'彼方布告板',exact:true}).waitFor();assert.equal(await seen('board'),null);await button('离开布告板').click();
 await button('进入布告板').click();await page.getByRole('dialog',{name:'彼方布告板',exact:true}).waitFor();assert.equal(await notice.count(),0);assert.equal(await seen('board'),null);await button('离开布告板').click();
 await preference('show');await button('进入布告板').click();await read('board',['happy','normal','normal','happy','warm']);await page.getByRole('dialog',{name:'彼方布告板',exact:true}).waitFor();assert.deepEqual(await familiarity(),before);await button('离开布告板').click();
 await page.reload();await enter();for(const [entry,dialog,close] of [['进入异界陈列柜','SAR 异格陈列柜','离开异格陈列柜'],['进入布告板','彼方布告板','离开布告板']]){await button(entry).click();await page.getByRole('dialog',{name:dialog,exact:true}).waitFor();assert.equal(await notice.count(),0);await button(close).click();}
 assert.deepEqual(modelRequests,[]);assert.deepEqual(errors,[]);console.log('PASS both authored notices and expressions, native dialogue focus, destinations, interruption, NPC opt-out, independent persistent acknowledgement, no familiarity changes or model requests, 320px readability');
}finally{await browser.close();}
