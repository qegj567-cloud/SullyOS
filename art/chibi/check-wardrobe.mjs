import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const args=process.argv.slice(2),catalog=JSON.parse(fs.readFileSync(path.join(root,'apps/room3d/chibi/approvedWardrobe.json'),'utf8'));
if(!args.length||args.includes('--help')){
 console.log('用法：pnpm wardrobe:check <服装ID...> | --all\n逐件生成相关搭配，检查正式资产、三种站姿与疑似穿插，报告写入 output/wardrobe-check。\n--all 用于修改共用叠穿算法后的完整接入检查。');
 process.exit(args.length?0:1);
}
if(args.includes('--all')&&args.length!==1)throw Error('--all 不能和服装 ID 混用');
const ids=args[0]==='--all'?catalog.map(g=>g.id):[...new Set(args)];
for(const id of ids)if(!catalog.some(g=>g.id===id))throw Error(`未知服装：${id}`);
// No shell interpolation; arguments are passed in an environment value.
const checks=['utils/wardrobeCheckPlan.test.ts','utils/wardrobeAcceptance.test.ts'];
if(args[0]==='--all')checks.push(...[
 'garmentMotionFit','closeFootwearSeams','clothingMaskMotion','garmentCollar','originalWardrobe','garmentHem','garmentFit','garmentLayering',
 'wardrobeSwap','wardrobeColors','approvedWardrobe','wardrobePose','wardrobeFootwear',
].map(name=>`utils/${name}.test.ts`));
const result=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--no-cache',...checks],{
 cwd:root,stdio:'inherit',env:{...process.env,WARDROBE_CHECK_IDS:JSON.stringify(ids)},
});
if(result.error)throw result.error;
process.exit(result.status??1);

