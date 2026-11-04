import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'msedge',headless:true}),errors=[],results=[];
try{
 const page=await browser.newPage({viewport:{width:1400,height:950}});
 page.on('response',r=>{if(r.status()>=400)errors.push(r.status()+' '+r.url());});
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.goto('http://127.0.0.1:5199/art/halloween-2026/meshy/assembled/review.html?outfit=witch');
 for(const outfit of ['witch','count','apprentice','shorts','ghost','pumpkin']){
  await page.click('[data-outfit='+outfit+']');await page.waitForFunction(()=>window.ready,{},{timeout:60000});
  await page.selectOption('#palette','original');
  const snapshot=()=>page.evaluate(()=>{const w=document.querySelector('#model').contentWindow;w.fitting.render();return w.document.querySelector('canvas').toDataURL();});
  const before=await snapshot();
  for(const palette of ['original','midnight','crimson','moonlight']){
   await page.selectOption('#palette',palette);
   await page.screenshot({path:`art/halloween-2026/meshy/assembled/${outfit}-palette-${palette}.png`});
   if(palette!=='original'&&(await snapshot())===before)throw Error('No visible recolor '+outfit+'/'+palette);
  }
  await page.selectOption('#palette','original');if(await snapshot()!==before)throw Error('Original not restored '+outfit);
  results.push({outfit,presets:4,originalRestored:true});console.log(outfit+' 4 palettes + exact original restoration');
 }
 if(errors.length)throw Error(errors.join('\n'));
 await fs.writeFile('art/halloween-2026/meshy/assembled/palette-checks.json',JSON.stringify({results,errors},null,2));
}finally{await browser.close();}
