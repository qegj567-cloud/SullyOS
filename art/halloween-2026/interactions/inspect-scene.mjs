import {chromium} from 'file:///C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const browser=await chromium.launch({channel:'msedge',headless:true});
try{const p=await browser.newPage({viewport:{width:1400,height:1000}});await p.goto('http://127.0.0.1:5202/test/fixtures/room3d-social.html');await p.waitForFunction(()=>window.__social?.visitors.length===3);await p.getByRole('button',{name:'暂停',exact:true}).click();
 console.log(JSON.stringify(await p.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js'),{faceSocialPoint}=await import('/apps/room3d/chibi/faceSocialContact.ts');
  const {runtime:r,visitors:v,camera,controls}=window.__social;camera.position.set(5,2.5,0);controls.target.set(0,1.6,0);controls.update();
  await r.start('halloween-ghost-tease','user','character');r.seek(r.inspect().session.duration-9.2+4.1);
  const root=v[0].root.parent.getObjectByName('halloween-social-props'),objects=[];root.traverse(o=>objects.push({name:o.name,type:o.type,visible:o.visible,pos:o.getWorldPosition(new T.Vector3()).toArray(),box:o.isMesh?new T.Box3().setFromObject(o).getSize(new T.Vector3()).toArray():null}));
  return {objects,face:v.slice(0,2).map(x=>({mouth:faceSocialPoint(x,'home-kiss').toArray(),forehead:faceSocialPoint(x,'home-forehead-touch').toArray(),head:x.getHeadWorldPosition().toArray(),meshWorld:x.rig.mesh.matrixWorld.elements,skinMax:x.rig.mesh.geometry.boundingBox?.max.toArray()}))};
 })));await p.locator('.stage').screenshot({path:'art/halloween-2026/interactions/ghost-side.png'});
 await p.evaluate(async()=>{const {runtime:r}=window.__social;r.reset();await r.start('home-kiss','user','character');r.seek(r.inspect().session.duration-9.2+4.1);});await p.locator('.stage').screenshot({path:'art/halloween-2026/interactions/kiss-side.png'});
}finally{await browser.close();}
