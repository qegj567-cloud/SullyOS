import {COLLABORATION_UI_THEMES} from '../../features/collaboration/appearance';
import type {WardrobeUsageReader} from '../../utils/wardrobeUsage';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import {MEETING_APPEARANCES} from '../../utils/meetingAppearance';
import CssCodeEditor from './CssCodeEditor';
import AvatarFrameImageEditor from './AvatarFrameImageEditor';
import {trackBeauty} from '../../utils/beautyAnalytics';
import OutfitCollection from './OutfitCollection';
import {usePreviewDraft} from '../../hooks/usePreviewDraft';
import {JOURNAL_APPEARANCE_PRESETS} from '../../utils/journalAppearance';
import {SCHEDULE_CARD_PRESETS} from '../../utils/scheduleAppearance';
import React,{useMemo,useState} from 'react';
import {createPortal} from 'react-dom';
import {type DecorationPreset,LAYOUT_DEFAULTS,validateDecoration} from '../../utils/chatDecoration';
import {canEditDecoration,remixOrigin,readDecorationOrigin,saveLibraryDecoration,deleteLibraryDecoration,combineDecorationOrigins,type DecorationOrigin} from '../../utils/decorationLibrary';
import BeautyConfirmDialog from '../share/BeautyConfirmDialog';
import BeautyPresetPreview from '../share/BeautyPresetPreview';
import type {WardrobeEntry} from '../appearance/BeautyWardrobe';
import ChatLayoutSettings from './ChatLayoutSettings';
import {WHITEBOX_AI_PROMPT} from '../../utils/chatWhitebox';
import {PRESET_THEMES} from './ChatConstants';
import WhiteboxSoundEditor from './WhiteboxSoundEditor';
import DecorationPresetThumb,{DecorationMiniPreview} from './DecorationPresetThumb';
import type {OSTheme} from '../../types';
import './DecorationDraftEditor.css';
import {DECORATION_WORKSHOPS,workshopCss,replaceWorkshopCss,projectWorkshopPreset,checkWorkshopCss,workshopPrompt,type DecorationWorkshop} from '../../utils/decorationWorkshop';
type Shelf=DecorationWorkshop;
const shelves=DECORATION_WORKSHOPS;
interface Props {getUsage?:WardrobeUsageReader;outfits?:WardrobeEntry[];onOutfitsChange?:()=>Promise<void>;preset:DecorationPreset;origin:DecorationOrigin;originalKey?:string;theme:OSTheme;sources:WardrobeEntry[];onOpenWorkshop:()=>void;onClose:()=>void;onSaved:(preset:DecorationPreset)=>void;maker?:Shelf;characterName?:string;onApply?:(preset:DecorationPreset,origin:DecorationOrigin)=>void|Promise<void>}
export default function DecorationDraftEditor({getUsage,outfits=[],onOutfitsChange,preset,origin,originalKey,theme,sources,onOpenWorkshop,onClose,onSaved,maker,characterName,onApply}:Props){
 const [draft,setDraft]=useState(()=>structuredClone(preset));
 const [extraCss,setExtraCss]=useState('');
 const [origins,setOrigins]=useState<Record<string,DecorationOrigin>>(()=>Object.fromEntries(Object.keys(preset.parts).map(key=>[key,origin])));
 const [labels,setLabels]=useState<Partial<Record<Shelf,string>>>({});
 const [outfitOpen,setOutfitOpen]=useState(false);const [deleteOutfit,setDeleteOutfit]=useState<WardrobeEntry|null>(null);
 const [sideOpen,setSideOpen]=useState(false);const [saveOpen,setSaveOpen]=useState(false);
 const [layoutOpen,setLayoutOpen]=useState(false);
 const [editCurrentPsyche,setEditCurrentPsyche]=useState(false);
 const [category,setCategory]=useState<Shelf>(maker||'whitebox');
 const [shelf,setShelf]=useState<Shelf|null>(null);
 const [query,setQuery]=useState('');const [page,setPage]=useState(0);
 const [update,setUpdate]=useState(!!originalKey&&['self','remix'].includes(origin.kind));const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const combinedOrigin=useMemo(()=>combineDecorationOrigins(Object.values(origins)),[origins]);
 useLocalBackHandler(()=>{
   if(busy)return true;
   if(editCurrentPsyche)setEditCurrentPsyche(false);
   else if(saveOpen)setSaveOpen(false);
   else if(layoutOpen)setLayoutOpen(false);
   else if(outfitOpen)setOutfitOpen(false);
   else if(sideOpen)setSideOpen(false);
   else if(shelf)setShelf(null);
   else onClose();
   return true;
 }, 30);
 const locked=!canEditDecoration(combinedOrigin);
 const backgroundBlock=/\/\* sully-composer:background \*\/\n?([\s\S]*?)\/\* end-sully-composer:background \*\//;
 const categoryCss=workshopCss(draft,category);
 const setCategoryCss=(css:string)=>setDraft(old=>{
   if(category==='collaboration')return {...old,parts:{collaboration:{uiTheme:'sully',avatarMode:'theme',avatarStyle:'circle',...old.parts.collaboration,customCss:css}}};
   if(category==='journal')return {...old,parts:{...old.parts,journal:{...old.parts.journal,customCss:css}}};
   if(category==='schedule')return {...old,parts:{...old.parts,schedule:{...old.parts.schedule,customCss:css}}};
   if(category==='bubbles')return {...old,parts:{...old.parts,bubbles:{...(old.parts.bubbles||structuredClone(PRESET_THEMES.default)),customCss:css}}};
   if(category==='psyche')return {...old,parts:{...old.parts,psyche:{styleId:'echo',...old.parts.psyche,customCss:css}}};
   if(category==='background'||category==='avatar')return {...old,parts:{...old.parts,css:replaceWorkshopCss(old.parts.css||'',category,css)}};
   return {...old,parts:{...old.parts,css}};
 });
 const preview=useMemo(()=>({...draft,parts:{...draft.parts,...(extraCss.trim()?{css:[draft.parts.css,extraCss].filter(Boolean).join('\n')}: {})}}),[draft,extraCss]);
 const settledPreview=usePreviewDraft(preview,!!maker);
 const renderedPreview=settledPreview;
 const save=async(apply=false)=>{setBusy(true);setError('');try{
   if(!canEditDecoration(combinedOrigin))throw Error('作者禁止二改');
   if(!draft.name.trim())throw Error('请填写预设名称');
   const checkedCss=maker?checkWorkshopCss(maker,maker==='whitebox'?preview.parts.css||'':categoryCss):undefined;
   if(maker==='avatar'&&!categoryCss.trim())throw Error('请先选择头像框图片或填写头像框 CSS');
   const result=maker?projectWorkshopPreset({...preview,name:draft.name.trim()},maker):{...preview,name:draft.name.trim()};
   if(maker==='whitebox')result.parts.css=checkedCss;
   if(apply&&onApply){await onApply(result,combinedOrigin);return;}
   await saveLibraryDecoration(result,remixOrigin(combinedOrigin),update?originalKey:undefined,maker?undefined:'outfit');
   trackBeauty('save',maker||'outfit');onSaved(result);
 }catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{setBusy(false);}};
 const choose=async(entry:WardrobeEntry)=>{if(!shelf)return;setBusy(true);setError('');try{
   const nextOrigin=await readDecorationOrigin(await entry.attributionKey());
   if(!canEditDecoration(nextOrigin))throw Error('作者禁止二改，请回到装扮库整套应用这份作品。');
   const next=validateDecoration(await (entry.readLocal || entry.read)());
   if(shelf==='whitebox'){setDraft(old=>({...old,parts:{...old.parts,...next.parts}}));}
   else if(shelf==='avatar'){
    const css=workshopCss(next,'avatar');
    const fields=['avatarDecoration','avatarDecorationX','avatarDecorationY','avatarDecorationScale','avatarDecorationRotate'] as const;
    setDraft(old=>{const bubbles=structuredClone(old.parts.bubbles||PRESET_THEMES.default);if(next.parts.bubbles)for(const side of ['user','ai'] as const)for(const field of fields)(bubbles[side] as any)[field]=next.parts.bubbles[side][field];return {...old,parts:{...old.parts,...(next.parts.bubbles?{bubbles}:{}),css:replaceWorkshopCss(old.parts.css||'','avatar',css)}};});
   }
   else if(shelf==='background'){
    const cssBlock=(next.parts.css||'').match(backgroundBlock)?.[0];
    if(!next.parts.background&&!cssBlock)throw Error('这份预设没有聊天背景');
    setDraft(old=>({...old,parts:{...old.parts,...(next.parts.background?{background:next.parts.background}:{}),css:[(old.parts.css||'').replace(backgroundBlock,'').trim(),cssBlock].filter(Boolean).join('\n')}}));
   }
   else {const part=next.parts[shelf];if(part===undefined)throw Error('这份预设没有对应内容');setDraft(old=>({...old,parts:{...old.parts,[shelf]:part}}));}
   setOrigins(old=>({...old,...Object.fromEntries((shelf==='whitebox'?Object.keys(next.parts):[shelf]).map(key=>[key,nextOrigin]))}));setLabels(old=>({...old,[shelf]:entry.name}));setShelf(null);setNotice('已加入搭配');setSideOpen(false);
 }catch(e){setError(e instanceof Error?e.message:'无法读取预设');}finally{setBusy(false);}};
 const matches=sources.filter(entry=>entry.kind==='chat-decoration'&&(!shelf||entry.categories?.includes(shelf))&&entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 const pageCount=Math.max(1,Math.ceil(matches.length/8));const currentPage=Math.min(page,pageCount-1);
 const loadOutfit=async(entry:WardrobeEntry)=>{setBusy(true);setError('');try{const nextOrigin=await readDecorationOrigin(await entry.attributionKey());if(!canEditDecoration(nextOrigin))throw Error('作者禁止二改');const next=validateDecoration(await (entry.readLocal || entry.read)());setDraft(next);setExtraCss('');setOrigins(Object.fromEntries(Object.keys(next.parts).map(key=>[key,nextOrigin])));setLabels({});setSideOpen(false);setOutfitOpen(false);setNotice('已载入搭配，点击应用搭配后才会更改角色。');}catch(e){setError(e instanceof Error?e.message:'读取失败');}finally{setBusy(false);}};
 return createPortal(<div data-dress-guide={!maker?'outfit':undefined} className={`decoration-draft ${maker?'decoration-maker':'decoration-current'}`} role="dialog" aria-modal="true" aria-label={maker?`${shelves.find(([id])=>id===maker)?.[1]}制作器`:'我的搭配'}>
  <header><button data-dress-guide={!maker?'outfit-back':undefined} disabled={busy} onClick={onClose}>‹ 返回</button><strong>{maker?`${shelves.find(([id])=>id===maker)?.[1]}制作器`:'我的搭配'}</strong><button disabled={busy||locked} onClick={()=>save(!maker)}>{busy?'保存中…':maker?'保存预设':'应用搭配'}</button></header>
  <div className="decoration-composer-body"><div className="decoration-composer-preview">
   <BeautyPresetPreview data={renderedPreview} sceneScope={!maker||maker==='whitebox'?'all':'preset'}/>
   {(!maker||maker==='whitebox')&&<button className="decoration-layout-orb" disabled={busy||locked} aria-label="调整布局" aria-expanded={layoutOpen} onClick={()=>setLayoutOpen(!layoutOpen)}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 7h16M4 17h16"/><rect x="7" y="4" width="4" height="6" rx="2"/><rect x="14" y="14" width="4" height="6" rx="2"/></svg><span>布局</span></button>}
   {layoutOpen&&<aside className="decoration-layout-popover" aria-label="布局浮窗"><header><div><strong>布局微调</strong><small>边调整，边看效果</small></div><button aria-label="收起布局浮窗" onClick={()=>setLayoutOpen(false)}>×</button></header><div className="decoration-layout-fields"><ChatLayoutSettings theme={{...theme,...LAYOUT_DEFAULTS,...draft.parts.layout}} updateTheme={patch=>setDraft(old=>({...old,parts:{...old.parts,layout:{...old.parts.layout,...patch}}}))}/></div></aside>}
  </div>
  {!maker&&<button className="decoration-side-toggle" aria-expanded={sideOpen} onClick={()=>setSideOpen(!sideOpen)}>搭配 <span aria-hidden="true">☷</span></button>}
  {!maker&&<button className="decoration-outfit-toggle" aria-label="打开搭配收藏" aria-expanded={outfitOpen} onClick={()=>{setSideOpen(false);setLayoutOpen(false);setError('');setOutfitOpen(true);}}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M5 4h14v17l-7-4-7 4z"/><path d="M9 8h6"/></svg><span>收藏</span></button>}
  {!maker&&sideOpen&&<button className="decoration-side-scrim" aria-label="收起搭配侧栏" onClick={()=>setSideOpen(false)}/>}
  <aside className="decoration-composer-controls" data-open={sideOpen}>{!maker&&<header className="decoration-side-header"><strong>我的选择</strong><button aria-label="关闭搭配侧栏" onClick={()=>setSideOpen(false)}>×</button></header>}{locked&&<p role="status">当前搭配包含禁止二改的作品，已锁定编辑；可以返回装扮库更换作品。</p>}
   {!maker&&<p className="decoration-current-character">当前角色：{characterName||'当前角色'} · 点选预设搭配</p>}
   {maker&&<label className="decoration-name">名称<input disabled={busy} value={draft.name} maxLength={60} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>}
   {originalKey&&['self','remix'].includes(origin.kind)&&<label><input disabled={busy} type="checkbox" checked={update} onChange={e=>setUpdate(e.target.checked)}/>更新原预设，否则另存一份</label>}
   {!maker&&<button className="decoration-save-outfit" disabled={busy||locked} onClick={()=>setSaveOpen(true)}>保存当前搭配</button>}
   {!maker&&<div className="decoration-current-grid">{shelves.filter(([id])=>id!=='schedule'&&id!=='journal'&&id!=='date'&&id!=='story'&&id!=='collaboration').map(([id,label])=><button key={id} disabled={busy||locked} onClick={()=>{setShelf(id);setQuery('');setPage(0);setError('');}}><span className="decoration-current-image"><DecorationMiniPreview preset={renderedPreview} category={id}/></span><small>{labels[id]||'当前使用'}</small><strong>{label}</strong></button>)}</div>}
   {maker&&<div key={category} className="decoration-category-panel" aria-label={`${shelves.find(([id])=>id===category)?.[1]}设置`}>
    <details open className="decoration-composer-section"><summary>选择预设</summary><button className="decoration-preset-choice" disabled={busy} onClick={()=>{setShelf(category);setQuery('');setPage(0);setError('');}}><span className="decoration-selected-thumb"><DecorationMiniPreview preset={renderedPreview} category={category}/></span><span className="decoration-selected-copy"><small>{labels[category]?'当前搭配':'效果预览'}</small><strong>{labels[category]||`选择${shelves.find(([id])=>id===category)?.[1]}预设`}</strong><em>点开挑选更多款式</em></span><span className="decoration-choice-arrow" aria-hidden="true">›</span></button></details>
    <details open className="decoration-composer-section"><summary>{category==='date'||category==='story'?'阅读样式':category==='sound'?'制作提示音':`${shelves.find(([id])=>id===category)?.[1]} CSS`}</summary>
     {category==='collaboration'&&<><p>全局协同工作外观，不含任务记录、上传文件或 API 配置。</p><label>基础主题<select value={draft.parts.collaboration?.uiTheme||'sully'} onChange={e=>setDraft(old=>({...old,parts:{collaboration:{customCss:'',avatarMode:'theme',avatarStyle:'circle',...old.parts.collaboration,uiTheme:e.target.value as any}}}))}>{COLLABORATION_UI_THEMES.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label></>}
     {category==='journal'&&<label>日记主题<select aria-label="日记主题" value={draft.parts.journal?.preset||'original'} onChange={e=>setDraft(old=>({...old,parts:{...old.parts,journal:{...old.parts.journal,preset:e.target.value as any}}}))}>{JOURNAL_APPEARANCE_PRESETS.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
     {category==='schedule'&&<div><p>全局样式：同步桌面组件与聊天日程表，不更改日程内容。</p><label>日程配色<select aria-label="日程配色" value={draft.parts.schedule?.preset||'original'} onChange={e=>setDraft(old=>({...old,parts:{...old.parts,schedule:{...old.parts.schedule,preset:e.target.value as any}}}))}>{SCHEDULE_CARD_PRESETS.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}<option value="custom">自定义配色</option></select></label>{draft.parts.schedule?.preset==='custom'&&(['background','textColor','accentColor'] as const).map((key,index)=><label key={key}>{['背景（颜色或渐变）','文字颜色','强调色'][index]}<input value={draft.parts.schedule?.[key]||''} onChange={e=>setDraft(old=>({...old,parts:{...old.parts,schedule:{...old.parts.schedule,[key]:e.target.value}}}))}/></label>)}</div>}
     {category==='date'||category==='story'?<label>阅读样式<select value={draft.parts[category]?.preset||'none'} onChange={e=>setDraft(old=>({...old,parts:{[category]:{preset:e.target.value}}} as DecorationPreset))}>{MEETING_APPEARANCES.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>:category==='sound'?<WhiteboxSoundEditor sound={draft.parts.sound||null} bound={false} showBind={false} onChangeSound={sound=>setDraft(old=>({...old,parts:{...old.parts,sound}}))} onChangeBound={()=>{}}/>:<>
      <button onClick={async()=>{try{await navigator.clipboard.writeText(workshopPrompt(category));setNotice('已复制当前分类提示词');}catch{setError('复制失败');}}}>复制 AI 提示词</button>
      {category==='avatar'&&<AvatarFrameImageEditor css={categoryCss} disabled={busy} onChange={setCategoryCss} onBusy={setBusy} onError={setError}/>}
      {category==='background'&&<label>选择壁纸<input type="file" accept="image/*" disabled={busy} onChange={async e=>{const file=e.target.files?.[0];if(!file)return;try{if(file.size>12*1024*1024)throw Error('请选择 12 MB 以内的图片');const {blobToDataUrl}=await import('../../utils/blobRef');const image=await blobToDataUrl(file);setDraft(old=>({...old,parts:{...old.parts,background:{image,style:old.parts.background?.style||'plain'}}}));}catch(e){setError(e instanceof Error?e.message:'图片读取失败');}}}/></label>}
      <CssCodeEditor disabled={busy} aria-label={`${shelves.find(([id])=>id===category)?.[1]} CSS`} spellCheck={false} value={categoryCss} onChange={setCategoryCss} placeholder={category==='psyche'?'.sully-psyche-card { }':category==='background'?'.sully-chat-root { background: #f5f5f5; }':'在这里编写或粘贴 CSS'}/>
      {category==='whitebox'&&<label>追加 CSS<textarea disabled={busy} aria-label="追加 CSS" spellCheck={false} value={extraCss} onChange={e=>setExtraCss(e.target.value)}/></label>}
     </>}
    </details>
   </div>}

   {combinedOrigin.credit&&<p>来源署名：{combinedOrigin.credit}</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </aside></div>
  {!maker&&outfitOpen&&<OutfitCollection getUsage={getUsage} entries={outfits} busy={busy} error={error} onClose={()=>setOutfitOpen(false)} onChoose={entry=>void loadOutfit(entry)} onDelete={setDeleteOutfit} onSave={()=>setSaveOpen(true)}/> }
  {deleteOutfit&&<BeautyConfirmDialog title="删除这套搭配？" confirm="删除" danger onClose={()=>setDeleteOutfit(null)} onConfirm={async()=>{await deleteLibraryDecoration(deleteOutfit.id);await onOutfitsChange?.();}}><p>只移除搭配收藏，已应用的效果和各部件原件会保留。</p></BeautyConfirmDialog>}
  {saveOpen&&<BeautyConfirmDialog title="保存当前搭配" confirm="保存到搭配栏" onClose={()=>setSaveOpen(false)} onConfirm={async()=>{if(!canEditDecoration(combinedOrigin))throw Error("作者禁止二改");if(!draft.name.trim())throw Error("请填写搭配名称");const result={...preview,name:draft.name.trim()};await saveLibraryDecoration(result,remixOrigin(combinedOrigin),undefined,'outfit');trackBeauty('save','outfit');await onOutfitsChange?.();setNotice('已保存到搭配栏');}}><p>保存这次组合，下次可以整套应用。</p><label>搭配名称<input aria-label="搭配名称" maxLength={60} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label></BeautyConfirmDialog>}
  {editCurrentPsyche&&<DecorationDraftEditor preset={projectWorkshopPreset({...draft,name:'当前心象'},'psyche')} origin={combinedOrigin} theme={theme} sources={sources} maker="psyche" onOpenWorkshop={onOpenWorkshop} onClose={()=>setEditCurrentPsyche(false)} onSaved={next=>{setDraft(old=>({...old,parts:{...old.parts,psyche:next.parts.psyche}}));setEditCurrentPsyche(false);setShelf(null);void onOutfitsChange?.().catch(()=>setError('心象已保存，预设库刷新失败，请重新打开。'));setNotice('心象已保存到预设库；应用搭配后更新角色。');}}/>}
  {shelf&&<div className="decoration-shelf-overlay"><section role="dialog" aria-modal="true" aria-label="选择搭配预设"><header><strong>{shelves.find(([id])=>id===shelf)?.[1]}</strong><button disabled={busy} onClick={()=>setShelf(null)}>关闭</button></header>{!maker&&shelf==='psyche'&&<button disabled={busy||locked} onClick={()=>setEditCurrentPsyche(true)}>编辑并另存当前心象</button>}<input type="search" aria-label="搜索搭配预设" placeholder="搜索预设名称" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);}}/><div className="decoration-shelf-results decoration-shelf-grid">{matches.slice(currentPage*8,currentPage*8+8).map(entry=><DecorationPresetThumb getUsage={getUsage} key={entry.id} entry={entry} category={shelf} disabled={busy} onChoose={()=>{void choose(entry);}}/>)}{!matches.length&&<p>暂无对应预设，请先在装扮库导入或保存。</p>}</div>{error&&<p role="alert">{error}</p>}<footer><button disabled={busy||currentPage===0} onClick={()=>setPage(currentPage-1)}>上一页</button><span>{currentPage+1} / {pageCount}</span><button disabled={busy||currentPage+1>=pageCount} onClick={()=>setPage(currentPage+1)}>下一页</button></footer></section></div>}
 </div>,document.body);
}
