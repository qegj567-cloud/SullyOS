import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshBVH} from 'three-mesh-bvh';
import {createBlankBody} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {dressApprovedWardrobe} from '../apps/room3d/chibi/approvedClothing';
import {createWardrobePose} from '../experiments/chibi/wardrobePose';
import {createGarmentMotionFit} from '../apps/room3d/chibi/garmentMotionFit';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
function setup(){
 vi.stubGlobal('self',globalThis);vi.stubGlobal('createImageBitmap',async()=>({width:1,height:1,close(){}}));
 vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{const b=readFileSync(`public/room3d/wardrobe/${String(url).split('/').pop()!.split('?')[0]}`);return new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');});
 const root=new T.Group(),body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial()),hair=new T.Group();root.add(body,hair);const rig=bindBlankBody(body,hair,true);
 return {root,rig,dispose(){rig.baseGeometry.dispose();body.material.dispose();rig.skeleton.dispose();}};
}
function leaks(inner:T.SkinnedMesh[],outer:T.SkinnedMesh[],rig:ReturnType<typeof bindBlankBody>){
 const chest=rig.skeleton.bones.findIndex(b=>b.name==='chest'),frame=rig.mesh.bindMatrixInverse.clone().multiply(new T.Matrix4().fromArray(rig.skeleton.boneMatrices!,chest*16)).multiply(rig.mesh.bindMatrix).invert();
 const queries=(meshes:T.SkinnedMesh[])=>meshes.filter(m=>m.geometry.index!.count).map(m=>{const g=m.geometry.clone(),p=g.attributes.position,v=new T.Vector3();for(let i=0;i<p.count;i++){m.getVertexPosition(i,v).applyMatrix4(frame);p.setXYZ(i,v.x,v.y,v.z);}return {g,tree:new MeshBVH(g,{indirect:true})};});
 const a=queries(inner),b=queries(outer),ray=new T.Ray(new T.Vector3(),new T.Vector3(0,0,-1));let count=0;
 for(let x=-.65;x<=.65;x+=.025)for(let y=2.55;y<=3.3;y+=.025){ray.origin.set(x,y,5);const di=Math.min(...a.map(q=>q.tree.raycastFirst(ray,T.DoubleSide)?.distance??Infinity)),doo=Math.min(...b.map(q=>q.tree.raycastFirst(ray,T.DoubleSide)?.distance??Infinity));if(doo<4.985&&di<doo-.003&&doo-di<.4)count++;}
 [...a,...b].forEach(q=>q.g.dispose());return count;
}
it.each([['normal',0],['library-idle',.94],['sachi-idle',2.4],['sachi-speaking',1],['fumi-pose',6]] as const)('reduces real shirt/cardigan protrusion in %s without changing outer, weights or skin',async(motion,time)=>{
 const {root,rig,dispose}=setup(),bodyGeometry=rig.mesh.geometry;
 const outfit=await dressApprovedWardrobe(rig,{top:'stand-collar',outer:'slouch-cardigan',bottom:'sailor-shorts'},{},{},true),masked=rig.mesh.geometry;
 const outer=outfit.meshes.filter(m=>m.userData.garmentId==='slouch-cardigan'),inner=outfit.meshes.filter(m=>m.userData.garmentId==='stand-collar');
 const attrs=(meshes:T.SkinnedMesh[],names:string[])=>meshes.map(m=>names.map(n=>Array.from(m.geometry.attributes[n]?.array??[])));
 const outerBefore=attrs(outer,['position','normal']),weights=attrs(inner,['skinWeight','skinIndex','uv']),indices=inner.map(m=>Array.from(m.geometry.index!.array)),base=attrs(inner,['position']);
 const mixer=new T.AnimationMixer(root);mixer.clipAction(createWardrobePose(rig,motion)).play();mixer.setTime(time);root.updateMatrixWorld(true);rig.skeleton.update();
 const before=leaks(inner,outer,rig);outfit.updatePose();const after=leaks(inner,outer,rig);
 console.log(`${motion}: front contact samples ${before} -> ${after}`);
 expect(after).toBeLessThanOrEqual(Math.max(8,before*.3));
 const first=attrs(inner,['position']);expect(attrs(outer,['position','normal'])).toEqual(outerBefore);expect(attrs(inner,['skinWeight','skinIndex','uv'])).toEqual(weights);expect(inner.map(m=>Array.from(m.geometry.index!.array))).toEqual(indices);expect(rig.mesh.geometry).toBe(masked);
 // Independent cuff meshes and vertices beyond the torso retain their original shape.
 inner.forEach((m,k)=>{for(let i=0;i<m.geometry.attributes.position.count;i++){const x=base[k][0][i*3],y=base[k][0][i*3+1];if(Math.abs(x)>=.85||y<=2.05||y>=3.4)expect(Array.from(m.geometry.attributes.position.array).slice(i*3,i*3+3)).toEqual(base[k][0].slice(i*3,i*3+3));}});
 mixer.setTime(time+.5);outfit.updatePose();mixer.setTime(time);outfit.updatePose();expect(attrs(inner,['position'])).toEqual(first);
 // Root transforms must not change local fitting (room placement / preview turn).
 root.rotation.y=.9;root.position.set(3,.2,-2);root.scale.setScalar(.7);outfit.updatePose();
 attrs(inner,['position']).forEach((a,k)=>a[0].forEach((v,j)=>expect(v).toBeCloseTo(first[k][0][j],4)));
 outfit.dispose();expect(rig.mesh.geometry).toBe(bodyGeometry);outfit.updatePose();mixer.stopAllAction();
 const restored=await dressApprovedWardrobe(rig,{top:'stand-collar',outer:'slouch-cardigan',bottom:'sailor-shorts'},{},{},true);expect(attrs(restored.meshes.filter(m=>m.userData.garmentId==='stand-collar'),['position'])).toEqual(base);restored.dispose();dispose();
});
it('skips transparent and textured outers',()=>{
 const {rig,dispose}=setup(),g=new T.BufferGeometry(),mat=new T.MeshStandardMaterial({transparent:true}),outer=new T.SkinnedMesh(g,mat);
 expect(createGarmentMotionFit(rig,[outer],[outer])).toBeUndefined();mat.transparent=false;mat.map=new T.Texture();expect(createGarmentMotionFit(rig,[outer],[outer])).toBeUndefined();mat.map.dispose();mat.dispose();g.dispose();dispose();
});
