import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const dir='art/halloween-2026/interactions/motions',browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1000,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5202/test/fixtures/room3d-social.html',{waitUntil:'domcontentloaded',timeout:120000});
 await page.waitForFunction(()=>window.__social?.visitors.length===3,{timeout:120000});await page.getByRole('button',{name:'暂停',exact:true}).click();
 if(process.argv.includes('--classic')){await page.getByRole('button',{name:'全 Chibi',exact:true}).click();await page.waitForFunction(()=>window.__social?.visitors.length===3&&!window.__social.visitors[0].rig,{timeout:120000});}
 if(process.argv.includes('--extreme')){
  await page.getByRole('slider',{name:'你身高'}).focus();await page.getByRole('slider',{name:'你身高'}).press('Home');await page.waitForFunction(()=>window.__social?.visitors.length===3&&window.__social.visitors[0].rig?.bodyHeight===.8,{timeout:120000});
  await page.getByRole('slider',{name:'小栗身高'}).focus();await page.getByRole('slider',{name:'小栗身高'}).press('End');await page.waitForFunction(()=>window.__social?.visitors.length===3&&window.__social.visitors[1].rig?.bodyHeight===1.25,{timeout:120000});
 }
 const actions=process.argv.slice(2).filter(a=>!a.startsWith('--'));if(!actions.length)actions.push('halloween-boo');
 const report=[];
 for(const id of actions){
  await page.evaluate(async id=>{const {runtime:r,visitors:v,camera,controls}=window.__social;r.reset();await r.start(id,'user','character');v[2].root.visible=false;for(const x of v)x.root.traverse(o=>{if(o.userData.badge)o.visible=false;});const small=!v[0].rig;camera.position.set(5,small?1.4:2.5,2.5);controls.target.set(0,small?.65:1.3,0);controls.update();},id);
  const frames=[];
  for(const t of [0,.8,1.6,2.4,3.2,4,5.6,7.5]){
   await page.evaluate(t=>{const r=window.__social.runtime;r.seek(r.inspect().session.duration-9.2+.6+t);},t);
   const b=await page.locator('.stage').screenshot();frames.push(`<figure><img src="data:image/png;base64,${b.toString('base64')}"><figcaption>${t.toFixed(1)} s</figcaption></figure>`);
  }
  // Sample every rendered pose numerically as well: a still cannot catch snaps.
  report.push(await page.evaluate(id=>{const {runtime:r,visitors:v}=window.__social;let previous,maxStep=0,maxAt=null,minFoot=Infinity;for(let i=0;i<=240;i++){r.seek(r.inspect().session.duration-9.2+.6+i/30);const pose=v.slice(0,2).flatMap(x=>x.rig?Object.values(x.rig.bones).map(b=>b.getWorldQuaternion(x.root.quaternion.clone()).toArray()):[]);if(previous)pose.forEach((q,j)=>{const dot=Math.min(1,Math.abs(q.reduce((s,n,k)=>s+n*previous[j][k],0)));const d=2*Math.acos(dot);if(d>maxStep){maxStep=d;const names=v.slice(0,2).flatMap((x,role)=>x.rig?Object.keys(x.rig.bones).map(n=>role+':'+n):[]);maxAt={time:i/30,bone:names[j]};}});previous=pose;v.slice(0,2).forEach(x=>{if(x.rig)for(const n of ['L_foot','R_foot','L_toe','R_toe'])minFoot=Math.min(minFoot,x.rig.bones[n].getWorldPosition(x.root.position.clone()).y);});}return {id,maxBoneStepRadians:maxStep,maxAt,minFoot};},id));
  const sheet=await browser.newPage({viewport:{width:1280,height:660}});await sheet.setContent(`<style>body{margin:0;background:#eff2e9;font:18px sans-serif}h2{margin:12px}main{display:grid;grid-template-columns:repeat(4,1fr)}figure{margin:0}img{width:320px}figcaption{text-align:center}</style><h2>${id} · Meshy Prime${process.argv.includes('--classic')?' · classic':''}</h2><main>${frames.join('')}</main>`);await sheet.screenshot({path:`${dir}/${process.argv.includes('--classic')?'classic-':process.argv.includes('--extreme')?'extreme-':''}${id}-sequence.png`});await sheet.close();
 }
 await fs.writeFile(`${dir}/${process.argv.includes('--classic')?'classic-':process.argv.includes('--extreme')?'extreme-':''}motion-review.json`,JSON.stringify({errors,report},null,2));console.log(JSON.stringify({errors,report}));
}finally{await browser.close();}
