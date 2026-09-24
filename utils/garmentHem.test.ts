import {afterEach,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {fitGarmentHem} from '../apps/room3d/chibi/garmentHem';
import {createBlankBody} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {dressApprovedWardrobe} from '../apps/room3d/chibi/approvedClothing';
function tube(radius:number,bottom:number,top:number){const g=new T.CylinderGeometry(radius,radius,top-bottom,32,24,true);g.translate(0,(top+bottom)/2,0);return new T.SkinnedMesh(g,new T.MeshStandardMaterial());}
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe('upper hem waistband clearance',()=>{
 it.each([.8,1,1.25])('flares over the waistband at body height %s without changing the chest, height or lower garment',height=>{
  const shirt=tube(.3,2.3*height,3.2*height),lower=tube(.4,1.7*height,2.6*height);lower.geometry.computeBoundingBox();const original=Array.from(shirt.geometry.attributes.position.array),bottom=Array.from(lower.geometry.attributes.position.array),uv=Array.from(shirt.geometry.attributes.uv.array);
  expect(fitGarmentHem([shirt],[lower],lower.geometry.boundingBox!,height)).toBeGreaterThan(0);
  const p=shirt.geometry.attributes.position;let waistPoints=0;
  for(let i=0;i<p.count;i++){
   expect(p.getY(i)).toBe(original[i*3+1]);
   if(p.getY(i)>2.86*height)expect([p.getX(i),p.getZ(i)]).toEqual([original[i*3],original[i*3+2]]);
   if(p.getY(i)>2.48*height&&p.getY(i)<2.58*height){expect(Math.hypot(p.getX(i),p.getZ(i))).toBeGreaterThan(.41);waistPoints++;}
  }
  expect(waistPoints).toBeGreaterThan(0);expect(Array.from(lower.geometry.attributes.position.array)).toEqual(bottom);expect(Array.from(shirt.geometry.attributes.uv.array)).toEqual(uv);
 });
 it('leaves a roomy shirt and a cropped top above the waistband unchanged',()=>{
  const lower=tube(.3,1.7,2.5);lower.geometry.computeBoundingBox();
  for(const shirt of [tube(.6,2.2,3.2),tube(.25,2.7,3.2)]){const p=Array.from(shirt.geometry.attributes.position.array);expect(fitGarmentHem([shirt],[lower],lower.geometry.boundingBox!)).toBe(0);expect(Array.from(shirt.geometry.attributes.position.array)).toEqual(p);}
 });
 it('does not invent collisions just above a waistband or inside an already positive gap',()=>{
  const lower=tube(.3,1.7,2.5);lower.geometry.computeBoundingBox();
  // Both were previously expanded: the short hem was projected down onto the
  // waistband, and the close but clear shirt was inflated to a preferred gap.
  for(const shirt of [tube(.25,2.51,3.2),tube(.31,2.2,3.2)]){
   const before=Array.from(shirt.geometry.attributes.position.array);
   expect(fitGarmentHem([shirt],[lower],lower.geometry.boundingBox!)).toBe(0);
   expect(Array.from(shirt.geometry.attributes.position.array)).toEqual(before);
  }
 });
 it('recomputes only the required amount for differently sized lower garments',()=>{
  const maxRadius=(m:T.SkinnedMesh)=>Math.max(...Array.from({length:m.geometry.attributes.position.count},(_,i)=>Math.hypot(m.geometry.attributes.position.getX(i),m.geometry.attributes.position.getZ(i))));
  const radii=[.27,.33,.42].map(r=>{const shirt=tube(.3,2.3,3.2),lower=tube(r,1.7,2.6);lower.geometry.computeBoundingBox();fitGarmentHem([shirt],[lower],lower.geometry.boundingBox!);return maxRadius(shirt);});
  expect(radii[0]).toBeCloseTo(.3);expect(radii[1]).toBeLessThan(radii[2]-.05);
 });
 it('keeps an already flared lower hem intact when only the higher waist needs space',()=>{
  const g=new T.CylinderGeometry(.3,.65,1.2,32,24,true);g.translate(0,2.6,0);
  const shirt=new T.SkinnedMesh(g,new T.MeshStandardMaterial()),lower=tube(.5,2.4,2.7);lower.geometry.computeBoundingBox();
  const before=g.attributes.position.clone(),normals=g.attributes.normal.clone();
  expect(fitGarmentHem([shirt],[lower],lower.geometry.boundingBox!)).toBeGreaterThan(0);
  let preserved=0,adjusted=0;const p=g.attributes.position,n=g.attributes.normal;
  for(let i=0;i<p.count;i++){
   if(before.getY(i)<2.25){expect([p.getX(i),p.getY(i),p.getZ(i)]).toEqual([before.getX(i),before.getY(i),before.getZ(i)]);expect([n.getX(i),n.getY(i),n.getZ(i)]).toEqual([normals.getX(i),normals.getY(i),normals.getZ(i)]);preserved++;}
   if(Math.hypot(p.getX(i)-before.getX(i),p.getZ(i)-before.getZ(i))>.001)adjusted++;
  }
  expect(preserved).toBeGreaterThan(50);expect(adjusted).toBeGreaterThan(0);
 });
 it('keeps a front contact local, without opening the back, hem or coincident material seams',()=>{
  const shirt=tube(.45,1.9,3.2),lower=tube(.25,1.7,2.6),button=new T.SkinnedMesh(new T.BoxGeometry(.08,.08,.08),new T.MeshStandardMaterial());button.geometry.translate(.12,2.43,.44);lower.geometry.computeBoundingBox();
  const before=shirt.geometry.attributes.position.clone();expect(fitGarmentHem([shirt],[lower,button],lower.geometry.boundingBox!)).toBeGreaterThan(0);
  const p=shirt.geometry.attributes.position,seams=new Map<string,number[]>();
  for(let i=0;i<p.count;i++){
   const original=[before.getX(i),before.getY(i),before.getZ(i)],next=[p.getX(i),p.getY(i),p.getZ(i)];
   if(original[2]<0||original[1]<2.2)expect(next).toEqual(original);
   const key=original.map(v=>Math.round(v*1e6)).join(',');if(seams.has(key))next.forEach((v,j)=>expect(v).toBeCloseTo(seams.get(key)![j],6));else seams.set(key,next);
  }
 });
 it('does not inflate a roomy coat because its hidden inward folds overlap lowerwear',()=>{
  const shell=tube(.6,1.9,3.2),lining=tube(.3,2.2,2.8),lower=tube(.4,1.7,2.6);lower.geometry.computeBoundingBox();
  const before=[shell,lining].map(m=>Array.from(m.geometry.attributes.position.array));
  expect(fitGarmentHem([shell,lining],[lower],lower.geometry.boundingBox!)).toBe(0);
  [shell,lining].forEach((m,i)=>expect(Array.from(m.geometry.attributes.position.array)).toEqual(before[i]));
 });
 it.each(['sailor-skirt','lower-long-skirt','lower-shorts'])('preserves the roomy cardigan corners over %s in the complete layering pipeline',async bottom=>{
  vi.stubGlobal('self',globalThis);vi.stubGlobal('createImageBitmap',async()=>({width:1,height:1,close(){}}));
  vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{const bytes=readFileSync(`public/room3d/wardrobe/${String(url).split('/').pop()!.split('?')[0]}`);return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');});
  const root=new T.Group(),hair=new T.Group(),body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial());root.add(body,hair);const rig=bindBlankBody(body,hair,true),items={top:'sailor-short',outer:'slouch-cardigan',bottom};
  const original=await dressApprovedWardrobe(rig,items),source=original.meshes.filter(m=>m.userData.garmentId===items.outer).map(m=>m.geometry.clone());original.dispose();
  const fitted=await dressApprovedWardrobe(rig,items,{},{},true);let hemVertices=0,moved=0,preservedCorners=0,cornerVertices=0;
  fitted.meshes.filter(m=>m.userData.garmentId===items.outer).forEach((m,k)=>{const p=m.geometry.attributes.position,before=source[k].attributes.position;
   for(let i=0;i<p.count;i++){
    expect(p.getY(i)).toBe(before.getY(i));const delta=Math.hypot(p.getX(i)-before.getX(i),p.getZ(i)-before.getZ(i));
    // Wide shorts really touch a few low corners: allow a tiny local fix,
    // while keeping the rest exact instead of expanding the whole hem.
    if(p.getY(i)<1.8){expect(delta).toBeLessThan(.03);cornerVertices++;if(delta===0)preservedCorners++;}
    if(p.getY(i)<2.4){hemVertices++;if(delta>1e-6)moved++;}else expect(delta).toBe(0);
   }
   for(const key of ['skinIndex','skinWeight','uv'])if(source[k].attributes[key])expect(Array.from(m.geometry.attributes[key].array)).toEqual(Array.from(source[k].attributes[key].array));
  });
  expect(preservedCorners).toBeGreaterThan(100);expect(preservedCorners/cornerVertices).toBeGreaterThan(.9);expect(moved/hemVertices).toBeLessThan(.1);
  fitted.dispose();source.forEach(g=>g.dispose());
 });
 it('does not turn the short sailor hem into a wide shelf over straight trousers',async()=>{
  vi.stubGlobal('self',globalThis);vi.stubGlobal('createImageBitmap',async()=>({width:1,height:1,close(){}}));
  vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{const bytes=readFileSync(`public/room3d/wardrobe/${String(url).split('/').pop()!.split('?')[0]}`);return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');});
  const root=new T.Group(),hair=new T.Group(),body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial());root.add(body,hair);const rig=bindBlankBody(body,hair,true),items={top:'sailor-short',bottom:'lower-straight'};
  const original=await dressApprovedWardrobe(rig,items),source=original.meshes.map(m=>m.geometry.clone());original.dispose();
  const fitted=await dressApprovedWardrobe(rig,items,{},{},true);let maxSideMovement=0;
  fitted.meshes.forEach((m,k)=>{if(m.userData.garmentId!==items.top)return;const p=m.geometry.attributes.position,before=source[k].attributes.position;
   for(let i=0;i<p.count;i++)maxSideMovement=Math.max(maxSideMovement,Math.abs(p.getX(i)-before.getX(i)));
  });
  // The false above-waist samples used to apply nearly .30 lateral expansion.
  expect(maxSideMovement).toBeLessThan(.06);
  fitted.dispose();source.forEach(g=>g.dispose());
 });
 it('uses the saved pairing in the shared runtime clothing loader',async()=>{
  vi.stubGlobal('self',globalThis);vi.stubGlobal('createImageBitmap',async()=>({width:1,height:1,close(){}}));
  vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{const bytes=readFileSync(`public/room3d/wardrobe/${String(url).split('/').pop()!.split('?')[0]}`);return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');});
  const root=new T.Group(),hair=new T.Group(),body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial());root.add(body,hair);const rig=bindBlankBody(body,hair,true);
  for(const [bottom,opening] of [['lower-long-skirt',40],['lower-straight',0]] as const){
   const items={top:'basic-tee',bottom},expected=await dressApprovedWardrobe(rig,items,{'basic-tee':{hemOpening:opening}});
   const positions=expected.meshes.filter(m=>m.userData.garmentId==='basic-tee').map(m=>Array.from(m.geometry.attributes.position.array));expected.dispose();
   const paired=await dressApprovedWardrobe(rig,items,{'basic-tee':{hemOpening:99,hemOpeningByBottom:{'lower-long-skirt':40}}});
   expect(paired.meshes.filter(m=>m.userData.garmentId==='basic-tee').map(m=>Array.from(m.geometry.attributes.position.array))).toEqual(positions);paired.dispose();
  }
 });
 it.each([2.6,2.47])('clears a small waistband button at height %s between sparse shirt samples',y=>{
  const g=new T.PlaneGeometry(.6,.9);g.translate(0,2.75,.31);const shirt=new T.SkinnedMesh(g,new T.MeshStandardMaterial()),lower=tube(.2,1.7,2.65);
  const button=new T.SkinnedMesh(new T.BoxGeometry(.07,.06,.12),new T.MeshStandardMaterial());button.geometry.translate(.1,y,.37);lower.geometry.computeBoundingBox();
  expect(fitGarmentHem([shirt],[lower,button],lower.geometry.boundingBox!)).toBeGreaterThan(0);
  const surface=new T.Mesh(g,new T.MeshBasicMaterial({side:T.DoubleSide})),ray=new T.Raycaster(new T.Vector3(.1,y,1),new T.Vector3(0,0,-1));
  expect(ray.intersectObject(surface)[0]?.point.z).toBeGreaterThan(.44);expect(g.attributes.position.count).toBe(4);
 });
 it.each(['sailor-skirt','lower-long-skirt','lower-cargo'])('fits a real T-shirt over %s and restores exactly when disabled',async bottom=>{
  vi.stubGlobal('self',globalThis);vi.stubGlobal('createImageBitmap',async()=>({width:1,height:1,close(){}}));
  vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{const bytes=readFileSync(`public/room3d/wardrobe/${String(url).split('/').pop()!.split('?')[0]}`);return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');});
  const root=new T.Group(),hair=new T.Group(),body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial());root.add(body,hair);const rig=bindBlankBody(body,hair,true),items={top:'basic-tee',bottom};
  const original=await dressApprovedWardrobe(rig,items),source=original.meshes.map(m=>m.geometry.clone());original.dispose();
  const fitted=await dressApprovedWardrobe(rig,items,{},{},true);expect(fitted.layeringReport!.hemAdjustedGarments).toBe(1);
  fitted.meshes.forEach((m,k)=>{const p=m.geometry.attributes.position,before=source[k].attributes.position;
   for(let i=0;i<p.count;i++){expect(p.getY(i)).toBe(before.getY(i));if(m.userData.garmentId===bottom||p.getY(i)>2.86)expect([p.getX(i),p.getZ(i)]).toEqual([before.getX(i),before.getZ(i)]);}
   for(const key of ['skinIndex','skinWeight','uv'])if(source[k].attributes[key])expect(Array.from(m.geometry.attributes[key].array)).toEqual(Array.from(source[k].attributes[key].array));
  });fitted.dispose();
  const restored=await dressApprovedWardrobe(rig,items);restored.meshes.forEach((m,k)=>expect(Array.from(m.geometry.attributes.position.array)).toEqual(Array.from(source[k].attributes.position.array)));restored.dispose();source.forEach(g=>g.dispose());
 });
});
