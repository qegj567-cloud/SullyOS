import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {createBlankBody} from '../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../apps/room3d/chibi/blankRig';
import {dressApprovedWardrobe} from '../apps/room3d/chibi/approvedClothing';
import {createWardrobePose} from '../experiments/chibi/wardrobePose';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
it('keeps exposed skin on its original animated surface across shorts and sock mask boundaries',async()=>{
 vi.stubGlobal('self',globalThis);vi.stubGlobal('createImageBitmap',async()=>({width:1,height:1,close(){}}));
 vi.spyOn(GLTFLoader.prototype,'loadAsync').mockImplementation(async url=>{const bytes=readFileSync(`public/room3d/wardrobe/${String(url).split('/').pop()!.split('?')[0]}`);return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');});
 const root=new T.Group(),body=new T.Mesh(createBlankBody('skin'),new T.MeshStandardMaterial()),hair=new T.Group();root.add(body,hair);
 const rig=bindBlankBody(body,hair,true),original=rig.baseGeometry;
 const outfit=await dressApprovedWardrobe(rig,{bottom:'sailor-shorts',socks:'original-socks',shoes:'original-shoes'});
 const masked=rig.mesh.geometry;
 // The regression used to generate hundreds of midpoint vertices around the
 // knees. Averaged weights bend those midpoints off their parent triangle.
 expect(masked.attributes.position.count).toBe(original.attributes.position.count);
 const faces=new Set<string>();for(let i=0;i<original.index!.count;i+=3)faces.add([0,1,2].map(j=>original.index!.getX(i+j)).join(','));
 for(let i=0;i<masked.index!.count;i+=3)expect(faces.has([0,1,2].map(j=>masked.index!.getX(i+j)).join(','))).toBe(true);
 const reference=new T.SkinnedMesh(original,body.material);root.add(reference);reference.bind(rig.skeleton,rig.mesh.bindMatrix);
 const mixer=new T.AnimationMixer(root);mixer.clipAction(createWardrobePose(rig,'library-idle')).play();
 const a=new T.Vector3(),b=new T.Vector3();
 for(const t of [0,.7,1.6,2.5]){
  mixer.setTime(t);root.updateMatrixWorld(true);rig.skeleton.update();
  for(const id of new Set(Array.from(masked.index!.array)))if(original.attributes.position.getY(id)<2.1){
   rig.mesh.getVertexPosition(id,a);reference.getVertexPosition(id,b);expect(a.distanceTo(b)).toBeLessThan(1e-7);
  }
 }
 expect(masked.index!.count).toBeLessThan(original.index!.count);
 outfit.dispose();expect(rig.mesh.geometry).toBe(original);
 mixer.stopAllAction();original.dispose();body.material.dispose();rig.skeleton.dispose();
});
