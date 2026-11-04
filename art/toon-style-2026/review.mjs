import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const stage=process.argv[2]||'after',dir=`art/toon-style-2026/${stage}`;await fs.mkdir(dir,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const report={errors:[],views:[]};
try {
 const page=await browser.newPage({viewport:{width:1400,height:900},deviceScaleFactor:1});
 page.setDefaultTimeout(120000);
 page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});
 await page.goto('http://127.0.0.1:5206/test/fixtures/room3d-photo.html?photo'+(stage.includes('classic')?'&classic':''),{timeout:120000});
 await page.waitForFunction(()=>document.querySelector('.photo-view')?.width===1280,{timeout:120000});
 await page.getByRole('button',{name:'原片',exact:true}).click();
 await page.evaluate(()=>{const e=window.__homeEditor;e.setPhotoTogether(1.9);e.setPhotoCamera({yaw:-18,pitch:4,height:1.55,zoom:1.4,pan:0});});
 for(const phase of ['day','sunset','night']){
  await page.evaluate(p=>window.__homeEditor.setLightingMode(p),phase);await page.waitForTimeout(1200);
  await page.locator('.photo-view').screenshot({path:`${dir}/${phase}.png`});
  report.views.push(await page.evaluate(()=>{const e=window.__homeEditor.inspect();return {phase:e.lighting.profile,drawCalls:e.drawCalls,triangles:e.triangles,programs:e.programs};}));
 }
 await page.getByRole('button',{name:'晴空物语',exact:true}).click();await page.waitForTimeout(500);await page.screenshot({path:`${dir}/photo.png`});
 await fs.writeFile(`${dir}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){report.failure=error.message;await fs.writeFile(`${dir}/report.json`,JSON.stringify(report,null,2));const page=browser.contexts()[0]?.pages()[0];if(page)await page.screenshot({path:`${dir}/failure.png`});console.log(JSON.stringify(report));process.exitCode=1;}finally{await browser.close();}
