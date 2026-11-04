import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const out='output/home-resident-passage';mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,channel:'msedge'}),context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto((process.env.PASSAGE_TEST_URL||'http://127.0.0.1:5186')+'/test/fixtures/room3d-home-social.html?room=halloween&body=blank&pair=1',{waitUntil:'domcontentloaded',timeout:90000});
 await page.waitForFunction(()=>window.__homeEditor?.getPresentResidents().length===2,undefined,{timeout:90000});
 await page.locator('.h3-loading').waitFor({state:'hidden',timeout:60000});
 await page.evaluate(()=>{window.__homeEditor.setAutonomy(false);window.__homeEditor.summonOwner();window.__homeEditor.setViewMode('flat');});
 for(const id of ['user','test-main']){
  await page.evaluate(id=>window.__homeEditor.controlResident(id),id);
  const candidates=await page.evaluate(async id=>{
   const editor=window.__homeEditor,s=editor.inspect(),home=editor.getState(),catalog=await fetch('/room3d/catalog.json').then(r=>r.json());
   const {walkingMap}=await import('/apps/room3d/navigation.js'),{planResidentWalk}=await import('/apps/room3d/residentNavigation.js');
   const actor=s.residentPositions.find(p=>p.id===id),others=s.residentPositions.filter(p=>p.id!==id).map(p=>[p.position[0],p.position[2]]);
   const map=walkingMap(home,0,catalog,{headWidth:1.8,walkClearance:true}),start=[actor.position[0],actor.position[2]],result=[];
   for(let z=-1;z<=2.5;z+=.5)for(let x=-2.5;x<=2.5;x+=.5){
    if(Math.hypot(x-start[0],z-start[1])<1)continue;
    const route=planResidentWalk(map,others,start,[x,z]);if(!route)continue;
    const screen=editor.projectPoint([x,.18,z]);
    if(screen.x<180||screen.x>1100||screen.y<200||screen.y>760)continue;
    result.push({target:[x,z],screen,pass:route.passResidents});
   }
   return result.sort((a,b)=>Number(b.pass)-Number(a.pass));
  },id);
  assert.ok(candidates.length,'a reachable empty floor destination exists');
  let chosen=null,otherBefore;
  for(const candidate of candidates.slice(0,16)){
   await page.evaluate(()=>{const close=document.querySelector('.h3-sheet [data-action="close"]');close?.click();});
   otherBefore=await page.evaluate(id=>window.__homeEditor.inspect().residentPositions.find(p=>p.id!==id),id);
   await page.mouse.click(candidate.screen.x,candidate.screen.y);
   const status=await page.evaluate(()=>window.__homeEditor.inspect());
   if(status.walking){chosen={...candidate,target:status.walkDestination};break;}
  }
  assert.ok(chosen,`${id} starts walking after summon`);
  await page.evaluate(()=>{for(let i=0;i<180&&window.__homeEditor.inspect().walking;i++)window.__homeEditor.advanceTime(100);});
  const after=await page.evaluate(()=>window.__homeEditor.inspect()),actor=after.residentPositions.find(p=>p.id===id);
  assert.equal(after.walking,false);assert.ok(Math.hypot(actor.position[0]-chosen.target[0],actor.position[2]-chosen.target[1])<.1,`${id} reaches accepted floor destination: ${JSON.stringify({chosen,actor,message:after.message})}`);
  assert.deepEqual(after.residentPositions.find(p=>p.id!==id),otherBefore,'passage must not push or teleport the other person');
 }
 await page.screenshot({path:out+'/two-residents-after-summon.png'});
 assert.deepEqual(errors,[]);console.log('PASS: summon in Halloween room, both user and owner walk to open floor; neighbour stays in place, no page errors');
}catch(error){await page.screenshot({path:out+'/failure.png'});console.error(errors);throw error;}
finally{await browser.close();}
