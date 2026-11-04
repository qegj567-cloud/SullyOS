import * as T from 'three';
import {createBlankBody} from '../../../apps/room3d/chibi/blankBody';
import {bindBlankBody} from '../../../apps/room3d/chibi/blankRig';
import {fitSockSurface} from '../../../apps/room3d/chibi/fitSockSurface';
export function fitApprovedSock(mesh:T.SkinnedMesh){
 const body=new T.Mesh(createBlankBody('skin',{headSize:1,bodyHeight:1}),new T.MeshStandardMaterial()),hair=new T.Group(),root=new T.Group();root.add(body,hair);
 const rig=bindBlankBody(body,hair,true);rig.setPose('bind');root.updateMatrixWorld(true);rig.skeleton.update();
 const oldNames=mesh.skeleton.bones.map(b=>b.name),newNames=rig.skeleton.bones.map(b=>b.name),indices=mesh.geometry.attributes.skinIndex;
 for(let i=0;i<indices.count;i++)for(let k=0;k<4;k++){const mapped=newNames.indexOf(oldNames[indices.getComponent(i,k)]);if(mapped<0)throw Error('Sock bone mismatch');indices.setComponent(i,k,mapped);}
 fitSockSurface(mesh.geometry,rig);
 for(let i=0;i<indices.count;i++)for(let k=0;k<4;k++)indices.setComponent(i,k,oldNames.indexOf(newNames[indices.getComponent(i,k)]));
}
