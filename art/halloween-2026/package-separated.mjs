import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const root='art/halloween-2026', dest=root+'/separated';
const m=JSON.parse(await fs.readFile(dest+'/manifest.json','utf8'));
const groups=[['01-witch','南瓜女巫','01-pumpkin-witch'],['02-count','蝙蝠伯爵','02-bat-count'],['03-apprentice','魔药学徒','03-potion-apprentice'],['04-shorts','万圣节短裤','04-halloween-shorts'],['05-ghost','幽灵装','05-ghost-costume'],['06-pumpkin','南瓜装','06-pumpkin-costume']];
await fs.mkdir(dest+'/references',{recursive:true});
await fs.copyFile(root+'/references/current-body-front.png',dest+'/references/current-body-front.png');
for(const [,,ref] of groups)await fs.copyFile(root+'/outfits/'+ref+'.png',dest+'/references/'+ref+'.png');
const card=(file,name)=>`<figure><a href="${file}" download><img src="${file}" alt="${name}"></a><figcaption>${name}</figcaption></figure>`;
const style='*{box-sizing:border-box}body{margin:0;background:#19141f;color:#f8efff;font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif}main{max-width:1250px;margin:auto;padding:36px 24px}h1{color:#ff922e;margin:0;font-size:36px}h2{color:#d4ee72;margin:36px 0 16px}p{color:#d1c1dc}a{color:inherit}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}figure{margin:0;background:#2b2035;border-radius:10px;overflow:hidden}figure a{display:block;background:repeating-conic-gradient(#ddd 0% 25%,#fafafa 0% 50%) 0/24px 24px}figure img{display:block;width:100%;aspect-ratio:1;object-fit:contain}figcaption{padding:10px 14px}nav{display:flex;gap:16px;flex-wrap:wrap}section{margin-bottom:40px}@media(max-width:700px){.grid{grid-template-columns:repeat(2,1fr)}h1{font-size:28px}}';
let html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>万圣节服装 · 25 个拆分部件</title><style>${style}</style><main><h1>万圣节衣橱 · 逐件拆分</h1><p>6 款设计 · 25 张透明底 PNG · 每张带素体，只穿目标部件<br>缝合结构与固定饰边保留在所属衣件；鞋、袜分别成对。</p><nav><a href="../halloween-separated-outfits.zip" download>下载全部拆件</a><a href="references/current-body-front.png">当前素体</a><a href="manifest.json">提示词与来源</a></nav>`;
for(const [group,name,ref] of groups){const assets=m.assets.filter(x=>x.group===group);html+=`<section id="${group}"><h2>${name} · ${assets.length} 件</h2><div class="grid">`+card('references/'+ref+'.png','整套对照 · '+name)+assets.map(x=>card(x.file,x.name)).join('')+'</div></section>';}
html+='<p>图像由内置 image_gen 生成，属于模型制作参考。后续生成的几何仍需适配原始 48 骨素体。</p></main></html>';
await fs.writeFile(dest+'/index.html',html);
await fs.writeFile(dest+'/README.txt','万圣节服装拆件包\n\n6 款设计，共 25 张部件 PNG；每张保留素体且只穿目标部件，均有透明背景。\n女巫 4 件：帽、裙、袜、靴。\n伯爵 5 件：燕尾外套、马甲、领巾、长裤、靴。\n学徒 6 件：软帽、短外套、围裙、短裤、袜、靴。\n独立短裤 1 件。\n幽灵装 4 件：连帽上衣、短裤、袜、鞋。\n南瓜装 5 件：帽、连体衣、内搭上衣、袜、靴。\n\nindex.html 可离线浏览和逐件下载。references 内含六款完整设计与当前原始素体。\n连缝结构、固定饰边不再拆散；成对鞋袜保留同图。\n这些是图像参考，没有制作模型。图片可能有比例偏差，后续以原始素体为准适配几何和骨骼。\n生成方式：内置 image_gen；manifest.json 保存最终提示词与来源，jobs.json 保存初始拆分方案。\n');
let parent=await fs.readFile(root+'/index.html','utf8');if(!parent.includes('separated/index.html'))parent=parent.replace('</header>','<p><a href="separated/index.html">查看 25 个服装拆件</a> · <a href="halloween-separated-outfits.zip" download>下载服装拆件 ZIP</a></p></header>');await fs.writeFile(root+'/index.html',parent);
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
const page=await browser.newPage({viewport:{width:1200,height:1000}});await page.goto('http://127.0.0.1:5199/'+dest+'/index.html');await page.locator('img').evaluateAll(imgs=>Promise.all(imgs.map(img=>img.decode())));
const report=[];
for(const x of m.assets){const stats=await page.evaluate(async file=>{const img=new Image();img.src=file;await img.decode();const canvas=document.createElement('canvas');canvas.width=img.width;canvas.height=img.height;const ctx=canvas.getContext('2d');ctx.drawImage(img,0,0);const {data}=ctx.getImageData(0,0,img.width,img.height);let transparent=0,edge=0;for(let y=0;y<img.height;y++)for(let x=0;x<img.width;x++){const a=data[(y*img.width+x)*4+3];if(a===0)transparent++;if(a>0&&(x===0||y===0||x===img.width-1||y===img.height-1))edge++;}return {width:img.width,height:img.height,transparentRatio:transparent/(img.width*img.height),edge};},x.file);report.push({id:x.id,...stats});}
await fs.writeFile(dest+'/alpha-report.json',JSON.stringify(report,null,2));
for(const [group] of groups)await page.locator('[id="'+group+'"]').screenshot({path:root+'/preview-'+group+'.png'});
console.log(JSON.stringify({components:report.length,transparent:report.every(x=>x.transparentRatio>0.5),noEdgeClipping:report.every(x=>x.edge===0),report},null,2));
}finally{await browser.close();}
