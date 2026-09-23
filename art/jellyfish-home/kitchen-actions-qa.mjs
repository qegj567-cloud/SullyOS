const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
import assert from 'node:assert/strict';import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-angle=swiftshader']});
const page=await browser.newPage({viewport:{width:1200,height:900}}),errors=[],report=[];
page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
await page.addInitScript(()=>localStorage.setItem('sully-home3d-quality','balanced'));
const inspect=()=>page.evaluate(()=>window.__homeEditor.inspect());
for(const [assetId,kind]of [['kitchenware_coffee','coffee'],['kitchen_ref_prep','wash'],['show_kitchen_range','cook']]){
 await page.goto('http://127.0.0.1:5174/test/fixtures/room3d-showrooms.html?room=kitchen&fresh=1'+(process.env.KITCHEN_BLANK?'&blank=1':''));await page.waitForFunction(()=>window.__homeEditor,undefined,{timeout:120000});
 await page.evaluate(()=>window.advanceTime(0));const before=await inspect(),id=before.rooms[0].items.find(i=>i.assetId===assetId).id;
 const at=await page.evaluate(id=>window.__homeEditor.projectItem(id),id);
 for(const [x,y]of [[0,0],[0,-10],[-10,0],[10,0],[0,10],[-20,-5],[20,-5],[0,-25]]){
  await page.mouse.click(at.x+x,at.y+y);if((await inspect()).interaction?.itemId===id)break;
 }
 assert.equal((await inspect()).interaction?.itemId,id,assetId+' hit');
 await page.locator('[data-action="chibi-kitchen"]').click();
 assert.equal((await inspect()).kitchenTask?.kind,kind,JSON.stringify((await inspect()).message));
 const stages=new Set();let took=false;
 for(let step=0;step<180;step++){
  await page.evaluate(()=>window.advanceTime(500));const s=await inspect();if(!s.kitchenTask)break;
  stages.add(s.kitchenTask.stage);
  if(s.kitchenTask.stage==='work'&&!took){
   await page.screenshot({path:'output/showrooms/action-'+kind+'.png'});
   await page.locator('[data-panel=chibi]').click();await page.locator('[data-action=chibi-view]').click();await page.locator('[data-action=wall-view][data-value=hidden]').click();for(let turn=0;turn<4;turn++)await page.locator('[data-action=turn-view]').last().click();await page.evaluate(()=>window.advanceTime(500));await page.screenshot({path:'output/showrooms/action-'+kind+(process.env.KITCHEN_BLANK?'-blank':'')+'-close.png'});
   took=true;
  }
  if(s.kitchenTask.stage==='toSink'&&s.kitchenTask.carrying)assert.equal(s.kitchenPropsVisible,true);
 }
 const done=await inspect();assert.equal(done.kitchenTask,null);assert.equal(done.kitchenPropsVisible,false);assert.ok(stages.has('work'));
 if(kind==='wash')for(const phase of ['pickup','toSink','return','putback'])assert.ok(stages.has(phase),phase);
 assert.deepEqual(done.rooms,before.rooms,'activity must not alter saved furniture');
 report.push({kind,stages:[...stages],message:done.message});
}
// Cancellation is exercised through real UI while the dish is being carried.
for(const interruption of ['rest','store']){
 await page.goto('http://127.0.0.1:5174/test/fixtures/room3d-showrooms.html?room=kitchen&fresh=1');await page.waitForFunction(()=>window.__homeEditor,undefined,{timeout:120000});await page.evaluate(()=>window.advanceTime(0));
 const s=await inspect(),id=s.rooms[0].items.find(i=>i.assetId==='kitchen_ref_prep').id,at=await page.evaluate(id=>window.__homeEditor.projectItem(id),id);
 for(const [x,y]of [[0,0],[0,-10],[-10,0],[10,0],[0,10],[-20,-5],[20,-5]]){await page.mouse.click(at.x+x,at.y+y);if((await inspect()).interaction?.itemId===id)break;}
 await page.locator('[data-action="chibi-kitchen"]').click();
 for(let n=0;n<40;n++){await page.evaluate(()=>window.advanceTime(500));if((await inspect()).kitchenTask?.stage==='toSink')break;}
 assert.equal((await inspect()).kitchenTask?.stage,'toSink');
 if(interruption==='rest'){await page.locator('[data-panel=chibi]').click();await page.locator('[data-action=chibi-game-stop]').click();}
 else{const sink=s.rooms[0].items.find(i=>i.assetId==='show_kitchen_counter').id;await page.evaluate(id=>window.__homeEditor.select(id),sink);await page.locator('[data-action=store]').click();}
 await page.evaluate(()=>window.advanceTime(30000));const done=await inspect();assert.equal(done.kitchenTask,null);assert.equal(done.kitchenPropsVisible,false);assert.equal(done.walking,false);
 if(interruption==='store')await page.locator('[data-action=undo]').click();report.push({interruption,clean:true});
}
assert.deepEqual(errors,[]);await fs.writeFile('output/showrooms/kitchen-actions'+(process.env.KITCHEN_BLANK?'-blank':'')+'-qa.json',JSON.stringify({report,errors},null,2));console.log(report);await browser.close();
