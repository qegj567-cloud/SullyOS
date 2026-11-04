import {playWhiteboxSound,unlockWhiteboxAudio} from '../../utils/whiteboxSound';
import {resolveCssImageUrls} from '../../utils/cssImageAssets';
import {decorationPreviewScenes,decorationThumbnailPart,type DecorationThumbnailPart} from '../../utils/decorationPreviewScenes';
import React, { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {embedBeautyCaptureImages} from '../../utils/beautyCaptureAssets';
import {renderIsolatedBeautyCapture, waitForBeautyCapture, waitForBeautyCaptureFonts} from '../../utils/beautyCaptureWait';
import {enqueuePreviewBuild} from '../../utils/previewRenderQueue';
import { beautyPreviewDocument, PREVIEW_WIDTH, PREVIEW_HEIGHT } from '../../utils/beautyPreview';
import {bindDecorationPreview,type DecorationPreviewState} from '../../utils/decorationPreviewInteraction';

export interface BeautyPreviewHandle { capture: () => Promise<HTMLCanvasElement> }
interface Props { data: unknown; compact?: boolean; sceneScope?: 'preset'|'all'; thumbnailPart?:DecorationThumbnailPart|'full' }
function copyPaint(element: Element, scrolls: Array<[HTMLElement,number,number]>): HTMLElement {
  const clone = (element instanceof HTMLTextAreaElement ? document.createElement('div') : element.cloneNode(false)) as HTMLElement;
  const computed = getComputedStyle(element);
  for (const key of Array.from(computed)) clone.style.setProperty(key, computed.getPropertyValue(key));
  // Freeze pseudo-element appearance without copying the author's CSS selectors.
  const pseudo = (name: string) => {
    const css = getComputedStyle(element, name);
    if (!css.content || css.content === 'none' || css.content === 'normal' || css.display === 'none') return;
    const part = document.createElement('span');
    for (const key of Array.from(css)) part.style.setProperty(key, css.getPropertyValue(key));
    if (/^["']/.test(css.content)) part.textContent = css.content.slice(1, -1);
    clone.append(part);
  };
  if (element instanceof HTMLTextAreaElement) {
    clone.textContent = element.value || element.placeholder;
    if (!element.value) clone.style.color = getComputedStyle(element, '::placeholder').color;
    return clone;
  }
  pseudo('::before');
  for (const node of Array.from(element.childNodes)) {
    if (node instanceof Element && node.tagName !== 'STYLE') clone.append(copyPaint(node,scrolls));
    else if (node.nodeType === Node.TEXT_NODE) clone.append(node.cloneNode());
  }
  pseudo('::after');
  if(element instanceof HTMLElement && (element.scrollTop||element.scrollLeft))scrolls.push([clone,element.scrollTop,element.scrollLeft]);
  return clone;
}
export default memo(forwardRef<BeautyPreviewHandle, Props>(function BeautyPresetPreview({ data, compact = false, sceneScope = 'preset', thumbnailPart }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const activeCapture = useRef<AbortController|null>(null);
  useEffect(() => () => activeCapture.current?.abort(), []);
  const [width, setWidth] = useState(PREVIEW_WIDTH);
  const [desktopPage, setDesktopPage] = useState(0);
  const [desktopPages, setDesktopPages] = useState(1);
  useEffect(() => { setDesktopPage(0); setDesktopPages(1); }, [data]);
  const isChat = (data as any)?.format === 'sullyos-chat-decoration';
  const soundOnly=compact&&isChat&&Object.keys((data as any).parts||{}).length===1&&Object.hasOwn((data as any).parts,'sound');
  const part = compact && isChat && thumbnailPart!=='full' ? thumbnailPart||decorationThumbnailPart(data) : undefined;
  const height = part==='psyche' ? 180 : part ? PREVIEW_WIDTH : isChat ? PREVIEW_HEIGHT : 720;
  const [scene, setScene] = useState(()=>(data as any)?.parts?.psyche && Object.keys((data as any).parts).length===1 ? 'psyche' : 'conversation');
  const scenes = decorationPreviewScenes(data,sceneScope);
  const sceneId = !compact && scenes.some(item=>item.id===scene) ? scene : scenes[0].id;
  const sceneIndex=scenes.findIndex(item=>item.id===sceneId);
  const [interaction,setInteraction]=useState<{data:unknown;scene:string;state:DecorationPreviewState}|null>(null);
  const liveState=interaction&&interaction.data===data&&interaction.scene===sceneId?interaction.state:undefined;
  useEffect(()=>setInteraction(null),[data,sceneId]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [visible,setVisible]=useState(!compact);
  useEffect(()=>{
    if(!compact||typeof IntersectionObserver==='undefined'){setVisible(true);return;}
    const observer=new IntersectionObserver(items=>setVisible(items.some(item=>item.isIntersecting)),{rootMargin:'80px'});
    if(container.current)observer.observe(container.current);
    return()=>observer.disconnect();
  },[compact]);
  useEffect(() => {
    if(!visible||soundOnly)return;
    setReady(false); setError('');
    let alive = true;let cleanup:undefined|(()=>void);let releaseImages:undefined|(()=>void);
    const build = async () => { try {
      const sample = isChat
        ? await import('../chat/ChatDecorationSample').then(module=>alive?module.renderChatDecorationSample(data,sceneId,part,liveState):null)
        : await import('./DesktopDecorationSample').then(module=>alive?module.renderDesktopDecorationSample(data,compact ? 0 : desktopPage):null);
      if (!alive || !host.current) return;
      const shadow = host.current.shadowRoot || host.current.attachShadow({ mode: 'open' });
      const scrollTop=shadow.querySelector('.sample-messages')?.scrollTop||0;
      const focusAction=shadow.activeElement?.getAttribute('data-preview-action');
      const parsed = new DOMParser().parseFromString(sample ? sample.markup : beautyPreviewDocument(data), 'text/html');
      if (!isChat) setDesktopPages(Math.max(1, parsed.querySelector('.launcher-pages')?.children.length || 1));
      const style = document.createElement('style');
      // Only text CSS and our own escaped sample markup cross this boundary, never scripts.
      shadow.adoptedStyleSheets=[];
      style.textContent = sample ? sample.css+'\n*{animation:none!important;transition:none!important;pointer-events:none!important}.sample-messages,.no-scrollbar{pointer-events:auto!important}'+(!compact?'[data-preview-action],[data-preview-action] *,[data-preview-backdrop],.sully-chat-transfer-dialog{pointer-events:auto!important}[data-preview-action]:focus-visible{outline:2px solid #8a72ad!important;outline-offset:2px}':'') : (parsed.querySelector('style')?.textContent || '').replace('html,body{', '.beauty-preview-body{').replace('body{background:', '.beauty-preview-body{background:');
      const images = await resolveCssImageUrls(style.textContent || '');
      if (!alive) {images.dispose(); return;}
      releaseImages = images.dispose; style.textContent = images.css;
      const body = document.createElement('div'); body.className = 'beauty-preview-body';
      for (const child of Array.from(parsed.body.children)) body.append(child.cloneNode(true));
      shadow.replaceChildren(style, body);
      if(sample&&isChat&&!compact){
        cleanup=bindDecorationPreview(body,liveState||{},!!scenes.find(item=>item.id===sceneId)?.expanded,state=>setInteraction({data,scene:sceneId,state}));
        const messages=body.querySelector('.sample-messages');if(messages)messages.scrollTop=scrollTop;
        if(focusAction)Array.from(body.querySelectorAll<HTMLElement>('[data-preview-action]')).find(el=>el.getAttribute('data-preview-action')===focusAction)?.focus({preventScroll:true});
      }
      // Preset :host selectors cannot resize, position or expose the host outside its clip.
      for (const [key, value] of Object.entries({ width: '360px', height: `${height}px`, display: 'block', position: 'relative', overflow: 'hidden', contain: 'strict', 'pointer-events': compact ? 'none' : 'auto' })) host.current.style.setProperty(key, value, 'important');
      setReady(true);
    } catch (e) { releaseImages?.(); if(alive)setError(e instanceof Error ? e.message : '预览失败'); } };
    const cancel=compact?enqueuePreviewBuild(build):undefined;
    if(!compact)void build();
    return () => {alive=false;cancel?.();cleanup?.();releaseImages?.();};
  }, [data,sceneId,isChat,compact,part,height,liveState,desktopPage,visible,soundOnly]);
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(entries => setWidth(Math.min(PREVIEW_WIDTH, entries[0].contentRect.width)));
    observer.observe(container.current); return () => observer.disconnect();
  }, []);
  useImperativeHandle(ref, () => ({
    capture: async () => {
      const element = host.current;
      if (!ready || !element?.shadowRoot) throw Error('预览尚未加载完成，请稍后再试');
      const body = element.shadowRoot.querySelector<HTMLElement>('.beauty-preview-body');
      if (!body) throw Error('预览内容尚未就绪');
      activeCapture.current?.abort();
      const controller = new AbortController(); activeCapture.current = controller;
      let stage = '预览字体加载';
      const timeout = window.setTimeout(() => controller.abort(Error(`${stage}超时，请检查网络后重试；不会提交未完成的封面。`)), 30000);
      try {
        await waitForBeautyCaptureFonts(body, controller.signal);
        const scrolls:Array<[HTMLElement,number,number]>=[];
        const snapshot = copyPaint(body,scrolls);
        stage = '封面图片加载';
        await waitForBeautyCapture(embedBeautyCaptureImages(snapshot, controller.signal), controller.signal);
        stage = '封面绘制';
        return await renderIsolatedBeautyCapture(snapshot, PREVIEW_WIDTH, height, controller.signal, scrolls);
      } finally {
        clearTimeout(timeout);
        if (activeCapture.current === controller) activeCapture.current = null;
      }
    },
  }), [ready,height]);
  if(soundOnly)return <div className="beauty-preset-preview" data-thumbnail-part="sound" style={{display:'grid',placeItems:'center',aspectRatio:'1',color:'#8b829a',background:'#efedf4'}}><svg aria-hidden="true" viewBox="0 0 80 48" width="60%" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round"><path d="M8 21v6m10-12v18m11-23v28m11-34v40m11-32v24m11-19v14m10-10v6"/></svg><small>{(data as any).parts.sound?.src && (data as any).parts.sound.src!=='none'?'提示音 · 点开试听':'静音'}</small></div>;
  return <div className="beauty-preset-preview" data-thumbnail-part={part} ref={container}>
    {!isChat && !compact && desktopPages > 1 && <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:16,marginBottom:10}}>
      <button type="button" aria-label="上一页桌面" title="上一页桌面" disabled={desktopPage === 0} onClick={() => setDesktopPage(p => p - 1)}>←</button>
      <select aria-label="预览桌面页" value={desktopPage} onChange={e => setDesktopPage(Number(e.target.value))}>{Array.from({length:desktopPages},(_,i)=><option key={i} value={i}>第 {i + 1} / {desktopPages} 页</option>)}</select>
      <button type="button" aria-label="下一页桌面" title="下一页桌面" disabled={desktopPage >= desktopPages - 1} onClick={() => setDesktopPage(p => p + 1)}>→</button>
    </div>}
    {isChat && !compact && scenes.length>1 && <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:10,fontSize:12,color:'#666'}}><select aria-label="预览聊天内容" value={sceneId} onChange={event=>setScene(event.target.value)} style={{flex:1,minWidth:0,padding:'8px 10px',borderRadius:8,background:'#f2f2f2',color:'#333'}}>{scenes.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select><button type="button" aria-label="上一条预览" title="上一条预览" disabled={sceneIndex<=0} onClick={()=>setScene(scenes[sceneIndex-1].id)} style={{padding:0,width:32,minHeight:36,flexShrink:0}}>↑</button><button type="button" aria-label="下一条预览" title="下一条预览" disabled={sceneIndex>=scenes.length-1} onClick={()=>setScene(scenes[sceneIndex+1].id)} style={{padding:0,width:32,minHeight:36,flexShrink:0}}>↓</button></div>}
    {!compact && isChat && (data as any)?.parts?.sound?.src && (data as any).parts.sound.src!=='none' && <button type="button" onClick={()=>{unlockWhiteboxAudio();playWhiteboxSound((data as any).parts.sound);}}>试听提示音</button>}
    {error && <p role="alert">{error}</p>}
    <div style={{ height: height * width / PREVIEW_WIDTH, width, margin: 'auto', overflow: 'hidden', borderRadius: 20 }}>
      <div ref={host} data-beauty-preview-source role={isChat&&!compact?'group':'img'} aria-label="美化预设搭配预览" style={{ width: PREVIEW_WIDTH, height, transform: `scale(${width / PREVIEW_WIDTH})`, transformOrigin: 'top left' }}/>
    </div>
    {!compact && <p className="beauty-preview-caption">{isChat && sceneId==='collaboration'?'协同工作样式预览 · 仅使用示例任务与文件，不读取真实内容。':isChat && (sceneId==='date-reading'||sceneId==='story-reading')?'阅读界面样式预览 · 仅使用虚构文字。':isChat && sceneId==='journal-app'?'交换日记样式预览 · 示例日记本，不读取真实内容。':isChat && sceneId==='schedule-card' ? '日程表样式预览 · 示例日程，不读取真实安排。' : isChat ? <>试着点击心象、转账卡或聊天加号 · 仅演示，不影响真实聊天。 <button type="button" onClick={()=>setInteraction(null)}>重置演示</button></> : desktopPages > 1 ? '桌面预览 · 示例角色与消息，未应用到本机。' : '特殊皮肤示意预览 · 不代表实际桌面布局。'}</p>}
  </div>;
}));
