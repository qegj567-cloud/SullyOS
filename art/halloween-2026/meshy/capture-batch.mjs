import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const dir='art/halloween-2026/meshy',batch=process.argv[2],ids=process.argv.slice(3);
const browser=await chromium.launch({channel:'msedge',headless:true});
try {const p=await browser.newPage({viewport:{width:1000,height:900}});p.on('pageerror',e=>console.log(e.message));await p.goto('http://127.0.0.1:5199/'+dir+'/viewer.html');await p.waitForFunction(()=>window.ready);
for(const id of ids){await p.evaluate(file=>window.workbench.load(file),batch+'/'+id+'.glb');await p.addStyleTag({content:'#ui{display:none}'});for(const view of ['front','side','back']){await p.evaluate(v=>window.workbench.view(v),view);await p.screenshot({path:dir+'/'+batch+'/'+id+'-'+view+'.png'});}console.log(id,await p.evaluate(()=>{const mesh=[];window.workbench.current.traverse(o=>{if(o.isMesh){o.geometry.computeBoundingBox();mesh.push({name:o.name,box:o.geometry.boundingBox,triangles:o.geometry.index.count/3});}});return mesh;}));}
}finally{await browser.close();}
