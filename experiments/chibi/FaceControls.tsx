import React,{useState,useEffect,useRef} from 'react';
import {cleanFace,applyEyePreset,defaultFace,loadFaceImages,composeFace,eyeStyles,upperStyles,mouthStyles,faceAssets,type FaceSettings} from '../../apps/room3d/chibi/faceAppearance';
import type {MouthUse} from '../../apps/room3d/chibi/faceAdjustments';
import type {HairSettings} from '../../apps/room3d/chibi/types';
import {FaceTuning} from './FaceTuning';
function EyeStylePreview({style,color}:{style:string;color:string}){
 const ref=useRef<HTMLCanvasElement>(null);
 useEffect(()=>{let cancelled=false;const settings={...applyEyePreset(defaultFace,style),brow:'none',irisColor:color};
  loadFaceImages(settings).then(images=>{if(cancelled||!ref.current)return;const ctx=ref.current.getContext('2d')!;ctx.clearRect(0,0,254,100);ctx.drawImage(composeFace(settings,images).eyes,110,225,254,100,0,0,254,100);}).catch(()=>{});
  return()=>{cancelled=true;};
 },[style,color]);
 return <canvas ref={ref} width={254} height={100} aria-hidden="true"/>;
}
export function FaceControls({section,hair,onChange,onBegin,onEnd,mouthUse,onMouthUse}:{section:'eyes'|'brows'|'mouth';hair:HairSettings;onChange:(v:HairSettings)=>void;onBegin:()=>void;onEnd:()=>void;mouthUse:MouthUse;onMouthUse:(v:MouthUse)=>void}){
 const f=cleanFace(hair.face),[error,setError]=useState(''),[eyeTab,setEyeTab]=useState<'style'|'upper'|'iris'|'highlight'|'lower'|'pupil'>('style');
 const update=(patch:Partial<FaceSettings>)=>onChange({...hair,face:{...f,enabled:true,...patch}});
 const tuning=(part:Parameters<typeof FaceTuning>[0]['part'],label:string)=><FaceTuning {...{part,label,hair,onChange,onBegin,onEnd}}/>;
 const choiceGrid=(label:string,key:'upper'|'eye'|'lower'|'brow'|'highlight',choices:string[],prefix:string)=><div className="face-choice-grid" aria-label={label}>{choices.map(id=>{
  const asset=id==='none'?undefined:faceAssets[`${prefix}-${id==='original'?`original-${f.upper}`:id}${prefix==='upper'?(id==='04'?'-closed':'-open'):prefix==='iris'?'-open':''}`];
  return <button key={id} aria-label={`${label} ${id==='none'?'无':id==='original'?'原款':id}`} aria-pressed={f[key]===id} onClick={()=>update({[key]:id})}>{asset?<span className="face-art"><img alt="" src={`${import.meta.env.BASE_URL}${asset.src}`}/></span>:<span className="face-art face-none">—</span>}<span>{id==='none'?'无':id==='original'?'原款':id==='04'&&key==='upper'?'04 眯眯眼':id}</span></button>;
 })}</div>;
 const upload=async(key:'pupilSrc'|'highlightSrc',file?:File)=>{if(!file)return;try{setError('');if(file.size>2*1024*1024)throw Error('请选择小于 2 MB 的透明图片');const src=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result));r.onerror=reject;r.readAsDataURL(file);});const image=new Image();image.src=src;await image.decode();update({[key]:src});}catch(e){setError(String(e));}};
 const custom=(key:'pupilSrc'|'highlightSrc',label:string)=><details><summary>使用自己的{label}</summary><p>上传 472 × 472 透明图片，超出眼睛的部分自动遮住。</p><label className="hair-upload">上传{label}<input type="file" aria-label={`上传${label}`} accept="image/png,image/webp" onChange={e=>{void upload(key,e.target.files?.[0]);e.target.value='';}}/></label>{f[key]&&<button onClick={()=>update({[key]:undefined})}>移除自定义{label}</button>}</details>;
 return <section className="face-controls" aria-label={section==='eyes'?'眼睛设置':section==='brows'?'眉毛设置':'嘴型设置'}>
  {section==='eyes'&&<>
   <nav className="face-subnav" aria-label="眼睛部件">{([['style','眼型'],['upper','上睫毛'],['iris','眼珠'],['highlight','高光'],['lower','下睫毛'],['pupil','瞳孔']] as const).map(([key,label])=><button aria-pressed={eyeTab===key} key={key} onClick={()=>setEyeTab(key)}>{label}</button>)}</nav>
   {eyeTab==='style'&&<><h2>先选眼睛的整体样子</h2><p>点击 01—07 恢复原款完整眼型和位置；之后可再微调或混搭。</p><div className="face-choice-grid" aria-label="眼型款式">{upperStyles.map(id=><button key={id} aria-label={`眼型 ${id}`} aria-pressed={f.upper===id&&(id==='04'||f.eye===id)} onClick={()=>update(applyEyePreset(f,id))}><span className="face-art"><EyeStylePreview style={id} color={f.irisColor}/></span><span>{id==='04'?'04 眯眯眼':id}</span></button>)}</div></>}
   {eyeTab==='upper'&&<><h2>上睫毛</h2>{choiceGrid('上睫毛款式','upper',upperStyles,'upper')}{tuning('upper','上睫毛')}</>}
   {eyeTab==='iris'&&<><h2>眼珠</h2>{choiceGrid('眼珠款式','eye',eyeStyles,'iris')}<label className="creator-select">眼睛颜色<input aria-label="眼睛颜色" type="color" value={f.irisColor} onChange={e=>update({irisColor:e.target.value})}/></label>{tuning('iris','眼珠')}</>}
   {eyeTab==='highlight'&&<><h2>高光</h2>{choiceGrid('高光款式','highlight',['original','none','01','02','03','04','05','06','07'],'highlight')}{tuning('highlight','高光')}{custom('highlightSrc','高光')}</>}
   {eyeTab==='lower'&&<><h2>下睫毛</h2>{choiceGrid('下睫毛款式','lower',['none',...eyeStyles],'lower')}{tuning('lower','下睫毛')}</>}
   {eyeTab==='pupil'&&<><h2>瞳孔</h2><p>默认保留眼珠原画里的瞳孔。可叠加自己的瞳孔图案。</p>{custom('pupilSrc','瞳孔')}{f.pupilSrc&&tuning('pupil','自定义瞳孔')}</>}
   <details className="expression-preview"><summary>试试睁眼与闭眼</summary><div className="garment-slots" aria-label="眼睛开合">{([['open','睁眼'],['half','半睁'],['closed','闭眼'],['happy','开心闭眼']] as const).map(([id,label])=><button key={id} aria-pressed={f.eyeState===id} onClick={()=>update({eyeState:id})}>{label}</button>)}</div><label className="creator-select">自然眨眼<input type="checkbox" aria-label="自然眨眼" checked={f.blink} onChange={e=>update({blink:e.target.checked})}/></label></details>
  </>}
  {section==='brows'&&<><h2>眉毛</h2>{choiceGrid('眉毛款式','brow',['original','none','01','02','03','04'],'brow')}{tuning('brow','眉毛')}<details><summary>试试情绪</summary><div className="garment-slots">{([['neutral','自然'],['angry','生气'],['sad','难过']] as const).map(([id,label])=><button key={id} aria-pressed={f.emotion===id} onClick={()=>update({emotion:id})}>{label}</button>)}</div></details></>}
  {section==='mouth'&&<>
   <nav className="face-subnav" aria-label="嘴型用途">{([['closed','闭嘴时'],['open','说话时'],['smile','笑起来时']] as const).map(([id,label])=><button key={id} aria-pressed={mouthUse===id} onClick={()=>onMouthUse(id)}>{label}</button>)}</nav>
   <h2>{mouthUse==='closed'?'角色闭上嘴时，是什么样子？':mouthUse==='open'?'角色张嘴说话时，是什么样子？':'角色笑起来时，是什么样子？'}</h2><p>三种嘴型分别记住，平时默认闭嘴。当前预览这一种。</p>
   <div className="face-choice-grid mouth-choices" aria-label="嘴型款式">{mouthStyles.filter(id=>id.startsWith(mouthUse+'-')).map(id=><button key={id} aria-label={`嘴型 ${id}`} aria-pressed={f.mouths![mouthUse]===id} onClick={()=>{const mouths={...f.mouths!,[mouthUse]:id};update({mouths,mouth:mouths.closed});}}><span className="face-art"><img alt="" src={`${import.meta.env.BASE_URL}${faceAssets[`mouth-${id}`].src}`}/></span><span>{id.split('-')[1]}</span></button>)}</div>{tuning('mouth','嘴巴')}
  </>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
