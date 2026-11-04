import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const dir='art/halloween-2026/interactions',classic=process.argv.includes('--classic');
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1400,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5202/test/fixtures/room3d-social.html',{timeout:120000,waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__social?.visitors.length===3,{timeout:120000});
 await page.getByRole('button',{name:'暂停',exact:true}).click();
 if(classic){await page.getByRole('button',{name:'全 Chibi',exact:true}).click();await page.waitForFunction(()=>window.__social?.visitors.length===3&&!window.__social.visitors[0].rig,{timeout:120000});}
 const ids=['halloween-boo','halloween-trick-or-treat','halloween-candy-shower','halloween-ghost-tease','home-forehead-touch','home-kiss'];
 const diagnostics=[];
 for(const id of ids){
  diagnostics.push(await page.evaluate(async id=>{
   const {runtime:r,visitors:v,camera,controls}=window.__social;r.reset();await r.start(id,'user','character');
   const duration=r.inspect().session.duration;r.seek(duration-9.2+.6+(id==='halloween-boo'?2:id==='halloween-candy-shower'?3.3:id==='halloween-trick-or-treat'?3.25:3.5));
   const small=!v[0].rig;camera.position.set(id==='halloween-trick-or-treat'?-4:4,small?1.8:2.8,id==='halloween-candy-shower'?0:4);controls.target.set(0,small?.7:1.6,0);controls.update();
   return {id,state:r.inspect(),head:v.slice(0,2).map(x=>x.getHeadWorldPosition().toArray()),palms:v.slice(0,2).map(x=>['L','R'].map(side=>(x.rig?x.rig.bones[side+'_hand'].getWorldPosition(x.root.position.clone()):x.classicPoint(side+'_hand')).toArray()))};
  },id));
  await page.locator('.stage').screenshot({path:`${dir}/${classic?'classic-':''}${id}.png`});
 }
 await fs.writeFile(`${dir}/${classic?'classic-':''}visual-qa.json`,JSON.stringify({errors,diagnostics},null,2));console.log(JSON.stringify({errors,body:classic?'classic':'blank',screenshots:diagnostics.length}));
}finally{await browser.close();}
