import fs from "node:fs/promises";
const root="art/halloween-2026/";
const additions=JSON.parse(await fs.readFile(root+"additional-outfits-prompts.json","utf8")).assets;
const manifest=JSON.parse(await fs.readFile(root+"manifest.json","utf8"));
for(const item of additions){await fs.copyFile(item.source,root+item.file);manifest.assets=manifest.assets.filter(x=>x.id!==item.id);manifest.assets.push(item);}
await fs.writeFile(root+"manifest.json",JSON.stringify(manifest,null,2));
let html=await fs.readFile(root+"index.html","utf8");html=html.replaceAll("3 套","6 套").replaceAll("halloween-design-pack.zip","halloween-design-pack-v2.zip");
if(!html.includes("04-halloween-shorts.png")){const cards=additions.map(e=>`<figure><a href="${e.file}" download><img src="${e.file}" alt="${e.name}" loading="lazy"></a><figcaption>${e.name}</figcaption></figure>`).join("");html=html.replace('</div><p class="note">',cards+'</div><p class="note">');}
await fs.writeFile(root+"index.html",html);
let readme=await fs.readFile(root+"README.txt","utf8");readme=readme.replaceAll("3 套","6 套").replaceAll("这三张","这些图").replaceAll("15 张","18 张");if(!readme.includes("04 万圣节蝙蝠短裤"))readme+="\n追加服装：04 万圣节蝙蝠短裤（素体仅穿短裤，便于提取下装）；05 幽灵连帽装；06 南瓜连体装。均为同一当前素体参考的正面 T 姿透明底 PNG。新增提示词另见 additional-outfits-prompts.json，亦已合并进 manifest.json。\n";await fs.writeFile(root+"README.txt",readme);
