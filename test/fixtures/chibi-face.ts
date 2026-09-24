import {defaultFace,applyEyePreset,upperStyles,loadFaceImages,composeFace,type EyeState} from '../../apps/room3d/chibi/faceAppearance';
const states:EyeState[]=['open','half','closed','happy'];
const labels=['睁眼','半睁','闭眼','开心闭眼'];
let count=0,checks=0;
try{
 for(const upper of upperStyles){
  const settings={...defaultFace,upper,eye:upper==='04'?'01':upper,lower:upper==='04'?'01':upper};
  const images=await loadFaceImages(settings);
  for(const [i,state] of states.entries()){
   const {eyes,mouth}=composeFace(settings,images,state);
   const c=document.createElement('canvas');c.width=528;c.height=300;
   const ctx=c.getContext('2d')!;ctx.fillStyle='#efd3bb';ctx.fillRect(0,0,c.width,c.height);
   ctx.drawImage(eyes,105,195,264,150,0,0,528,300);ctx.drawImage(mouth,105,195,264,150,0,0,528,300);
   const figure=document.createElement('figure'),caption=document.createElement('figcaption');caption.textContent=`款式 ${upper} · ${labels[i]}`;figure.append(c,caption);document.querySelector('main')!.append(figure);count++;
   // Closed/happy/squint images must be independent of iris, lower-lash and
   // highlight selections. Compare the actual compositor pixels, not mocks.
   if(state==='closed'||state==='happy'||upper==='04'){
    const other={...settings,lower:'none',highlight:'none',irisColor:'#ff0000'};
    const reference=composeFace(other,images,state).eyes.getContext('2d')!.getImageData(0,0,472,472).data;
    const actual=eyes.getContext('2d')!.getImageData(0,0,472,472).data;
    if(actual.some((p,j)=>p!==reference[j]))throw Error(`${upper}/${state}: closed eye leaked a hidden layer`);
    checks++;
   }else{
    // Native 07 deliberately has no highlight. Test an explicitly selected
    // highlight here, without forcing one into its original preset preview.
    const probe={...settings,highlight:'01'},probeImages=await loadFaceImages(probe);
    const plain=composeFace({...probe,highlight:'none'},probeImages,state).eyes.getContext('2d')!.getImageData(0,0,472,472).data;
    const actual=composeFace(probe,probeImages,state).eyes.getContext('2d')!.getImageData(0,0,472,472).data;
    let changed=0;for(let j=0;j<actual.length;j+=4)if(actual[j]!==plain[j]||actual[j+1]!==plain[j+1]||actual[j+2]!==plain[j+2])changed++;
    if(changed<5)throw Error(`${upper}/${state}: highlight is obscured`);
    checks++;
   }
  }
 }
 // Deliberately oversized custom pupil/highlight must be clipped to the iris.
 const settings={...defaultFace,highlight:'01'},images=await loadFaceImages(settings);
 const square=document.createElement('canvas');square.width=square.height=472;const q=square.getContext('2d')!;q.fillStyle='red';q.fillRect(0,0,472,472);
 const huge=new Image();huge.src=square.toDataURL();await huge.decode();
 const base=composeFace(settings,images).eyes.getContext('2d')!.getImageData(0,0,472,472).data;
 const custom=composeFace(settings,{...images,pupilSrc:huge,highlightSrc:huge}).eyes.getContext('2d')!.getImageData(0,0,472,472).data;
 for(let i=3;i<base.length;i+=4)if(custom[i]!==base[i])throw Error('Custom detail escaped its visible eye mask');
 checks++;
 // Every independent facial transform must survive real canvas composition.
 // An oversized pupil/highlight may change color, but never the face silhouette.
 for(const part of ['upper','iris','lower','brow','highlight','pupil','mouth','eyes'] as const){
  const tuned={...settings,adjustments:{[part]:{size:1.3,width:.8,y:6,spacing:part==='eyes'?4:0}}};
  const regular=composeFace(tuned,images),withCustom=composeFace(tuned,{...images,pupilSrc:huge,highlightSrc:huge});
  const a=regular.eyes.getContext('2d')!.getImageData(0,0,472,472).data,b=withCustom.eyes.getContext('2d')!.getImageData(0,0,472,472).data;
  for(let i=3;i<a.length;i+=4)if(a[i]!==b[i])throw Error(`${part}: adjusted detail escaped its mask`);
  const changed=regular[part==='mouth'?'mouth':'eyes'].getContext('2d')!.getImageData(0,0,472,472).data;
  const reference=composeFace(settings,images)[part==='mouth'?'mouth':'eyes'].getContext('2d')!.getImageData(0,0,472,472).data;
  if(part!=='pupil'&&!changed.some((v,i)=>v!==reference[i]))throw Error(`${part}: slider has no visible effect`);
  checks++;
 }
 for(const style of upperStyles){
  const preset=applyEyePreset(defaultFace,style),images=await loadFaceImages(preset),rendered=composeFace(preset,images).eyes;
  const reference=document.createElement('canvas');reference.width=reference.height=472;const r=reference.getContext('2d')!;r.drawImage(images[`original-${style}`],0,0);
  const expected=r.getImageData(0,0,472,472).data,actual=rendered.getContext('2d')!.getImageData(0,0,472,472).data;
  for(let i=3;i<expected.length;i+=4)if(expected[i]!==actual[i])throw Error(`${style}: original preset position/outline changed at pixel ${(i-3)/4}`);
  const card=document.createElement('figure'),label=document.createElement('figcaption'),comparison=document.createElement('canvas');comparison.width=528;comparison.height=150;comparison.style.height="75px";const c=comparison.getContext('2d')!;c.fillStyle='#efd3bb';c.fillRect(0,0,528,150);c.drawImage(reference,105,195,264,150,0,0,264,150);c.drawImage(rendered,105,195,264,150,264,0,264,150);label.textContent=`${style} · 左旧图 / 右还原 · 轮廓逐像素一致`;card.append(comparison,label);document.querySelector('main')!.append(card);checks++;
 }
 document.querySelector('#result')!.textContent=`通过：${count} 个预览；${checks} 项实际像素检查（包括 01–07 与旧图逐像素位置/轮廓对照）。`;
}catch(error){document.querySelector('#result')!.textContent=String(error);throw error;}
