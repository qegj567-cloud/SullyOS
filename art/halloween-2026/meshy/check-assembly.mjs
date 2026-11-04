import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const b=await chromium.launch({channel:'msedge',headless:true}),errors=[];
const outfit=process.argv[2]||'pumpkin';
try{const p=await b.newPage({viewport:{width:1100,height:1000}});p.on('pageerror',e=>errors.push(e.message));await p.goto('http://127.0.0.1:5199/art/halloween-2026/meshy/assembled/index.html?outfit='+outfit);await p.waitForFunction(()=>window.ready,{},{timeout:60000});
for(const pose of ['costume','bind','reference','arm','knee','head']){await p.selectOption('#pose',pose);for(const view of ['front','side','back']){await p.click('[data-view='+view+']');await p.screenshot({path:`art/halloween-2026/meshy/assembled/${outfit}-${pose}-${view}.png`});}}
console.log(await p.evaluate(()=>({bones:window.fitting.rig.skeleton.bones.length,parts:[...window.fitting.parts].map(([id,a])=>({id,meshes:a.length,triangles:a.reduce((n,m)=>n+m.geometry.index.count/3,0)}))})));
await p.selectOption('#pose','bind');await p.click('[data-view=front]');
const checks=await p.evaluate(()=>{const {parts,rig}=window.fitting,failures=[];let vertices=0;for(const [id,meshes]of parts)for(const m of meshes){if(m.skeleton!==rig.skeleton)failures.push(id+' different skeleton');const g=m.userData.original,p=g.attributes.position,si=g.attributes.skinIndex,sw=g.attributes.skinWeight;vertices+=p.count;for(let i=0;i<p.count;i++){let sum=0;for(let k=0;k<4;k++){const w=sw.getComponent(i,k),bone=si.getComponent(i,k);sum+=w;if(m.name==='Halloween_witch_dress'&&p.getY(i)<2.65&&w>1e-5&&!['hips','chest'].includes(rig.skeleton.bones[bone]?.name))failures.push('Skirt pulled by limb weights');if(!Number.isFinite(w)||w<0||bone<0||bone>=48)failures.push(id+' invalid skin');if((id==='boots'||id==='shoes')&&w>1e-5){const name=rig.skeleton.bones[bone].name;if(!name.startsWith(p.getX(i)>0?'L_':'R_'))failures.push('boot crossed leg');}}if(Math.abs(sum-1)>.0001)failures.push(id+' weight sum');for(let k=0;k<3;k++)if(!Number.isFinite(p.getComponent(i,k)))failures.push(id+' nonfinite vertex');}}
return {vertices,failures};});
const inputs=await p.locator('[data-part]').count();
for(let i=0;i<inputs;i++)await p.locator('[data-part]').nth(i).uncheck();
const undressed=await p.evaluate(()=>({bodyFaces:window.fitting.rig.mesh.geometry.index.count/3,visibleParts:[...window.fitting.parts.values()].flat().filter(m=>m.visible).length}));
if(undressed.bodyFaces!==6136||undressed.visibleParts!==0)checks.failures.push('Undressing did not restore the complete current body');
await p.screenshot({path:`art/halloween-2026/meshy/assembled/${outfit}-undressed.png`});
for(let i=0;i<inputs;i++){const checkbox=p.locator('[data-part]').nth(i),id=await checkbox.getAttribute('data-part');await checkbox.check();await p.screenshot({path:`art/halloween-2026/meshy/assembled/${outfit}-only-${id}.png`});await checkbox.uncheck();}
for(let i=0;i<inputs;i++)await p.locator('[data-part]').nth(i).check();
await p.locator('#body').uncheck();await p.selectOption('#pose','costume');await p.screenshot({path:`art/halloween-2026/meshy/assembled/${outfit}-clothing-only.png`});
if(partsHasBoots(await p.locator('[data-part=boots]').count())&&await p.locator('[data-part=socks]').count()){await p.locator('[data-part=boots]').uncheck();const restored=await p.evaluate(()=>{const m=window.fitting.parts.get('socks')[0];return m.geometry.index.count===m.userData.original.index.count;});if(!restored)checks.failures.push('Removing boots did not restore complete socks');}
checks.undressed=undressed;checks.poseViews=18;checks.pageErrors=errors;await fs.writeFile(`art/halloween-2026/meshy/assembled/${outfit}-checks.json`,JSON.stringify(checks,null,2));
if(outfit==='pumpkin'){
 const cuffCheck=await p.evaluate(()=>{const {parts,rig}=window.fitting,m=parts.get('romper').find(m=>m.name==='Halloween_pumpkin_fitted_shorts');if(!m)return {error:'Missing fitted shorts'};const g=m.geometry,p=g.attributes.position,si=g.attributes.skinIndex,sw=g.attributes.skinWeight;let checked=0;for(let i=0;i<p.count;i++){if(p.getY(i)>=1.97)continue;checked++;const expected=(p.getX(i)>=0?'L':'R')+'_thigh';for(let k=0;k<4;k++)if(sw.getComponent(i,k)>1e-5&&rig.skeleton.bones[si.getComponent(i,k)].name!==expected)return {error:'Cuff does not follow its own thigh'};if(Math.abs(p.getX(i))>.65)return {error:'Spiked cuff silhouette'};}return {checkedVertices:checked,triangles:g.index.count/3};});
 const manifest=JSON.parse(await fs.readFile('art/halloween-2026/meshy/assembled/manifest.json','utf8'));
 if(cuffCheck.error)checks.failures.push(cuffCheck.error);if(manifest.cuffFit.afterMinimumGap<=0)checks.failures.push('Cuff wall intersects rest-pose skin');checks.cuffs={...cuffCheck,restSurface:manifest.cuffFit};await fs.writeFile(`art/halloween-2026/meshy/assembled/${outfit}-checks.json`,JSON.stringify(checks,null,2));
}
if(errors.length||checks.failures.length)throw Error([...errors,...checks.failures].join('\n'));console.log('6 poses × 3 views; skin weights, independent wear/removal, body and sock restoration passed');}finally{await b.close();}
function partsHasBoots(n){return n>0;}
