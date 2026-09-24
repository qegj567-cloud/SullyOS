import {afterEach,expect,it,vi} from 'vitest';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshBVH} from 'three-mesh-bvh';
import {createBlankBody} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {dressApprovedWardrobe} from '../apps/room3d/chibi/approvedClothing';
import {approvedGarments,type ApprovedWardrobe} from '../apps/room3d/chibi/approvedWardrobe';
import {planWardrobeChecks} from '../apps/room3d/chibi/wardrobeCheckPlan';
import {createWardrobePose as createStressPose} from '../test/fixtures/legacyWardrobePose';
import {createWardrobePose} from '../experiments/chibi/wardrobePose';

const ids:string[]=JSON.parse(process.env.WARDROBE_CHECK_IDS??'[]');
const poses=['normal','library-idle','boy','cute'] as const;
const digest=(array:ArrayLike<number>)=>createHash('sha256').update(JSON.stringify(Array.from(array))).digest('hex');
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

/** Run explicitly through wardrobe:check; ordinary regression runs stay small.
 * Samples flag visible inner surfaces in a torso window, NOT exact collisions:
 * intentional lapels, cuffs and an open front can also be visible there. */
it.skipIf(!ids.length)('checks the affected wardrobe combinations on the shipped rig',async()=>{
 vi.stubGlobal('self',globalThis);
 vi.stubGlobal('createImageBitmap',async()=>({width:1,height:1,close(){}}));
 vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{
  const bytes=readFileSync(`public/room3d/wardrobe/${String(url).split('/').pop()!.split('?')[0]}`);
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 });
 const plan=planWardrobeChecks(ids);
 console.log(`接入检查开始：${plan.length} 组搭配 × ${poses.length} 种姿势（含旧压力姿势）`);
 type Row={items:ApprovedWardrobe;errors:string[];review:string[];samples:Array<{pose:string;front:number;back:number;side:number}>};
 const rows:Row[]=[];
 for(const items of plan){
  const row:Row={items,errors:[],review:[],samples:[]};rows.push(row);
  const root=new T.Group(),material=new T.MeshStandardMaterial(),body=new T.Mesh(createBlankBody('skin'),material),hair=new T.Group();root.add(body,hair);
  const rig=bindBlankBody(body,hair,true),mixer=new T.AnimationMixer(root);
  let outfit:Awaited<ReturnType<typeof dressApprovedWardrobe>>|undefined;
  const signatures=(meshes:T.SkinnedMesh[])=>meshes.map(m=>Object.fromEntries(['position','uv','skinIndex','skinWeight'].filter(k=>m.geometry.attributes[k]).map(k=>[k,digest(m.geometry.attributes[k].array)])));
  try{
   outfit=await dressApprovedWardrobe(rig,items);
   const baseline=signatures(outfit.meshes);outfit.dispose();
   outfit=await dressApprovedWardrobe(rig,items,{},{},true);
   const fitted=signatures(outfit.meshes);
   outfit.meshes.forEach((m,k)=>{
    const g=m.geometry,p=g.attributes.position;
    for(const a of Object.values(g.attributes))if(Array.from(a.array).some(n=>!Number.isFinite(n)))throw Error(`${m.name}: 非有限顶点数据`);
    if(!g.index||g.index.count%3||Array.from(g.index.array).some(i=>i<0||i>=p.count))throw Error(`${m.name}: 索引损坏`);
    const slot=approvedGarments.find(d=>d.id===m.userData.garmentId)!.slot;
    if(['top','outer','bottom','onepiece'].includes(slot))for(const key of ['uv','skinIndex','skinWeight'])if(baseline[k][key]!==fitted[k][key])throw Error(`${m.name}: 整理修改了 ${key}`);
   });
   for(const id of Object.values(items))if(id&&!outfit.meshes.some(m=>m.userData.garmentId===id&&m.geometry.index!.count))row.review.push(`${id} 全部被遮挡，请核对穿着意图`);
   for(const pose of poses){
    const clip=pose==='boy'||pose==='cute'?createStressPose(rig,pose):createWardrobePose(rig,pose);
    mixer.stopAllAction();mixer.clipAction(clip).play();mixer.setTime(.7);root.updateMatrixWorld(true);rig.skeleton.update();outfit.updatePose();
    const queries:Array<{id:string;g:T.BufferGeometry;tree:MeshBVH}>=[];
    try{
     for(const m of outfit.meshes){
      const g=m.geometry.clone(),p=g.attributes.position,v=new T.Vector3();
      for(let i=0;i<p.count;i++){
       m.getVertexPosition(i,v).applyMatrix4(m.matrixWorld);
       if(![v.x,v.y,v.z].every(Number.isFinite))throw Error(`${m.name}/${pose}: 蒙皮产生非有限坐标`);
       p.setXYZ(i,v.x,v.y,v.z);
      }
      if(!items.outer||![items.top,items.onepiece,items.outer].includes(m.userData.garmentId)||!g.index!.count){g.dispose();continue;}
      // Exclude independent cuff faces from torso samples in bent-arm poses.
      if(m.userData.garmentId!==items.outer){
       const cuff=(i:number)=>[0,1,2,3].reduce((s,j)=>s+(/^[LR]_(forearm|twist|hand)/.test(rig.skeleton.bones[g.attributes.skinIndex.getComponent(i,j)].name)?g.attributes.skinWeight.getComponent(i,j):0),0)>.5;
       const indices:number[]=[];
       for(let t=0;t<g.index!.count;t+=3){const face=[0,1,2].map(j=>g.index!.getX(t+j));if(!face.every(cuff))indices.push(...face);}
       g.setIndex(indices);g.clearGroups();
      }
      if(!g.index!.count){g.dispose();continue;}
      queries.push({id:m.userData.garmentId,g,tree:new MeshBVH(g,{indirect:true})});
     }
     if(items.outer&&(items.top||items.onepiece)){
      const inner=queries.filter(q=>q.id!==items.outer),outer=queries.filter(q=>q.id===items.outer),ray=new T.Ray();
      const depth=(qs:typeof queries)=>Math.min(Infinity,...qs.map(q=>q.tree.raycastFirst(ray,T.DoubleSide)?.distance??Infinity));
      const sample={pose,front:0,back:0,side:0};
      for(const view of ['front','back','side'] as const){
       for(let u=-.6;u<=.6;u+=.025)for(let y=2.38;y<=3.38;y+=.025){
        if(view==='front'&&Math.abs(u)<.30)continue;
        if(view==='side'){ray.origin.set(8,y,u);ray.direction.set(-1,0,0);}
        else {ray.origin.set(u,y,view==='front'?8:-8);ray.direction.set(0,0,view==='front'?-1:1);}
        const a=depth(inner),b=depth(outer);if(Number.isFinite(b)&&a<b-.001&&b-a<.45)sample[view]++;
       }
      }
      row.samples.push(sample);
      if(sample.front+sample.back+sample.side>0)row.review.push(`${pose} 内搭先于外套的采样：正 ${sample.front} / 背 ${sample.back} / 侧 ${sample.side}（需看图确认）`);
     }
    }finally{queries.forEach(q=>q.g.dispose());}
   }
   if(outfit.layeringReport?.skippedMaterials)row.review.push('含跳过自动遮挡的材质，需检查透明/贴图开口');
   outfit.dispose();
   if(rig.mesh.geometry!==rig.baseGeometry)throw Error('脱衣后未恢复素体');
   outfit=await dressApprovedWardrobe(rig,items);
   if(JSON.stringify(signatures(outfit.meshes))!==JSON.stringify(baseline))throw Error('关闭整理后未恢复原始服装，或源缓存被修改');
  }catch(error){row.errors.push(error instanceof Error?error.message:String(error));}
  finally{outfit?.dispose();mixer.stopAllAction();mixer.uncacheRoot(root);rig.baseGeometry.dispose();material.dispose();rig.skeleton.dispose();}
  if(rows.length%25===0)console.log(`接入检查进度：${rows.length}/${plan.length}`);
 }
 const failed=rows.filter(r=>r.errors.length),flagged=rows.filter(r=>r.review.length);
 const report={ids,combinations:rows.length,poses:[...poses],failed:failed.length,flagged:flagged.length,
  limits:'默认身高和版型；普通站姿、开源自然待机及 boy/cute 两个已退役的测试压力姿势。每段采样 0.7 秒，非完整动作扫描。正背/右侧躯干采样仅供排查，非全表面碰撞证明；下摆、裤裙、鞋袜、配饰及其他角度仍须视觉验收。图片解码被替代，保留原材质属性；未检查贴图透明像素。',rows};
 mkdirSync('output/wardrobe-check',{recursive:true});
 writeFileSync('output/wardrobe-check/latest.json',JSON.stringify(report,null,2)+'\n');
 const names=(w:ApprovedWardrobe)=>Object.values(w).filter(Boolean).map(id=>approvedGarments.find(g=>g.id===id)?.label??id).join(' + ');
 writeFileSync('output/wardrobe-check/latest.md',[
  '# 服装接入检查',`\n检查 ${rows.length} 组搭配 × ${poses.length} 种姿势；数据失败 ${failed.length} 组，采样/遮挡提示 ${flagged.length} 组。`,
  `\n${report.limits}`, '\n## 需要优先复核',
  ...rows.filter(r=>r.errors.length||r.review.length).map(r=>`\n- **${names(r.items)}**：${[...r.errors,...r.review].join('；')}`),
  '\n## 全部检查组合','\n| 搭配 | 数据检查 | 视觉验收 |','| --- | --- | --- |',
  ...rows.map(r=>`| ${names(r.items)} | ${r.errors.length?'失败':'通过'} | ${r.review.length?'优先看图':'待看图（无采样提示不等于无穿模）'} |`),'',
 ].join('\n'));
 console.log(`服装接入检查：${rows.length} 组，数据失败 ${failed.length}，需优先复核 ${flagged.length}。报告：output/wardrobe-check/latest.md`);
 expect(failed,JSON.stringify(failed)).toHaveLength(0);
},600_000);

