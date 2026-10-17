import {CollaborationStore} from '../../features/collaboration/store';
import {COLLABORATION_UI_THEMES,validateCollaborationAppearance,type CollaborationAppearance} from '../../features/collaboration/appearance';
import {localizeCssImages} from '../../utils/cssImageAssets';
import {AVATAR_FRAME_TARGETS,hasAvatarFrameCss,readAvatarFrameTarget,withAvatarFrameTarget,type AvatarFrameTarget} from '../../utils/avatarFrameTarget';
import {createWardrobeUsageReader} from '../../utils/wardrobeUsage';
import {BUILTIN_SOUNDS} from '../../utils/whiteboxSound';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import {MEETING_APPEARANCES} from '../../utils/meetingAppearance';
import {trackBeauty} from '../../utils/beautyAnalytics';
import {migrateLegacyWhiteboxPresets} from '../../utils/legacyWhiteboxPresets';
import {BUILTIN_WHITEBOX_PRESETS} from '../../utils/builtinWhitebox';
import {BUILTIN_APPEARANCE_PRESETS} from '../../utils/builtinAppearance';
import DecorationGuide from '../chat/DecorationGuide';
import BeautyUpdateNotice, { BEAUTY_CATALOG_NOTICE, needsBeautyNotice } from '../share/BeautyUpdateNotice';
import {needsDecorationGuide,finishDecorationGuide} from '../../utils/decorationGuide';
import {useFirstUseGuideStep} from '../../utils/firstUseGuide';
import {SCHEDULE_CARD_PRESETS} from '../../utils/scheduleAppearance';
import {JOURNAL_APPEARANCE_PRESETS} from '../../utils/journalAppearance';
import {belongsInBeautyLibrary,isAppDecoration} from '../../utils/beautyCategories';
import BeautyImportHub from '../share/BeautyImportHub';
import {stampBeautyCss,isCssImportCandidate,readLegacyWhiteboxShare} from '../../utils/beautyCssAttribution';
import {PSYCHE_STYLE_LIST} from '../../utils/psycheStyleCatalog';
import React, { useEffect, useState, useRef, useMemo, lazy, Suspense } from 'react';
import {createPortal} from 'react-dom';
import { AppID, type AppearancePreset } from '../../types';
import { useOS, DEFAULT_PAPER_APPEARANCE, DEFAULT_WALLPAPER } from '../../context/OSContext';
import { resetChatDecoration } from '../../utils/decorationReset';
import { DB } from '../../utils/db';
import { validateDecoration, type DecorationPart, type DecorationPreset } from '../../utils/chatDecoration';
import { prepareDecorationApplication } from '../../utils/decorationApplication';
import { beautyRequest,downloadBeauty,readBeautyPackage } from '../../utils/beautyShareClient';
import type { BeautyShare } from '../../utils/beautyShareContract';
import { BEAUTY_CATEGORIES, decorationCategories, decorationContents, type BeautyCategory } from '../../utils/beautyCategories';
import { hasBeautyReceiveRequest, clearBeautyReceiveRequest,readBeautyLibraryRequest,clearBeautyLibraryRequest } from '../../utils/beautyNavigation';
import { rememberBeautySource, decorationSourceKey, startBeautyUsage, readBeautyUsage } from '../../utils/beautyUsage';
import BeautyConfirmDialog from '../share/BeautyConfirmDialog';
import {readLibraryDecorations,deleteLibraryDecoration,replaceReceivedDecoration,remixOrigin,type LibraryDecoration} from '../../utils/decorationLibrary';
import BeautySharePanel from '../share/BeautySharePanel';
import BeautyPresetPicker from '../share/BeautyPresetPicker';
import { BeautyRepoLibrary } from '../share/BeautyRepoInvitation';
import BeautyWardrobe, { type WardrobeEntry } from './BeautyWardrobe';
import DecorationDraftEditor from '../chat/DecorationDraftEditor';
import {readDecorationFile,portableDecoration,readBubbleDecoration} from '../../utils/chatDecoration';
import {readDecorationOrigin,writeDecorationOrigin,saveLibraryDecoration,saveLibraryDecorationBatch,canEditDecoration,importedOrigin,type DecorationOrigin} from '../../utils/decorationLibrary';
import {shareOrDownloadBlob} from '../../utils/shareExport';
import {safeShareFileName,isPng,pngHasShare,extractShareFromPng} from '../../utils/pngShare';
import {snapshotDecoration} from '../../utils/chatDecoration';
import {PRESET_THEMES} from '../chat/ChatConstants';
import {DECORATION_WORKSHOPS,workshopCss,makeWorkshopPreset,projectWorkshopPreset,type DecorationWorkshop} from '../../utils/decorationWorkshop';
import {combineDecorationOrigins,writeDecorationOrigin as writeOrigin} from '../../utils/decorationLibrary';
import './BeautyCatalog.css';
const BeautyCatalog=lazy(()=>import('./BeautyCatalog'));
const BubbleMaker=lazy(()=>import('../chat/BubbleMaker'));

