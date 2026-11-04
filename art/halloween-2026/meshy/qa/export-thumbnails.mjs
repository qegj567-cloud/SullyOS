import fs from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'msedge',args:['--use-gl=angle','--use-angle=swiftshader']});
try{
 const page=await browser.newPage();page.on('pageerror',e=>console.error(e));
 await page.goto((process.env.ROOM_DEV_URL||'http://127.0.0.1:5183')+'/test/fixtures/room-loading.html');
 await page.evaluate(()=>{document.body.innerHTML='<div id="export" style="height:700px"></div>';});
 await fs.mkdir('public/room3d/thumbnails',{recursive:true});
 await page.exposeFunction('saveThumbs',async entries=>{for(const [id,url] of Object.entries(entries)){if(!id.startsWith('halloween_')||!url.startsWith('data:'))continue;await fs.writeFile('public/room3d/thumbnails/'+id+'.png',Buffer.from(url.split(',')[1],'base64'));}console.log('Saved Halloween thumbnails:',Object.keys(entries).filter(id=>id.startsWith('halloween_')).length);});
 await page.evaluate(async()=>{const {mountHomeEditor}=await import('/apps/room3d/editor.js');const editor=await mountHomeEditor(document.getElementById('export'),{assetBase:new URL('/room3d/',location.href).href,thumbnailExport:window.saveThumbs});editor.dispose();});
}finally{await browser.close();}
