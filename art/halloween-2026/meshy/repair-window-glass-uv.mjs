import fs from 'node:fs/promises';import{createRequire}from'node:module';import{createHash}from'node:crypto';
const require=createRequire(new URL('../../../tmp/halloween-compress/package.json',import.meta.url));const{NodeIO}=require('@gltf-transform/core');const{ALL_EXTENSIONS}=require('@gltf-transform/extensions');const io=new NodeIO().registerExtensions(ALL_EXTENSIONS),base='art/halloween-2026/meshy',file=base+'/furniture-textured-runtime/halloween_gothic_curtain_window.glb';
const doc=await io.read(file),fit=doc.getRoot().listNodes().find(n=>n.getName()==='furniture-fit'),scale=fit.getScale(),translation=fit.getTranslation(),buffer=doc.getRoot().listBuffers()[0];let removed=0,added=0;
const worldX=v=>v.POSITION[0]*scale[0]+translation[0];
function clip(vertices,left){const out=[];for(let i=0;i<vertices.length;i++){const a=vertices[i],b=vertices[(i+1)%vertices.length],ax=worldX(a),bx=worldX(b),inside=left?ax<=0:ax>=0,next=left?bx<=0:bx>=0;if(inside)out.push(a);if(inside!==next){const t=ax/(ax-bx),v={};for(const key of Object.keys(a))v[key]=a[key].map((value,k)=>value+(b[key][k]-value)*t);out.push(v);}}return out;}
for(const mesh of doc.getRoot().listMeshes())for(const p of [...mesh.listPrimitives()]){
 const ids=p.getIndices().getArray(),semantics=p.listSemantics(),keep=[],newVertices=[];
 const vertex=id=>Object.fromEntries(semantics.map(key=>[key,p.getAttribute(key).getElement(id,[])]));
 const emit=(polygon,back)=>{for(let i=1;i+1<polygon.length;i++){const tri=back?[polygon[0],polygon[i+1],polygon[i]]:[polygon[0],polygon[i],polygon[i+1]];for(const point of tri){const v=structuredClone(point);if(back){v.POSITION[2]=(-.1277442-translation[2])/scale[2];if(v.NORMAL)v.NORMAL=[0,0,1];}newVertices.push(v);}added++;}};
 for(let i=0;i<ids.length;i+=3){const tri=Array.from(ids.slice(i,i+3)),vs=tri.map(vertex),zs=vs.map(v=>v.POSITION[2]*scale[2]+translation[2]),cy=vs.reduce((s,v)=>s+v.POSITION[1]*scale[1]+translation[1],0)/3,plane=Math.max(...zs)-Math.min(...zs)<.0001&&cy>.55,left=vs.some(v=>worldX(v)<0);
  if(plane&&left&&Math.abs(zs[0]+.1277442)<.001){removed++;emit(clip(vs,false),false);continue;}
  keep.push(...tri);if(plane&&left&&Math.abs(zs[0]+.1580994)<.001)emit(clip(vs,true),true);
 }
 if(!newVertices.length)continue;
 p.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(keep)).setBuffer(buffer));
 const replacement=doc.createPrimitive().setMaterial(p.getMaterial()).setExtras({repair:'window-left-glass-clean-uv'});
 for(const key of semantics)replacement.setAttribute(key,doc.createAccessor().setType(p.getAttribute(key).getType()).setArray(new Float32Array(newVertices.flatMap(v=>v[key]))).setBuffer(buffer));
 replacement.setIndices(doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(newVertices,(_,i)=>i)).setBuffer(buffer));mesh.addPrimitive(replacement);
}
if(!removed||!added)throw Error('Expected left pane triangles not found; run after overlap repair, before compression.');
await io.write(file,doc);const bytes=await fs.readFile(file),reportPath=base+'/furniture-texture-report.json',report=JSON.parse(await fs.readFile(reportPath,'utf8')),row=report.find(r=>r.entry.id==='halloween_gothic_curtain_window');row.entry.revision=createHash('sha256').update(bytes).digest('hex').slice(0,12);row.bytes=bytes.length;row.triangles+=added-removed;row.repair='overlap-removed-and-left-pane-clean-back-uv';await fs.writeFile(reportPath,JSON.stringify(report,null,2));console.log({removed,added});
