import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const out=process.env.HOME_PHOTO_QA_DIR;if(!out)throw Error('Set HOME_PHOTO_QA_DIR');await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(120000);
const report={errors:[],poses:[]};page.on('pageerror',e=>report.errors.push(e.message));
try{
 await page.goto((process.env.HOME_PHOTO_QA_URL||'http://127.0.0.1:5206')+'/test/fixtures/room3d-photo.html?photo'+(process.env.PHOTO_CLASSIC?'&classic':'')+(process.env.PHOTO_EXTREME?'&extreme':''));
 await page.locator('.photo-view').waitFor();
 const result=await page.evaluate(async()=>{
  const editor=window.__homeEditor,{photoLooks}=await import('/apps/room3d/photoEffects.ts'),{photoPairs}=await import('/apps/room3d/chibi/photoPairPose.ts');
  const actors=editor.beginPhotoMode();editor.setRomanticRelation(actors[0].id,actors[1].id,true);
  editor.setPhotoCamera({yaw:0,pitch:2,zoom:1.25,height:1.35,pan:0});
  const sheet=document.createElement('canvas');sheet.width=1500;sheet.height=1000;const ctx=sheet.getContext('2d'),rows=[];
  for(const [i,p] of photoPairs.entries()){
   await editor.setPhotoInteraction(p.id,actors[0].id,actors[1].id,p.defaultTime);
   const c=document.createElement('canvas');editor.renderPhoto(c,photoLooks.natural,{quality:'preview',aspect:1});
   ctx.drawImage(c,i%3*500,Math.floor(i/3)*500,500,500);ctx.fillStyle='#fff';ctx.fillRect(i%3*500,Math.floor(i/3)*500+467,500,33);ctx.fillStyle='#222';ctx.font='20px sans-serif';ctx.fillText(p.label,i%3*500+15,Math.floor(i/3)*500+490);
   rows.push({id:p.id,positions:editor.inspect().residentPositions});
  }
  return {image:sheet.toDataURL(),rows};
 });
 report.poses=result.rows;await fs.writeFile(out+'/pair-sheet.png',Buffer.from(result.image.split(',')[1],'base64'));
 report.audit=await page.evaluate(async()=>{
  const T=await import('/node_modules/three/build/three.module.js'),{photoPairs}=await import('/apps/room3d/chibi/photoPairPose.ts');
  const e=window.__homeEditor,people=window.__photoVisitors,actors=e.beginPhotoMode(),bones=people.flatMap(p=>Object.values(p.rig?.bones??{})),lengths=bones.map(b=>b.position.clone()),rows=[];
  for(const pose of photoPairs)for(const yaw of [-90,0,110])for(const time of [0,1.5,3.5,5.95]){
   await e.setPhotoInteraction(pose.id,actors[0].id,actors[1].id,time);e.setPhotoCamera({yaw});
   const direction=new T.Vector3(Math.sin(yaw*Math.PI/180),0,Math.cos(yaw*Math.PI/180));
   const facing=people.map(p=>p.rig?new T.Vector3(0,0,1).applyQuaternion(p.rig.bones.head.getWorldQuaternion(new T.Quaternion())).dot(direction):1);
   const heads=people.map(p=>p.getHeadWorldPosition()),right=new T.Vector3(direction.z,0,-direction.x),gap=Math.abs(heads[1].clone().sub(heads[0]).dot(right));
   if(facing.some(f=>f<.99)||(gap<.5||gap>2.2)||bones.some((b,i)=>b.position.distanceTo(lengths[i])>1e-7)||bones.some(b=>!b.quaternion.toArray().every(Number.isFinite)))throw Error('Pose audit failed '+pose.id+' '+yaw+' '+time);
   rows.push({id:pose.id,yaw,time,gap,facing});
  }
  e.setPhotoCamera({yaw:0});return rows;
 });
 await page.getByRole('button',{name:'动作',exact:true}).click();await page.getByRole('button',{name:/^双人互动 ·/}).click();
 await page.getByRole('button',{name:/^双倍耶！/}).click();await page.locator('.photo-action-preview').waitFor();
 await page.screenshot({path:out+'/photo-pair-ui.png'});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:out+'/photo-pair-phone.png'});
 await page.getByRole('button',{name:'选择动作',exact:true}).click();await page.getByRole('button',{name:'镜头',exact:true}).click();await page.getByRole('button',{name:'奶油拍立得',exact:true}).click();
 await page.getByRole('button',{name:'拍下合影',exact:true}).click();await page.locator('.photo-result img').waitFor();
 report.export=await page.locator('.photo-result img').evaluate(async img=>{await img.decode();return [img.naturalWidth,img.naturalHeight];});assert.equal(report.export[0]/report.export[1],.8);
 await page.getByRole('button',{name:'退出拍照',exact:true}).click();assert.equal(await page.locator('.home-photo-mode').count(),0);
 assert.deepEqual(report.errors,[]);
}catch(e){report.failure=String(e);await page.screenshot({path:out+'/failure.png'});process.exitCode=1;}
finally{await fs.writeFile(out+'/report.json',JSON.stringify(report,null,2));console.log({errors:report.errors,failure:report.failure,poses:report.poses.length,audit:report.audit?.length,export:report.export});await browser.close();}
