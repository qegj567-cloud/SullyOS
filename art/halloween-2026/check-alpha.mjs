import fs from 'node:fs/promises';
import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const manifest=JSON.parse(await fs.readFile('art/halloween-2026/manifest.json','utf8'));
const selected=process.argv.slice(2);if(selected.length)manifest.assets=manifest.assets.filter(item=>selected.includes(item.id));
const browser=await chromium.launch({channel:'msedge',headless:true});
try{const page=await browser.newPage();await page.goto('http://127.0.0.1:5199/art/halloween-2026/reference-body.html');
const report=[];for(const {id,file} of manifest.assets){const result=await page.evaluate(async file=>{const img=new Image();img.src='/art/halloween-2026/'+file;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);const {data}=ctx.getImageData(0,0,img.width,img.height);let transparent=0,semi=0,edge=0;for(let y=0;y<img.height;y++)for(let x=0;x<img.width;x++){const a=data[(y*img.width+x)*4+3];if(a===0)transparent++;else if(a<255)semi++;if(a>0&&(x===0||y===0||x===img.width-1||y===img.height-1))edge++;}return {width:img.width,height:img.height,transparent,semi,edge,transparentRatio:transparent/(img.width*img.height)};},file);report.push({id,...result});}
await fs.writeFile('art/halloween-2026/'+(selected.length?'additional-alpha-report.json':'alpha-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}finally{await browser.close();}