const makeAppPreset=(kind:'schedule'|'journal',name:string,appearance:unknown):DecorationPreset=>validateDecoration({format:'sullyos-chat-decoration',version:1,name,parts:{[kind]:appearance||{preset:'original'}}});
const CHAT_PRESETS = 'chat_decoration_presets_v1';
interface Props {
  presets: AppearancePreset[];
  onExport: (id: string) => Promise<Blob>;
  onImport: (file: File) => Promise<string>;
  onBusyChange: (busy: boolean) => void;
  onBack?: () => void;
  targetCharacterId?: string;
  onCustomize?: () => void;
  onApplied?: () => void;
  onCollaborationApplied?: (appearance: CollaborationAppearance) => void;
  createDraft?: () => Promise<DecorationPreset>;
  onOpenWorkshop?:()=>void;
  initialMaker?: DecorationWorkshop; initialCategory?: BeautyCategory;
}
export default function BeautyShareChannel({ presets, onExport, onImport, onBusyChange, onBack, targetCharacterId, onCustomize, onApplied, onCollaborationApplied, createDraft, onOpenWorkshop, initialMaker, initialCategory }: Props) {
  const { characters, activeCharacterId, theme, updateTheme, customIcons, setCustomIcon, deleteAppearancePreset, removeCustomTheme, replaceAppearancePreset, customThemes=[], applyAppearancePreset, addCustomTheme, updateCharacter, setActiveCharacterId, openApp, closeApp } = useOS();
  const libraryContext=targetCharacterId||initialCategory==='date'||initialCategory==='story'||initialCategory==='collaboration'?'chat':'appearance';
  const trackedOpen=useRef(false);
  useEffect(()=>{if(!trackedOpen.current){trackedOpen.current=true;trackBeauty('library',libraryContext==='chat'?'chat':'appearance');if(initialMaker)trackBeauty('maker',initialMaker);}},[]);
  const firstGuideActive=useFirstUseGuideStep()!==null;
  const [catalogNotice, setCatalogNotice] = useState(() => !initialMaker && !!targetCharacterId && needsBeautyNotice(BEAUTY_CATALOG_NOTICE));
  const [guideStep,setGuideStep]=useState<number|null>(()=>!initialMaker&&targetCharacterId&&needsDecorationGuide()?0:null);
  const endGuide=()=>{finishDecorationGuide();setGuideStep(null);};
  const [saveCurrent,setSaveCurrent]=useState<{preset:DecorationPreset;key:string}|null>(null);
  const [received, setReceived] = useState<{ kind: 'appearance'; id: string; name: string } | { kind: 'chat-decoration'; preset: DecorationPreset; name: string } | null>(null);
  const [target, setTarget] = useState(targetCharacterId || activeCharacterId || characters[0]?.id || '');
  const targetCharacter = characters.find(character => character.id === target);
  const [collaborationAppearance,setCollaborationAppearance]=useState<CollaborationAppearance>();
  useEffect(()=>{let alive=true;CollaborationStore.loadSettings().then(value=>{if(alive)setCollaborationAppearance(validateCollaborationAppearance(value));}).catch(()=>{});return()=>{alive=false;};},[]);
  const applyCollaboration=async(value:CollaborationAppearance)=>{
    const next={...validateCollaborationAppearance(value),customCss:await localizeCssImages(value.customCss)};
    await CollaborationStore.applyAppearance(next);setCollaborationAppearance(next);onCollaborationApplied?.(next);
  };
  const getUsage=useMemo(()=>createWardrobeUsageReader(theme,targetCharacter,[...customThemes,...Object.values(PRESET_THEMES)].find(item=>item.id===(targetCharacter?.bubbleStyle||theme.chatDefaultBubbleStyle||'default'))||PRESET_THEMES.default,customIcons,undefined,collaborationAppearance),[theme,targetCharacter,customThemes,customIcons,collaborationAppearance]);
  const [avatarTarget,setAvatarTarget]=useState<AvatarFrameTarget>('both');
  useEffect(()=>{if(received?.kind==='chat-decoration')setAvatarTarget(readAvatarFrameTarget(received.preset.parts.css||''));},[received]);
  const [applyAll,setApplyAll]=useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState('');
  const [category, setCategory] = useState<BeautyCategory>(()=>initialCategory||initialMaker|| (targetCharacterId?'all':readBeautyLibraryRequest()||'all'));
  const [searchOpen, setSearchOpen] = useState(false);
  const [shareMethod,setShareMethod]=useState<'file'|'image'|'code'>('file');
  const [shareSource,setShareSource]=useState('');
  const [cssDraft,setCssDraft]=useState<{text:string;name:string}|undefined>();
  const [shareCredit,setShareCredit]=useState(()=>{try{return JSON.parse(localStorage.getItem('sully-beauty-author-defaults-v1')||'{}').credit||'';}catch{return '';}});
  const [page, setPage] = useState<'library' | 'receive' | 'submit' | 'mine' | 'catalog'>(() => hasBeautyReceiveRequest() ? 'receive' : 'library');
  useEffect(()=>{clearBeautyReceiveRequest();if(!targetCharacterId)clearBeautyLibraryRequest();}, []);
  const [saved, setSaved] = useState<LibraryDecoration[]>([]);
  const [legacyCss,setLegacyCss]=useState<DecorationPreset[]>([]);
  useEffect(()=>{let alive=true;migrateLegacyWhiteboxPresets(DB).then(list=>{if(alive&&Array.isArray(list))setLegacyCss(list.filter(item=>typeof item.code==='string').map(item=>validateDecoration({format:'sullyos-chat-decoration',version:1,name:item.name||'白框预设',parts:{css:item.code}})));}).catch(()=>setError('旧版白框预设读取失败'));return()=>{alive=false;};},[]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice,setNotice]=useState('');
  const restoreCategory = async () => {
    setBusy(true); onBusyChange(true); setError('');
    try {
      if (category === 'collaboration') {await applyCollaboration(validateCollaborationAppearance({}));await DB.saveAsset('decoration_global_collaboration','');}
      else if (category === 'story') await updateTheme({ storyAppearance: { preset: 'none' } });
      else if (category === 'date' && targetCharacter) await updateCharacter(targetCharacter.id, { dateAppearance: { preset: 'none' } });
      else if (category === 'schedule') await updateTheme({ scheduleCardAppearance: { preset: 'original', customCss: '' } });
      else if (category === 'journal') await updateTheme({ journalAppearance: { preset: 'original', customCss: '' } });
      else if (category === 'appearance') {
        await updateTheme({ ...DEFAULT_PAPER_APPEARANCE, wallpaper: DEFAULT_WALLPAPER, skin: 'default', darkMode: false, launcherWidgets: {}, desktopDecorations: [], customFont: '', preserveCustomIconOutlines: false, nowPlayingWidgetLight: true });
        for (const id of Object.keys(customIcons)) await setCustomIcon(id, undefined);
      } else if (targetCharacter) {
        const activeBubble = [...customThemes, ...Object.values(PRESET_THEMES)].find(item => item.id === (targetCharacter.bubbleStyle || theme.chatDefaultBubbleStyle || 'default')) || PRESET_THEMES.default;
        const reset = resetChatDecoration(category, targetCharacter, theme, activeBubble);
        if (reset.bubble) {
          await addCustomTheme(reset.bubble);
          await writeDecorationOrigin('bubble-' + reset.bubble.id, remixOrigin(await readDecorationOrigin('bubble-' + activeBubble.id)));
        }
        await updateCharacter(targetCharacter.id, reset.character);
      }
      setNotice('已恢复本分类默认样式');
    } catch (e) { setError(e instanceof Error ? e.message : '恢复失败，请重试'); }
    finally { setBusy(false); onBusyChange(false); }
  };
  const [deleteEntry,setDeleteEntry]=useState<WardrobeEntry|null>(null);
  const [updateEntry,setUpdateEntry]=useState<{entry:WardrobeEntry;share:BeautyShare;previous:string}|null>(null);
  const [desktopEdit,setDesktopEdit]=useState<{entry:WardrobeEntry;name:string;origin:DecorationOrigin;useCurrent:boolean}|null>(null);
  const [draft,setDraft]=useState<{preset:DecorationPreset;origin:DecorationOrigin;originalKey?:string;originalEntryId?:string;maker?:DecorationWorkshop}|null>(()=>initialMaker?{preset:makeWorkshopPreset(initialMaker),origin:{kind:'self'},maker:initialMaker}:null);
  const openMaker=(kind:DecorationWorkshop)=>{trackBeauty('maker',kind);setDraft({preset:makeWorkshopPreset(kind),origin:{kind:'self'},maker:kind});};
  const refreshSaved=async()=>setSaved(await readLibraryDecorations());
  const editEntry=async(entry:WardrobeEntry)=>{
    setBusy(true);onBusyChange(true);setError('');
    try{const key=await entry.attributionKey();const origin=await readDecorationOrigin(key);if(!canEditDecoration(origin))throw Error('作者禁止二改，这份作品已锁定编辑');if(entry.kind==='appearance'){setDesktopEdit({entry,name:entry.name,origin,useCurrent:false});return;}const preset=validateDecoration(await (entry.readLocal || entry.read)());const categories=decorationCategories(preset).filter(item=>item!=='chat');const maker=(categories.length===1?categories[0]:'whitebox') as DecorationWorkshop;setDraft({preset:projectWorkshopPreset(preset,maker),origin,originalKey:entry.id.startsWith('local-chat-')?key:undefined,originalEntryId:entry.id,maker});}
    catch(e){setError(e instanceof Error?e.message:'无法打开编辑');}finally{setBusy(false);onBusyChange(false);}
  };
  const customize=async()=>{setBusy(true);setError('');try{
    if(!targetCharacter)throw Error('请先选择角色');
    const key=await DB.getAsset('decoration_applied_'+target);
    const slots=await DB.getAsset('decoration_slots_'+target);
    const origin:DecorationOrigin=slots?combineDecorationOrigins(await Promise.all(Object.values(JSON.parse(slots) as Record<string,string>).map(readDecorationOrigin))):key?await readDecorationOrigin(key):{kind:'self'};
    const bubbleId=targetCharacter.bubbleStyle||theme.chatDefaultBubbleStyle||'default';
    const preset=await snapshotDecoration(`${targetCharacter.name}的搭配`,theme,targetCharacter,customThemes.find(item=>item.id===bubbleId)||PRESET_THEMES[bubbleId]||PRESET_THEMES.default);
    setDraft({preset,origin});if(guideStep!==null)setGuideStep(2);
  }catch(e){setError(e instanceof Error?e.message:'无法创建草稿');}finally{setBusy(false);}};
  const importFile=async(file:File)=>{setBusy(true);onBusyChange(true);setError('');setApplyAll(false);setApplyError('');try{
    if(file.size>40*1024*1024)throw Error('文件超过 40 MB，请精简素材后重试');
    const bytes=new Uint8Array(await file.arrayBuffer());
    const pngPackage=isPng(bytes)&&pngHasShare(bytes)?extractShareFromPng(bytes):null;
    if(pngPackage?.metadata.kind==='appearance'){const id=await onImport(new File([new Uint8Array(pngPackage.payload)],pngPackage.metadata.fileName,{type:pngPackage.metadata.mimeType}));setReceived({kind:'appearance',id,name:pngPackage.metadata.title});trackBeauty('import','image');return;}
    const cssText=pngPackage?new TextDecoder().decode(pngPackage.payload):/\.(css|txt)$/i.test(file.name)?await file.text():null;
    if(cssText&&isCssImportCandidate(cssText)){setCssDraft({text:cssText,name:pngPackage?.metadata.title||file.name.replace(/\.[^.]+$/,'')});setPage('receive');return;}
    const legacyText=pngPackage?new TextDecoder().decode(pngPackage.payload):/\.(json|txt|css)$/i.test(file.name)?await file.text():null;
    if(legacyText&&readLegacyWhiteboxShare(legacyText)){setCssDraft({text:legacyText,name:'旧版白框合集'});setPage('receive');return;}
    const desktopJson=/\.json$/i.test(file.name)&&JSON.parse(await file.text())?.type==='sully_appearance_preset';
    if(/\.zip$/i.test(file.name)||desktopJson){const id=await onImport(file);setReceived({kind:'appearance',id,name:file.name});trackBeauty('import','file');return;}
    const item=await readDecorationFile(file);
    const preset=item.kind==='preset'?item.preset:{format:'sullyos-chat-decoration' as const,version:1 as const,name:item.name,parts:{background:{image:item.image,style:'plain' as const}}};
    let origin:DecorationOrigin={kind:'imported'};if(pngPackage||/\.json$/i.test(file.name)){try{origin=importedOrigin(JSON.parse(pngPackage?new TextDecoder().decode(pngPackage.payload):await file.text()));}catch{/* Legacy CSS share images have no structured permissions. */}}
    await saveLibraryDecoration(preset,origin);await refreshSaved();setReceived({kind:'chat-decoration',preset,name:preset.name});trackBeauty('import',pngPackage?'image':'file');
  }catch(e){setError(e instanceof Error?e.message:'导入失败');}finally{setBusy(false);onBusyChange(false);}};
  const exportEntry=async(entry:WardrobeEntry,image=false,cssOnly=false)=>{setBusy(true);onBusyChange(true);setError('');try{
    const origin=await readDecorationOrigin(await entry.attributionKey());
    if(origin.allowRedistribute===false)throw Error('作者禁止二次传播，这份作品不能导出分享');
    const credit=origin.credit||shareCredit.trim();if(!credit)throw Error('请先填写分享署名');
    const publicOrigin={kind:origin.kind,credit,allowRemix:origin.allowRemix,allowRedistribute:origin.allowRedistribute};
    let content:Blob|string;let extension='.json';
    if(cssOnly){const preset=validateDecoration(await entry.read());const category=(entry.categories?.filter(c=>c!=='chat')[0]||'whitebox') as DecorationWorkshop;
      const css=workshopCss(preset,category);
      if(!css?.trim())throw Error('这份装扮没有可单独复制的 CSS，请使用文件或图片分享');
      await navigator.clipboard.writeText(stampBeautyCss(css,{...publicOrigin,name:entry.name,category}));setNotice('已复制带署名的 CSS（仅样式，完整素材请用文件分享）');trackBeauty('share','css');return;
    }
    if(entry.kind==='appearance'){const {default:JSZip}=await import('jszip');const zip=await JSZip.loadAsync(await onExport(entry.id));const presetFile=zip.file('preset.json');if(!presetFile)throw Error('主题文件缺少预设信息');const data=JSON.parse(await presetFile.async('string'));zip.file('preset.json',JSON.stringify({...data,beautyOrigin:publicOrigin}));content=await zip.generateAsync({type:'blob'});extension='.zip';}
    else content=JSON.stringify({...await portableDecoration(validateDecoration(await entry.read())),beautyOrigin:publicOrigin},null,2);
    trackBeauty('share',image?'image':'file');
    await shareOrDownloadBlob({blob:typeof content==='string'?new Blob([content],{type:'application/json'}):content,fileName:safeShareFileName(entry.name)+extension,...(image?{card:{kind:entry.kind==='appearance'?'appearance' as const:'chat-decoration' as const,title:entry.name,author:credit,restrictions:origin.allowRemix===false?'禁止二改':undefined}}:{})});
  }catch(e){setError(e instanceof Error?e.message:'导出失败');}finally{setBusy(false);onBusyChange(false);}};
  useEffect(() => {
    let alive = true;
    readLibraryDecorations().then(list=>{if(alive)setSaved(list);}).catch(() => { if (alive) setError('美化预设读取失败，请重新打开此页。'); });
    return () => { alive = false; };
  }, []);
  const receive = async (data: unknown, share: BeautyShare) => {
    setApplyError('');
    if (share.kind === 'appearance') {
      const id = await onImport(new File([JSON.stringify(data)], 'beauty-preset.json', { type: 'application/json' }));
      await rememberBeautySource(id, share);
      setCategory(targetCharacterId ? 'all' : 'appearance');
      setReceived({ kind: 'appearance', id, name: (data as AppearancePreset).name }); return;
    }
    const preset = validateDecoration(data);
    await saveLibraryDecoration(preset,{kind:'imported',share});await refreshSaved();
    setCategory('all');
    setApplyAll(false);
    setReceived({ kind: 'chat-decoration', preset, name: preset.name });
  };
  const applyReceived = async () => {
    if (!received || applying) return;
    setApplying(true); onBusyChange(true); setApplyError('');
    try {
      if (received.kind === 'appearance') {
        await applyAppearancePreset(received.id);
        onApplied?.();
        closeApp();
      } else if(received.preset.parts.collaboration){
        await applyCollaboration(received.preset.parts.collaboration);
        const key=await decorationSourceKey(received.preset);await DB.saveAsset('decoration_global_collaboration',key);await startBeautyUsage(key,'collaboration');
        setNotice('已应用到协同工作，所有协同窗口共用此外观');
      } else if(received.preset.parts.story){
        await updateTheme({storyAppearance:{...received.preset.parts.story,name:received.name}});
        setNotice('已应用剧情界面美化');
      } else if(isAppDecoration(received.preset)){
        const p=validateDecoration(received.preset).parts;await updateTheme({...p.schedule?{scheduleCardAppearance:p.schedule}:{},...p.journal?{journalAppearance:p.journal}:{}});
        const key=await decorationSourceKey(received.preset);for(const part of ['schedule','journal'] as const)if(p[part]){await DB.saveAsset('decoration_global_'+part,key);await startBeautyUsage(key,'appearance:'+part);}setNotice('已同步全局 App 样式，内容保持不变');
      } else {
        const targets=applyAll?characters:characters.filter(item=>item.id===target);
        if (!targets.length) throw Error('请选择要应用的角色');
        const key=await decorationSourceKey(received.preset);
        const parts=Object.keys(received.preset.parts) as DecorationPart[];
        // Prepare every patch before writing, so malformed input cannot partly apply.
        const origin=await readDecorationOrigin(key);
        const customIds=new Set(customThemes.map(item=>item.id));
        const {prepared,bubbles}=await prepareDecorationApplication(hasAvatarFrameCss(received.preset)?withAvatarFrameTarget(received.preset,avatarTarget):received.preset,parts,targets,theme,
          [...customThemes,...Object.values(PRESET_THEMES)],origin,
          id=>customIds.has(id)?readDecorationOrigin('bubble-'+id):Promise.resolve({kind:'builtin'}));
        for(const bubble of bubbles){await addCustomTheme(bubble);await writeDecorationOrigin('bubble-'+bubble.id,origin);}
        for(const {character,changes} of prepared){
          await updateCharacter(character.id,changes.character);
          await DB.saveAsset('decoration_applied_'+character.id,key);
          const rawSlots=await DB.getAsset('decoration_slots_'+character.id);
          const slots:Record<string,string>=rawSlots?JSON.parse(rawSlots):{};
          const css=received.preset.parts.css;
          const componentBlocks=css?[...css.matchAll(/\/\* sully-composer:(avatar|background) \*\/[\s\S]*?\/\* end-sully-composer:\1 \*\//g)]:[];
          const componentOnly=componentBlocks.length>0&&!css!.replace(/\/\* sully-composer:(avatar|background) \*\/[\s\S]*?\/\* end-sully-composer:\1 \*\//g,'').trim();
          for(const part of parts){if(part==='css'&&componentOnly){for(const block of componentBlocks)slots['css:'+block[1]]=key;}else{slots[part]=key;if(part==='css'){delete slots['css:avatar'];delete slots['css:background'];}}}
          await DB.saveAsset('decoration_slots_'+character.id,JSON.stringify(slots));
          await startBeautyUsage(key,'chat:'+character.id);
        }
        setNotice(applyAll?`已应用到全部 ${targets.length} 个角色`:`已应用给 ${targets[0].name}`);
      }
      trackBeauty('apply',received.kind==='appearance'?'appearance':received.preset.parts.collaboration?'collaboration':isAppDecoration(received.preset)?(received.preset.parts.schedule?'schedule':'journal'):'chat');
      setReceived(null);
    } catch (error) { setApplyError(error instanceof Error ? error.message : '应用失败，请重试'); }
    finally { setApplying(false); onBusyChange(false); }
  };
  const entries: (WardrobeEntry & { categories: BeautyCategory[] })[] = [
    ...presets.map(preset => ({ id: preset.id, bindingId:preset.id, name: preset.name, kind: 'appearance' as const, categories: ['appearance'] as BeautyCategory[], contents: '作者保存的桌面主题与搭配', revision: preset, attributionKey: async () => preset.id, read: async () => readBeautyPackage(new File([await onExport(preset.id)], 'preset.zip'), 'appearance') })),
    ...saved.map(preset => ({ id:preset._libraryId,bindingId:preset._libraryId, name: preset.name, kind: 'chat-decoration' as const, categories: decorationCategories(preset), contents: decorationContents(preset), revision: preset, attributionKey: async () => preset._libraryId, readLocal: async()=>preset, read: async()=>portableDecoration(preset), readCurrent: async () => {const latest=(await readLibraryDecorations()).find(item=>item._libraryId===preset._libraryId);if(!latest)throw Error('原装扮已删除');return portableDecoration(latest);} })),
    ...legacyCss.map((preset,index)=>({id:`legacy-${index}`,name:preset.name,kind:'chat-decoration' as const,categories:decorationCategories(preset),contents:decorationContents(preset),revision:preset,attributionKey:()=>decorationSourceKey(preset),read:async()=>preset})),
    ...customThemes.map(bubbles=>({id:'bubble-'+bubbles.id,bindingId:'bubble-'+bubbles.id,name:bubbles.name,kind:'chat-decoration' as const,categories:['bubbles'] as BeautyCategory[],contents:'聊天气泡',revision:bubbles,attributionKey:async()=>'bubble-'+bubbles.id,read:()=>readBubbleDecoration(bubbles)})),
  ];
  const builtinWhitebox: WardrobeEntry[] = BUILTIN_WHITEBOX_PRESETS.map(item=>({id:item.id,name:item.name,kind:'chat-decoration',categories:['chat','whitebox'],contents:'完整聊天装扮 · 布局、气泡、背景与心象',attributionKey:async()=>'',read:async()=>item.read()}));
  const builtinBubbles: WardrobeEntry[] = Object.values(PRESET_THEMES).map(bubbles=>({id:'builtin-bubble-'+bubbles.id,name:bubbles.name,kind:'chat-decoration',categories:['bubbles'],contents:'聊天气泡',attributionKey:async()=>'',read:async()=>validateDecoration({format:'sullyos-chat-decoration',version:1,name:bubbles.name,parts:{bubbles:structuredClone(bubbles)}})}));
  const builtinSounds:WardrobeEntry[]=[{src:'none',label:'静音（默认）'},...Object.entries(BUILTIN_SOUNDS).map(([src,item])=>({src,label:item.label}))].map(item=>({id:'builtin-sound-'+item.src,name:item.label,kind:'chat-decoration',categories:['sound'],contents:'消息提示音',attributionKey:async()=>'',read:async()=>validateDecoration({format:'sullyos-chat-decoration',version:1,name:item.label,parts:{sound:{src:item.src,volume:.6}}})}));
  const builtinAppearance: WardrobeEntry[] = BUILTIN_APPEARANCE_PRESETS.map(item=>({id:item.id,name:item.name,kind:'appearance',categories:['appearance'],contents:'紫色星光壁纸、桌面图标与小组件，含彼方和热点图标',attributionKey:async()=>'',read:async()=>structuredClone(item)}));
  const builtinPsyche: WardrobeEntry[] = PSYCHE_STYLE_LIST.filter(style=>style.id!=='custom').map(style=>({id:'psyche-'+style.id,name:style.name,kind:'chat-decoration',categories:['psyche'],contents:style.sub,attributionKey:async()=>'',read:async()=>({format:'sullyos-chat-decoration',version:1,name:style.name,parts:{psyche:{styleId:style.id,customCss:''}}})}));
  const libraryEntries = entries;
  const outfitIds=new Set(saved.filter(p=>p._collection==='outfit').map(p=>p._libraryId));
  const outfitEntries=entries.filter(entry=>outfitIds.has(entry.id));
  const browsingEntries=entries.filter(entry=>!outfitIds.has(entry.id)&&belongsInBeautyLibrary(entry.categories,libraryContext));
  const builtinCollaborations:WardrobeEntry[]=COLLABORATION_UI_THEMES.map(item=>({id:'collaboration-'+item.id,name:item.label,kind:'chat-decoration',categories:['collaboration'],contents:item.caption,attributionKey:async()=>'',read:async()=>({format:'sullyos-chat-decoration',version:1,name:item.label,parts:{collaboration:validateCollaborationAppearance({uiTheme:item.id})}})}));
  const builtinMeetings:WardrobeEntry[]=(['date','story'] as const).flatMap(kind=>MEETING_APPEARANCES.filter(item=>item.id!=='none').map(item=>({id:kind+'-'+item.id,name:item.name,kind:'chat-decoration' as const,categories:[kind],contents:item.description,attributionKey:async()=>'',read:async()=>validateDecoration({format:'sullyos-chat-decoration',version:1,name:item.name,parts:{[kind]:{preset:item.id}}})})));
  const builtinApps:WardrobeEntry[]=[...SCHEDULE_CARD_PRESETS.map(item=>({id:'schedule-'+item.id,name:item.name,kind:'chat-decoration' as const,categories:['schedule'] as BeautyCategory[],contents:'日程表（全局）',attributionKey:async()=>'',read:async()=>makeAppPreset('schedule',item.name,{preset:item.id})})),...JOURNAL_APPEARANCE_PRESETS.map(item=>({id:'journal-'+item.id,name:item.name,kind:'chat-decoration' as const,categories:['journal'] as BeautyCategory[],contents:'交换日记',attributionKey:async()=>'',read:async()=>makeAppPreset('journal',item.name,{preset:item.id})}))];
  const visibleEntries = browsingEntries.filter(entry => category === 'all' || entry.categories.includes(category));
  const shareEntry=libraryEntries.find(entry=>entry.id===shareSource);
  const applyLocal = async (entry: WardrobeEntry) => {
    setBusy(true); onBusyChange(true); setError('');
    try {
      if (entry.kind === 'appearance') { await applyAppearancePreset(entry.id); trackBeauty('apply','appearance'); closeApp(); }
      else {
        const preset = validateDecoration(await (entry.readLocal || entry.read)());
        if(entry.attributionKey){
          const sourceKey=await entry.attributionKey();
          const presetKey=await decorationSourceKey(preset);
          if(sourceKey!==presetKey)await writeDecorationOrigin(presetKey,await readDecorationOrigin(sourceKey));
        }
        setApplyError('');setApplyAll(false);
        setReceived({ kind: 'chat-decoration', preset, name: preset.name });
      }
    } catch (e) { setError(e instanceof Error ? e.message : '应用失败，请重试'); }
    finally { setBusy(false); onBusyChange(false); }
  };
  const checkUpdate=async(entry:WardrobeEntry)=>{setBusy(true);onBusyChange(true);setError('');setNotice('');try{
    const origin=await readDecorationOrigin(await entry.attributionKey());
    if(origin.kind!=='imported'||!origin.share)throw Error('只有码导入的原件可以检查更新');
    const share=await beautyRequest<BeautyShare>(`/shares/${origin.share.code}`);
    if(share.kind!==entry.kind||share.code!==origin.share.code)throw Error('更新来源不匹配');
    if(share.revision===origin.share.revision){setNotice('已经是最新审核通过的版本。');return;}
    setUpdateEntry({entry,share,previous:origin.share.revision});
  }catch(e){setError(e instanceof Error?e.message:'检查更新失败');}finally{setBusy(false);onBusyChange(false);}};
  const removeEntry=async(entry:WardrobeEntry)=>{
    if(entry.kind==='appearance')await deleteAppearancePreset(entry.id);
    else if(entry.id.startsWith('local-chat-')){await deleteLibraryDecoration(entry.id);await refreshSaved();}
    else if(entry.id.startsWith('bubble-'))await removeCustomTheme(entry.id.slice(7));
    else if(entry.id.startsWith('legacy-')){
      const index=Number(entry.id.slice(7));const raw=await DB.getAssetRaw('chrome_css_presets');
      const list=Array.isArray(raw)?raw:JSON.parse(localStorage.getItem('sully_chrome_css_presets_v1')||'[]');
      const valid=list.filter((item:any)=>typeof item.code==='string');const old=valid[index];
      if(!old||old.code!==validateDecoration(await entry.read()).parts.css)throw Error('预设列表已变化，请重新打开后删除');
      const next=list.filter((item:any)=>item!==old);await DB.saveAssetRaw('chrome_css_presets',next);localStorage.setItem('sully_chrome_css_presets_v1',JSON.stringify(next));setLegacyCss(items=>items.filter((_,i)=>i!==index));
    }
    setNotice('已从本机收藏删除。');
  };
  const goBack = () => {
    if (busy || applying) return;
    if (deleteEntry) { setDeleteEntry(null); return; }
    if (updateEntry) { setUpdateEntry(null); return; }
    if (desktopEdit) { setDesktopEdit(null); return; }
    if (saveCurrent) { setSaveCurrent(null); return; }
    if (received) { setReceived(null); return; }
    if (draft) { setDraft(null); if (guideStep === 2 || guideStep === 3) setGuideStep(4); return; }
    if (searchOpen) { setSearchOpen(false); return; }
    if (page !== 'library') { setPage('library'); if (guideStep === 5 || guideStep === 7) setGuideStep(6); return; }
    (onBack || closeApp)();
  };
  useLocalBackHandler(() => { goBack(); return true; }, 20);
  if(page==='catalog')return <Suspense fallback={<p role="status">正在打开装扮库…</p>}><BeautyCatalog onBack={()=>setPage('library')} onReceive={async(data,share)=>{await receive(data,share);setPage('library');}}/></Suspense>;
  return <div className="beauty-wardrobe">
    <div className="wardrobe-navigation">
      <header className="wardrobe-topline">
        <button className="wardrobe-back" disabled={busy || applying} aria-label={page === 'library' ? initialCategory==='collaboration' ? '返回协同设置' : targetCharacterId ? '返回聊天' : '返回外观设置' : '返回我的装扮'} onClick={goBack}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4-8 8 8 8"/></svg></button>
        <h2>{page === 'library' ? (initialCategory==='collaboration'?'协同工作装扮':libraryContext==='chat'?'聊天装扮':'外观装扮') : page==='receive'?'导入装扮':'分享装扮'}</h2>
        <div className="wardrobe-header-actions">{page==='library'&&<><button disabled={busy} aria-label="搜索本机装扮" onClick={() => { setPage('library'); setSearchOpen(v => !v); }}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/></svg></button>{targetCharacterId&&<button disabled={busy||!targetCharacter} data-dress-guide="mine" aria-label="我 · 当前搭配" onClick={()=>void customize()}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7" r="4"/><path d="M3 21v-2c0-4 4-6 9-6s9 2 9 6v2z"/></svg></button>}</>}</div>
      </header>
      {page === 'library' && <div className="wardrobe-categories" aria-label="按用途浏览本机装扮">
        {BEAUTY_CATEGORIES.filter(([value]) => value==='all'||(value!=='chat'&&belongsInBeautyLibrary([value],libraryContext))).map(([value, label]) => <button key={value} disabled={busy} aria-pressed={category === value} onClick={e => { setCategory(value); e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); }}>{label}</button>)}
      </div>}
    </div>
    <div className="wardrobe-content">
    {page==='library'&&targetCharacterId&&<div className="wardrobe-character-context"><label>当前角色：<select aria-label="当前角色" disabled={busy||applying} value={target} onChange={e=>{setTarget(e.target.value);setNotice('');}}>{!characters.length&&<option value="">暂无角色</option>}{characters.map(character=><option key={character.id} value={character.id}>{character.name}</option>)}</select></label></div>}
    {page==='library'&&libraryContext==='chat'&&<button className="wardrobe-catalog-entry" disabled={busy} onClick={()=>{setGuideStep(null);setPage('catalog');}}><span>装扮库 <small>测试版</small></span><span aria-hidden="true">↗</span></button>}
    {page === 'library' && <div className="wardrobe-entrypoints">
      <button data-dress-guide="import" disabled={busy} onClick={() => {setPage('receive');if(guideStep!==null)setGuideStep(5);}}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5M8 8h8v8H8z"/></svg><span>导入装扮</span><small>›</small></button>
      <button data-dress-guide="share" disabled={busy} onClick={() => {setPage('mine');if(guideStep!==null)setGuideStep(7);}}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M5 14v6h14v-6"/></svg><span>分享装扮</span><small>›</small></button>
    </div>}
    {page==='library'&&<div className="wardrobe-file-actions">{category==='collaboration'&&<button disabled={busy} onClick={async()=>{setBusy(true);try{const preset=createDraft?await createDraft():{format:'sullyos-chat-decoration' as const,version:1 as const,name:'我的协同工作',parts:{collaboration:validateCollaborationAppearance(await CollaborationStore.loadSettings())}};setSaveCurrent({preset,key:'decoration_global_collaboration'});}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>保存当前样式</button>}{category!=='all'&&category!=='chat'&&<button disabled={busy||applying|| (!!targetCharacterId&&!targetCharacter)} onClick={()=>void restoreCategory()}>恢复默认</button>}{!targetCharacterId&&(category==='schedule'||category==='journal')&&<button disabled={busy} onClick={()=>setSaveCurrent({preset:makeAppPreset(category,'我的'+(category==='schedule'?'日程表':'交换日记'),category==='schedule'?theme.scheduleCardAppearance:theme.journalAppearance),key:'decoration_global_'+category})}>保存当前样式</button>}{DECORATION_WORKSHOPS.filter(([id])=>id===category&&belongsInBeautyLibrary([id],libraryContext)).map(([id,label])=><button key={id} disabled={busy} onClick={()=>openMaker(id)}>{label}制作器 ＋</button>)}</div>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    {page === 'library' && <fieldset data-dress-guide="collection" disabled={busy} className="border-0 p-0 m-0 min-w-0">{!(['bubbles','psyche','schedule','journal','date','story'].includes(category) && visibleEntries.length===0) && <BeautyWardrobe getUsage={getUsage} key={category} searchOpen={searchOpen} title={category === 'all' ? '我的收藏' : BEAUTY_CATEGORIES.find(([value]) => value === category)?.[1]} entries={visibleEntries} onEdit={editEntry} onDelete={setDeleteEntry} onUpdate={checkUpdate} onShare={entry=>{setShareSource(entry.id);setPage('mine');}} onExport={entry=>exportEntry(entry)} onApply={entry => { void applyLocal(entry); }}/>}</fieldset>}
    {page==='receive'&&<div data-dress-guide="import-page"><BeautyImportHub key={cssDraft?.text} initialCss={cssDraft} initialCategory={category==='collaboration'?'collaboration':undefined} busy={busy} onFile={file=>{void importFile(file);}} onCssBatch={async items=>{await saveLibraryDecorationBatch(items);trackBeauty('import','css');await refreshSaved();setNotice(`已导入 ${items.length} 份白框，请到收藏中选择应用`);}} onCss={async(preset,origin)=>{await saveLibraryDecoration(preset,origin);trackBeauty('import','css');await refreshSaved();setReceived({kind:'chat-decoration',preset,name:preset.name});setApplyAll(false);}} codePanel={<BeautySharePanel key="receiver" surface="receive" kind="appearance" unified embedded defaultOpen initialTab="receive" sources={[]} onBusyChange={value=>{setBusy(value);onBusyChange(value);}} onReceive={receive} receivedMessage="已保存到本机预设，可选择立即应用。"/>}/></div>}
    {(page==='mine'||page==='submit')&&<section data-dress-guide="share-page" className="wardrobe-share-hub">
      <nav className="wardrobe-share-methods" aria-label="分享方式">{([['file','文件分享'],['image','图片分享'],['code','码分享']] as const).map(([id,label])=><button key={id} disabled={busy} aria-pressed={shareMethod===id} onClick={()=>setShareMethod(id)}>{label}</button>)}</nav>
      {shareMethod==='code'?<BeautySharePanel key="author" surface="author" kind="appearance" unified embedded defaultOpen initialTab="submit" initialSource={shareSource||undefined} onBusyChange={value=>{setBusy(value);onBusyChange(value);}} sources={libraryEntries.map(entry=>({...entry,beforeSubmit:async()=>{const origin=await readDecorationOrigin(await entry.attributionKey());if(origin.allowRedistribute===false)throw Error('作者禁止二次传播，这份作品不能投稿分享');}}))} onReceive={receive}/>:<fieldset disabled={busy} className="beauty-share-panel">
        <p>{shareMethod==='image'?'制作可导入的分享图片，沿用原来的分享卡形式。':'导出预设原文件，接收方可直接导入。'}</p>
        <BeautyPresetPicker allowFile={false} sources={libraryEntries} source={shareSource} file={null} kind={shareEntry?.kind||'chat-decoration'} onSource={setShareSource} onFile={()=>{}}/>
        <label>分享署名<input maxLength={60} value={shareCredit} placeholder="填写你的作者署名；已有作者署名的作品会保留原署名" onChange={e=>setShareCredit(e.target.value)}/></label>
        {shareEntry?.kind==='chat-decoration'&&<button disabled={busy} onClick={()=>void exportEntry(shareEntry,false,true)}>复制带署名的 CSS</button>}
        <button disabled={!shareEntry||busy} onClick={()=>{if(shareEntry)void exportEntry(shareEntry,shareMethod==='image');}}>{busy?'正在准备…':shareMethod==='image'?'制作分享图片':'分享预设文件'}</button>
      </fieldset>}
    </section>}
    {page==='library'&&category==='collaboration'&&<BeautyWardrobe getUsage={getUsage} entries={builtinCollaborations} title="内置协同主题" onEdit={editEntry} onApply={entry=>void applyLocal(entry)}/>}
    {page==='library'&&(category==='date'||category==='story')&&<BeautyWardrobe getUsage={getUsage} entries={builtinMeetings.filter(item=>item.categories?.includes(category))} title={category==='date'?'内置见面美化':'内置剧情美化'} onApply={entry=>{void applyLocal(entry);}}/>}
    {page==='library'&&!targetCharacterId&&(category==='schedule'||category==='journal')&&<BeautyWardrobe getUsage={getUsage} entries={builtinApps.filter(item=>item.categories?.includes(category))} title={category==='schedule'?'内置日程表':'内置日记主题'} onApply={entry=>{void applyLocal(entry);}}/>}
    {saveCurrent&&<BeautyConfirmDialog title="保存当前样式" confirm="保存到装扮收藏" onClose={()=>setSaveCurrent(null)} onConfirm={async()=>{if(!saveCurrent.preset.name.trim())throw Error('请填写名称');const key=await DB.getAsset(saveCurrent.key);const origin=key?await readDecorationOrigin(key):{kind:saveCurrent.preset.parts.collaboration?'self' as const:'legacy' as const};await saveLibraryDecoration(saveCurrent.preset,origin);await refreshSaved();setNotice('已保存到装扮收藏');}}><label>美化名称<input value={saveCurrent.preset.name} maxLength={60} onChange={e=>setSaveCurrent({...saveCurrent,preset:{...saveCurrent.preset,name:e.target.value}})}/></label><p>只保存样式，不包含协同任务、文件、API、日程、日记内容或角色资料。</p></BeautyConfirmDialog>}
    {page === 'library' && libraryContext==='chat' && (category === 'all' || category === 'chat' || category === 'whitebox') && <BeautyWardrobe getUsage={getUsage} entries={builtinWhitebox} title="内置白框" onEdit={editEntry} onApply={entry=>{void applyLocal(entry);}}/>}
    {page === 'library' && libraryContext==='appearance' && (category === 'all' || category === 'appearance') && <BeautyWardrobe getUsage={getUsage} entries={builtinAppearance} title="内置桌面主题" onApply={entry=>{void applyLocal(entry);}}/>}
    {page === 'library' && libraryContext==='chat' && (category === 'all' || category === 'bubbles') && <BeautyWardrobe getUsage={getUsage} entries={builtinBubbles} title="内置气泡" onApply={entry=>{void applyLocal(entry);}} onEdit={editEntry}/>}
    {page==='library'&&libraryContext==='chat'&&(category==='all'||category==='sound')&&<BeautyWardrobe getUsage={getUsage} entries={builtinSounds} title="内置提示音" onApply={entry=>void applyLocal(entry)}/>}
    {page === 'library' && libraryContext==='chat' && category === 'psyche' && <BeautyWardrobe getUsage={getUsage} entries={builtinPsyche} title="内置心象" onApply={entry=>{void applyLocal(entry);}}/>}
    {page === 'library' && <><BeautyRepoLibrary/>{targetCharacterId&&<button className="dress-guide-replay" onClick={()=>setGuideStep(0)}>再看一次使用引导</button>}</>}
    {draft?.maker==='bubbles'?createPortal(<div className="decoration-bubble-maker" role="dialog" aria-modal="true" aria-label="气泡制作器"><Suspense fallback={<p>正在打开气泡制作器…</p>}><BubbleMaker embedded initialTheme={draft.preset.parts.bubbles} onClose={()=>setDraft(null)} onSaveTheme={async bubbles=>{const preset=await portableDecoration({format:'sullyos-chat-decoration',version:1,name:bubbles.name,parts:{bubbles}});if(draft.originalEntryId?.startsWith('bubble-')&&['self','remix'].includes(draft.origin.kind)){await addCustomTheme({...bubbles,id:draft.originalEntryId.slice(7)});await writeDecorationOrigin(draft.originalEntryId,remixOrigin(draft.origin));}else await saveLibraryDecoration(preset,remixOrigin(draft.origin),draft.originalKey&&['self','remix'].includes(draft.origin.kind)?draft.originalKey:undefined);trackBeauty('save','bubbles');await refreshSaved();setDraft(null);setReceived({kind:'chat-decoration',preset,name:preset.name});setApplyAll(false);}}/></Suspense></div>,document.body):draft&&<DecorationDraftEditor getUsage={getUsage} {...draft} outfits={outfitEntries} onOutfitsChange={refreshSaved} characterName={targetCharacter?.name} theme={theme} sources={[...entries.filter(entry=>entry.kind==='chat-decoration'&&!outfitIds.has(entry.id)),...builtinWhitebox,...builtinBubbles,...builtinSounds,...builtinPsyche,...builtinApps,...builtinMeetings]} onOpenWorkshop={()=>openMaker('bubbles')} onClose={()=>{setDraft(null);if(guideStep===2||guideStep===3)setGuideStep(4);}} onApply={async(preset,origin)=>{await writeOrigin(await decorationSourceKey(preset),origin);setDraft(null);if(guideStep===2||guideStep===3)setGuideStep(4);setApplyAll(false);setReceived({kind:'chat-decoration',preset,name:preset.name});}} onSaved={preset=>{setDraft(null);void refreshSaved().catch(()=>setError('预设已保存，列表刷新失败，请重新打开'));setReceived({kind:'chat-decoration',preset,name:preset.name});setApplyAll(false);}}/>}
    </div>
    {catalogNotice && !firstGuideActive && page==='library' && !draft && <BeautyUpdateNotice onClose={()=>setCatalogNotice(false)}/>}
    {!catalogNotice&&guideStep!==null&&!firstGuideActive&&!draft?.maker&&<DecorationGuide step={guideStep} onSkip={endGuide} onNext={()=>{if(guideStep===7)endGuide();else if(guideStep===5){setPage('library');setGuideStep(6);}else setGuideStep(guideStep+1);}}/>}
    {deleteEntry&&<BeautyConfirmDialog title="删除这份装扮？" confirm="删除" danger onClose={()=>setDeleteEntry(null)} onConfirm={()=>removeEntry(deleteEntry)}><p>「{deleteEntry.name}」将从本机收藏移除。</p><p>{deleteEntry.id.startsWith('bubble-')?'仍在使用这份气泡的角色将回到默认气泡。':'已应用的装扮会保留。'}不会撤下已发布的分享码。</p></BeautyConfirmDialog>}
    {updateEntry&&<BeautyConfirmDialog title="发现新版装扮" confirm="同意规范并更新" onClose={()=>setUpdateEntry(null)} onConfirm={async()=>{
      const {entry,share,previous}=updateEntry;
      const pack=await downloadBeauty(share,share.kind);
      if(entry.kind==='appearance'){
        const origin=await readDecorationOrigin(entry.id);if(origin.share?.code!==share.code||origin.share?.revision!==previous)throw Error('本机版本已变化，请重新检查');
        await replaceAppearancePreset(entry.id,pack,{kind:'imported',share});
      }else{await replaceReceivedDecoration(entry.id,validateDecoration(pack),share,previous);await refreshSaved();}
      trackBeauty('update',entry.kind==='appearance'?'appearance':'chat');setNotice('本机收藏已更新。当前角色的搭配保持原样，需要时可重新应用。');
    }}><p>{updateEntry.share.metadata.name} · {updateEntry.share.metadata.credit}</p><p>{updateEntry.share.metadata.message||'作者未填写更新说明。'}</p><p>{updateEntry.share.metadata.allowRemix?'允许二改':'禁止二改'} · {updateEntry.share.metadata.allowRedistribute?'允许二次传播':'禁止二次传播'}</p><p>导出版本：{updateEntry.share.metadata.exportVersion}</p><p>将替换本机这份收藏，不会自动改变角色的装扮。</p></BeautyConfirmDialog>}
    {desktopEdit&&<BeautyConfirmDialog title="编辑桌面主题" confirm="保存预设" onClose={()=>setDesktopEdit(null)} onConfirm={async()=>{
      if(!desktopEdit.name.trim())throw Error('请填写名称');
      const original=await desktopEdit.entry.read() as any;
      const currentTheme={...theme};if(currentTheme.wallpaper?.startsWith('blob:'))currentTheme.wallpaper=await DB.getAsset('wallpaper')||'';if(currentTheme.lockWallpaper?.startsWith('blob:'))currentTheme.lockWallpaper=await DB.getAsset('lock_wallpaper')||undefined;
      const pack={...original,name:desktopEdit.name.trim(),...(desktopEdit.useCurrent?{theme:currentTheme}:{})};
      if(['self','remix'].includes(desktopEdit.origin.kind)){await replaceAppearancePreset(desktopEdit.entry.id,pack,remixOrigin(desktopEdit.origin));}
      else{const id=await onImport(new File([JSON.stringify(pack)],'preset.json'));await writeDecorationOrigin(id,remixOrigin(desktopEdit.origin));}
      setNotice('桌面主题已保存。');
    }}><label>预设名称<input value={desktopEdit.name} maxLength={60} onChange={e=>setDesktopEdit({...desktopEdit,name:e.target.value})}/></label><label><input type="checkbox" checked={desktopEdit.useCurrent} onChange={e=>setDesktopEdit({...desktopEdit,useCurrent:e.target.checked})}/>用当前桌面外观替换主题设置</label><p>{['self','remix'].includes(desktopEdit.origin.kind)?'保存会更新原预设，保留投稿关联。':'保存为二改副本，保留原作者的使用规范。'}</p></BeautyConfirmDialog>}
    {received && <div role="dialog" aria-modal="true" aria-labelledby="beauty-apply-title" className="fixed inset-0 z-[100] bg-black/30 flex items-center justify-center p-5">
      <div className="bg-white rounded-2xl p-5 w-full max-w-sm shadow-xl text-slate-700">
        <h3 id="beauty-apply-title" className="text-lg font-medium">是否立即应用？</h3>
        <p className="text-sm mt-3 break-words">应用「{received.name}」</p>
        {received.kind === 'appearance' ? <p className="text-xs text-slate-500 mt-2">应用后返回桌面，查看新的主题效果。</p> : received.preset.parts.collaboration?<p className="text-xs text-slate-500 mt-2">应用到所有协同窗口，只替换主题、头像样式和 CSS，任务记录与 API 配置保持不变。</p>:received.preset.parts.story?<p className="text-xs text-slate-500 mt-2">应用到剧情放映厅，不修改剧情内容或提示词。</p>:isAppDecoration(received.preset)?<p className="text-xs text-slate-500 mt-2">{received.preset.parts.schedule?'同步桌面组件及聊天内日程表的外观，不修改日程安排。':'同步交换日记 App 的外观，不修改日记内容。'}已收纳到外观 App。</p>:<>
          <label className="block text-sm mt-4">选择应用角色<select disabled={applying||applyAll} value={target} onChange={e => setTarget(e.target.value)} className="block w-full mt-2 p-3 border rounded-xl">
            <option value="">请选择角色</option>{characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
          </select></label>
          {hasAvatarFrameCss(received.preset)&&<label className="block text-sm mt-4">头像框给谁用<select aria-label="头像框给谁用" disabled={applying} value={avatarTarget} onChange={e=>setAvatarTarget(e.target.value as AvatarFrameTarget)} className="block w-full mt-2 p-3 border rounded-xl">{AVATAR_FRAME_TARGETS.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>}
          <label className="beauty-share-check"><input type="checkbox" disabled={applying} checked={applyAll} onChange={e=>setApplyAll(e.target.checked)}/>应用到所有角色（{characters.length}）</label>
          <p className="text-xs text-slate-500 mt-2">{applyAll?'将替换全部现有角色的对应装扮。':'只替换所选角色的对应装扮。'}{!characters.length && '暂无角色，可稍后创建角色再应用。'}</p>
        </>}
        {applyError && <p role="alert" className="text-sm text-red-600 mt-3">{applyError}</p>}
        <div className="flex justify-end gap-3 mt-5">
          <button disabled={applying} onClick={() => setReceived(null)} className="px-3 py-2 text-sm">暂不应用</button>
          <button disabled={applying || (received.kind === 'chat-decoration' && !isAppDecoration(received.preset) && !received.preset.parts.story && !received.preset.parts.collaboration && !target)} onClick={applyReceived} className="px-4 py-2 rounded-xl bg-slate-800 text-white text-sm disabled:opacity-40">{applying ? '正在应用…' : received.kind === 'appearance' ? '应用并查看桌面' : '立即应用'}</button>
        </div>
      </div>
    </div>}
  </div>;
}
