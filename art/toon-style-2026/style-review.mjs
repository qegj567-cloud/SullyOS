import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const dir='art/toon-style-2026/style-qa';await fs.mkdir(dir,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext();const report={errors:[]};
try{
 const home=await context.newPage(),preview=await context.newPage();
 for(const page of [home,preview]){page.setDefaultTimeout(120000);page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error')report.errors.push(m.text());});}
 await home.goto('http://127.0.0.1:5206/test/fixtures/room3d-photo.html',{timeout:120000});
 await home.getByRole('button',{name:'开始拍照验收',exact:true}).waitFor();await home.waitForFunction(()=>!document.querySelector('.photo-qa-open').disabled);
 await home.evaluate(()=>window.__homeEditor.openPanel('quality'));
 report.defaultModern=await home.getByRole('button',{name:'新版 · 风格化',exact:true}).getAttribute('aria-pressed');
 await preview.goto('http://127.0.0.1:5206/test/fixtures/chibi-toon.html',{timeout:120000});
 await preview.waitForFunction(()=>document.querySelectorAll('.puppet canvas').length===2&&Array.from(document.querySelectorAll('.puppet')).every(p=>Number(p.dataset.drawCalls)>0));
 const ids=()=>preview.locator('.puppet').evaluateAll(items=>items.map(x=>x.dataset.bodyId));const beforeIds=await ids();
 const capture=()=>home.evaluate(()=>{const e=window.__homeEditor;e.beginPhotoMode();e.setPhotoCamera({yaw:-18,pitch:4,height:1.55,zoom:1.4});e.setPhotoTogether(1.9);for(const id of ['photo-qa-only','user'])e.setPhotoFace(id,{expression:'neutral'});const c=document.createElement('canvas');e.renderPhoto(c,{preset:'natural',glow:0,fringe:0,vignette:0,exposure:1},{aspect:16/9});return c.toDataURL();});
 const modern=await capture();await fs.writeFile(dir+'/modern.png',Buffer.from(modern.split(',')[1],'base64'));
 await home.getByRole('button',{name:'旧版 · 经典',exact:true}).click();
 await preview.waitForFunction(async()=> (await import('/apps/room3d/chibi/characterStyle.ts')).getCharacterStyle()==='legacy');
 await preview.waitForTimeout(500);await preview.screenshot({path:dir+'/legacy-preview.png'});
 const legacy=await capture();report.imageChanged=legacy!==modern;await fs.writeFile(dir+'/legacy.png',Buffer.from(legacy.split(',')[1],'base64'));report.previewBodyReused=JSON.stringify(beforeIds)===JSON.stringify(await ids());
 await home.screenshot({path:dir+'/setting.png'});
 await home.reload({timeout:120000});await home.waitForFunction(()=>window.__homeEditor?.inspect()?.ready);await home.evaluate(()=>window.__homeEditor.openPanel('quality'));
 report.persistedLegacy=await home.getByRole('button',{name:'旧版 · 经典',exact:true}).getAttribute('aria-pressed');
 await home.getByRole('button',{name:'新版 · 风格化',exact:true}).click();await preview.waitForFunction(async()=> (await import('/apps/room3d/chibi/characterStyle.ts')).getCharacterStyle()==='modern');await preview.waitForTimeout(500);await preview.screenshot({path:dir+'/modern-preview.png'});
 report.restoredModern=await home.getByRole('button',{name:'新版 · 风格化',exact:true}).getAttribute('aria-pressed');
}catch(error){report.failure=error.message;process.exitCode=1;}finally{await fs.writeFile(dir+'/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();}
