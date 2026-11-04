import BeautyShareContents from './BeautyShareContents';
import {DEFAULT_SHARE_SELECTION,selectBeautyShareContents,type BeautyShareSelection} from '../../utils/beautyShareContents';
import {trackBeauty} from '../../utils/beautyAnalytics';
import {readRememberedBeautyAuthor,rememberBeautyAuthor,forgetBeautyAuthor} from '../../utils/beautyAuthorBackup';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { APP_VERSION } from '../../utils/buildInfo';
import { BEAUTY_PLATFORMS, validateBeautyMetadata, validateBeautyPassword, type BeautyKind, type BeautyMetadata, type BeautyShare, type BeautySubmission } from '../../utils/beautyShareContract';
import { beautyRequest, downloadBeauty, normalizeBeautyPackage, readBeautyPackage, readBeautySession, saveBeautySession, type BeautySession } from '../../utils/beautyShareClient';
import { confirmExportSafety } from '../../utils/exportGuard';
import { shareOrDownloadFile } from '../../utils/shareExport';
import BeautyConfirmDialog from './BeautyConfirmDialog';
import BeautyUpdateNotice, { BEAUTY_AUTHOR_NOTICE, needsBeautyNotice } from './BeautyUpdateNotice';
import {beautyFingerprint,readBeautyBinding,bindBeautySource} from '../../utils/beautySourceBinding';
import BeautyPresetPicker from './BeautyPresetPicker';
import BeautyPresetPreview from './BeautyPresetPreview';
import BeautyCatalogConsent from './BeautyCatalogConsent';
import BeautyTermsEditor from './BeautyTermsEditor';
import {validateCatalogCover} from '../../utils/beautyCatalogContract';
import './BeautySharePanel.css';
import type { BeautyCategory } from '../../utils/beautyCategories';

export interface BeautySource { id: string; name: string; bindingId?:string; kind?: BeautyKind; categories?: BeautyCategory[]; revision?: unknown; read: () => Promise<unknown>; readCurrent?:()=>Promise<unknown>; beforeSubmit?:()=>Promise<void> }
interface Props {
  kind: BeautyKind;
  sources: BeautySource[];
  onReceive: (data: any, share: BeautyShare) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  defaultOpen?: boolean;
  initialSource?: string;
  initialTab?: 'receive' | 'submit' | 'mine';
  receivedMessage?: string;
  embedded?: boolean;
  unified?: boolean;
  onOpenReceiver?: () => void;
  surface?:'receive'|'author';
}
const DEFAULTS = 'sully-beauty-author-defaults-v1';
function initialMetadata(): BeautyMetadata {
  let saved: Partial<BeautyMetadata> = {};
  try { saved = JSON.parse(localStorage.getItem(DEFAULTS) || '{}'); } catch { /* Fresh form */ }
  return { name: '', allowPublicListing:false, credit: typeof saved.credit === 'string' ? saved.credit : '', platforms: Array.isArray(saved.platforms) ? saved.platforms.filter(p => BEAUTY_PLATFORMS.includes(p as any)) : [], contact: saved.contact || '', allowRemix: saved.allowRemix === true, allowRedistribute: saved.allowRedistribute === true, exportVersion: APP_VERSION, bugFeedback: saved.bugFeedback === 'self-fix' ? 'self-fix' : 'welcome', message: saved.message || '' };
}
function Terms({ metadata: m }: { metadata: BeautyMetadata }) {
  return <div className="beauty-share-terms"><strong>{m.name}</strong><p>署名：{m.credit}</p><p>Repo 平台：{m.platforms.join('、')}{m.contact && ` · ${m.contact}`}</p><p>{m.allowRemix ? '允许二改' : '不允许二改'} · {m.allowRedistribute ? '允许二次传播' : '不允许二次传播'}</p><p>导出版本：{m.exportVersion}</p><p>{m.bugFeedback === 'welcome' ? '欢迎反馈 Bug' : 'Bug 请自行修复处理'}</p>{m.message && <p className="beauty-share-message">{m.message}</p>}</div>;
}

export default function BeautySharePanel({ kind, sources, onReceive, onBusyChange, defaultOpen = false, initialTab = 'receive', receivedMessage, embedded = false, unified = false, onOpenReceiver, surface, initialSource }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<'receive' | 'submit' | 'mine'>(initialTab);
  const [session, setSession] = useState(readBeautySession);
  const [remembered,setRemembered]=useState(readRememberedBeautyAuthor);
  const [remember,setRemember]=useState(!!remembered);
  const [memoryPassword,setMemoryPassword]=useState('');
  const [loginMode, setLoginMode] = useState(!!remembered);
  const [authorCode, setAuthorCode] = useState(remembered?.authorCode||'');
  const [password, setPassword] = useState(remembered?.password||'');
  const [repeat, setRepeat] = useState('');
  const [mustSave, setMustSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [metadata, setMetadata] = useState(() => ({ ...initialMetadata(), name: sources.find(s=>s.id===initialSource)?.name || sources[0]?.name || '' }));
  const [source, setSource] = useState(initialSource || sources[0]?.id || 'file');
  const [fileKind, setFileKind] = useState(kind);
  const submissionKind = unified ? sources.find(s => s.id === source)?.kind || fileKind : kind;
  const [file, setFile] = useState<File | null>(null);
  const [editing, setEditing] = useState<BeautySubmission | null>(null);
  const [submissions, setSubmissions] = useState<BeautySubmission[]>([]);
  const [authorNotice, setAuthorNotice] = useState(false);
  const [selectedTerms,setSelectedTerms]=useState<BeautySubmission[]>([]);
  const [termsItems,setTermsItems]=useState<BeautySubmission[]|null>(null);
  const [loaded, setLoaded] = useState(false);
  const [page, setPage] = useState({ offset: 0, total: 0, pageSize: 12, nextOffset: null as number | null });
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [updateCandidate,setUpdateCandidate]=useState<{item:BeautySubmission;source:BeautySource;pack:unknown;selection:BeautyShareSelection}|null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [share, setShare] = useState<BeautyShare | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [previewPack, setPreviewPack] = useState<unknown>(null);
  const [submissionPreview,setSubmissionPreview]=useState<unknown>(null);
  const [confirmedWork,setConfirmedWork]=useState<{pack:unknown;kind:BeautyKind;name:string;source:string;selection:BeautyShareSelection}|null>(null);
  const selectedWork=useMemo(()=>confirmedWork?selectBeautyShareContents(confirmedWork.pack,confirmedWork.selection):null,[confirmedWork]);
  const selectedCandidate=useMemo(()=>updateCandidate?selectBeautyShareContents(updateCandidate.pack,updateCandidate.selection):null,[updateCandidate]);
  useLocalBackHandler(()=>{
    if(busy||mustSave)return true;
    if(deleteId)setDeleteId(null);
    else if(updateCandidate)setUpdateCandidate(null);
    else if(termsItems)setTermsItems(null);
    else if(authorNotice)setAuthorNotice(false);
    else if(confirmedWork)setConfirmedWork(null);
    else if(editing)setEditing(null);
    else if(previewPack)setPreviewPack(null);
    else return false;
    return true;
  }, 30, open);
  const [catalogCover,setCatalogCover]=useState('');
  const [candidateCover,setCandidateCover]=useState('');
  useEffect(()=>setCatalogCover(''),[confirmedWork]);
  useEffect(()=>setCandidateCover(''),[updateCandidate]);
  const flowRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(tab==='submit'&&confirmedWork){flowRef.current?.scrollIntoView?.({block:'start'});flowRef.current?.focus({preventScroll:true});}},[confirmedWork,tab]);
  const confirmWork=()=>{
    if(!submissionPreview)return;
    const name=sources.find(s=>s.id===source)?.name||file?.name||'我的美化';
    setConfirmedWork({pack:structuredClone(submissionPreview),kind:submissionKind,name,source,selection:{...DEFAULT_SHARE_SELECTION}});
    setError('');setNotice('');
  };
  const field = <K extends keyof BeautyMetadata>(key: K, value: BeautyMetadata[K]) => setMetadata(m => ({ ...m, [key]: value }));
  const run = async (work: () => Promise<void>) => {
    setBusy(true); onBusyChange?.(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试'); }
    finally { setBusy(false); onBusyChange?.(false); }
  };
  const refresh = async (auth = session, offset = page.offset, status = filter, search = appliedQuery) => {
    if (!auth) return;
    const result = await beautyRequest<{ submissions: BeautySubmission[]; total: number; offset: number; pageSize: number; nextOffset: number | null }>(`/submissions?offset=${offset}&status=${status}&q=${encodeURIComponent(search)}`, { token: auth.token });
    setSubmissions(result.submissions); setPage(result); setLoaded(true); setDeleteId(null);
    if (result.submissions.length && needsBeautyNotice(BEAUTY_AUTHOR_NOTICE)) setAuthorNotice(true);
  };
  const authenticate = () => run(async () => {
    validateBeautyPassword(password);
    if (!loginMode && password !== repeat) throw Error('两次输入的密码不一致');
    const next = await beautyRequest<BeautySession>(loginMode ? '/auth/login' : '/auth/register', { method: 'POST', body: loginMode ? { authorCode, password } : { password } });
    if(remember)rememberBeautyAuthor(next.authorCode,password);else forgetBeautyAuthor();setRemembered(readRememberedBeautyAuthor());
    saveBeautySession(next); setSession(next); setPassword(''); setRepeat(''); setMustSave(!loginMode);
    await refresh(next, 0);
  });
  const submit = () => run(async () => {
    if (!session || mustSave) throw Error('请先保存作者码和密码');
    if (!confirmedWork) throw Error('请先确认要分享的作品');
    const m = validateBeautyMetadata({ ...metadata, exportVersion: APP_VERSION });
    const selected = sources.find(s => s.id === confirmedWork.source);
    if(confirmedWork.source!=='file')await selected?.beforeSubmit?.();
    const pack = normalizeBeautyPackage(selectedWork, confirmedWork.kind);
    if (!(await confirmExportSafety(pack))) return;
    const fingerprint=await beautyFingerprint(pack,confirmedWork.kind);
    const result=await beautyRequest<{id:string;revision:string}>(editing ? `/submissions/${editing.id}` : '/submissions', { method: 'POST', token: session.token, body: { metadata: m, package: pack, ...(m.allowPublicListing?{catalogCover:validateCatalogCover(catalogCover)}:{}), ...(editing ? { expectedRevision: editing.latestRevision } : {}) } });
    if(selected?.bindingId&&result?.id){try{await bindBeautySource(session.authorCode,result.id,{sourceId:selected.bindingId,kind:confirmedWork.kind,fingerprint,revision:result.revision,selection:confirmedWork.selection});}catch{setError('投稿已成功，但本机关联未保存。请在我的提交中手动选择作品更新。');}}
    trackBeauty('submit',editing?'revision':'new');
    localStorage.setItem(DEFAULTS, JSON.stringify({ ...m, name: '' }));
    setMetadata(m=>({...m,allowPublicListing:false}));setEditing(null);setConfirmedWork(null); setTab('mine'); setFilter('all'); setQuery(''); setAppliedQuery(''); setNotice('作品已送达，感谢你的分享。人工审核通常需要 1–2 天，通过后就能把专属美化码带给大家了。');await refresh(session, 0, 'all', '');
  });

  const checkOriginal=(item:BeautySubmission)=>run(async()=>{
    if(!session||item.pendingRevision)throw Error('请等待当前版本审核完成');
    const binding=await readBeautyBinding(session.authorCode,item.id);
    const original=binding&&sources.find(s=>s.bindingId===binding.sourceId&&s.kind===binding.kind);
    if(!binding||!original)throw Error('本机没有关联的原始装扮，请用「选择文件更新」重新选择并关联作品。');
    if(binding.revision!==item.latestRevision)throw Error('此作品已在其他地方更新，请用「选择文件更新」确认并重新关联。');
    await original.beforeSubmit?.();
    const pack=normalizeBeautyPackage(await (original.readCurrent||original.read)(),item.kind);
    const selection=binding.selection||{...DEFAULT_SHARE_SELECTION};
    const fingerprint=await beautyFingerprint(selectBeautyShareContents(pack,selection),item.kind);
    if(fingerprint===binding.fingerprint){setNotice('原始装扮没有变化，无需重复提交。');return;}
    setUpdateCandidate({item,source:original,pack:structuredClone(pack),selection});
  });
  useEffect(() => { if (open && session && surface !== 'receive') void run(() => refresh(session, 0)); }, [open]);
  return <section className="beauty-share-panel">
    {authorNotice && open && surface !== 'receive' && <BeautyUpdateNotice author onClose={()=>setAuthorNotice(false)}/>}
    {!embedded && <button type="button" className="beauty-share-heading" disabled={busy} aria-expanded={open} onClick={() => setOpen(v => !v)}>美化分享码 <span>{open ? '收起' : '导出 / 领取 / 我的提交'}</span></button>}
    {open && <>
      {surface!=='receive'&&<nav aria-label="美化分享">{surface!=='author'&&<button disabled={busy} aria-pressed={tab === 'receive'} onClick={() => onOpenReceiver ? onOpenReceiver() : setTab('receive')}>用码领取</button>}<button disabled={busy} aria-pressed={tab === 'submit'} onClick={() => setTab('submit')}>投稿获取分享码</button><button disabled={busy} aria-pressed={tab === 'mine'} onClick={() => { setTab('mine'); void run(() => refresh()); }}>我的提交</button></nav>}
      {error && <p role="alert" className="beauty-share-error">{error}</p>}{notice && <p role="status">{notice}</p>}
      <fieldset disabled={busy}>
        {tab === 'submit' && <div className="beauty-submit-flow" ref={flowRef} tabIndex={-1}>
          <ol className="beauty-submit-steps" aria-label="投稿进度"><li aria-current={!confirmedWork?'step':undefined}><span>{confirmedWork?'✓':'01'}</span>确认作品</li><li aria-current={confirmedWork?'step':undefined}><span>02</span>署名与规范</li></ol>
          <div className="beauty-submit-intro"><small>{editing?'更新作品':'分享你的创作'}</small><h3>{confirmedWork?'为这份美化，留下你的名字':`先看看，是这份${submissionKind==='appearance'?'桌面主题':'美化作品'}吗？`}</h3><p>{confirmedWork?'写好署名与使用规范，让收到它的人知道如何珍惜。':'确认预览和作品名称，再把它送到大家手中。'}</p></div>
          {!confirmedWork?<>
            {unified && source === 'file' && <label>投稿文件类型<select value={fileKind} onChange={e => setFileKind(e.target.value as BeautyKind)}><option value="appearance">桌面主题</option><option value="chat-decoration">聊天 / App 美化</option></select></label>}
            <BeautyPresetPicker kind={submissionKind} sources={sources} source={source} file={file} onPreview={setSubmissionPreview} onFile={setFile} onSource={id=>{setSource(id);setSubmissionPreview(null);const s=sources.find(s=>s.id===id);if(s&&!editing)field('name',s.name);}}/>
            <div className="beauty-submit-next"><p>这一步只确认作品，还不会上传。</p><button className="beauty-submit-primary" disabled={!submissionPreview} onClick={confirmWork}>就是这份，继续 <span aria-hidden="true">→</span></button></div>
          </>:<div className="beauty-confirmed-work"><div><small>已确认 · {confirmedWork.kind==='appearance'?'桌面主题':'美化作品'}</small><strong>{confirmedWork.name}</strong></div><button onClick={()=>{setConfirmedWork(null);setSubmissionPreview(null);}}>重新选择</button><BeautyShareContents pack={confirmedWork.pack} selection={confirmedWork.selection} onChange={selection=>setConfirmedWork({...confirmedWork,selection})}/><details><summary>再看一眼预览</summary><BeautyPresetPreview data={selectedWork}/></details></div>}
        </div>}
        {tab === 'receive' ? <>
          {unified && <p>桌面主题、气泡、头像框、白框等美化码都在这里领取，自动识别，无需选择分类。</p>}
          <label>美化码<input value={code} maxLength={20} placeholder="S-…" autoCapitalize="characters" onChange={e => { setCode(e.target.value); setShare(null); setAccepted(false); setPreviewPack(null); }}/></label>
          <button onClick={() => run(async () => {
            const normalized = code.trim().toUpperCase();
            if (!/^S-[A-F0-9]{12}$/.test(normalized)) throw Error('请输入完整的美化码（S- 开头）');
            setShare(null); setAccepted(false); setPreviewPack(null);
            const result = await beautyRequest<BeautyShare>(`/shares/${normalized}`);
            if (!unified && result.kind !== kind) throw Error(kind === 'appearance' ? '这是聊天装扮，请到外观 App 的统一用码领取入口领取' : '这是桌面主题，请到外观 App 的统一用码领取入口领取');
            setShare(result);
          })}>查看说明</button>
          {share && <><Terms metadata={share.metadata}/>{previewPack ? <BeautyPresetPreview data={previewPack}/> : <button onClick={() => run(async () => { setPreviewPack(await downloadBeauty(share, unified ? share.kind : kind)); })}>预览效果</button>}<label className="beauty-share-check"><input type="checkbox" checked={accepted} onChange={e => setAccepted(e.target.checked)}/>我已阅读作者的使用规范</label><button disabled={!accepted} onClick={() => run(async () => { const pack = await downloadBeauty(share, unified ? share.kind : kind); await onReceive(pack, share); trackBeauty('import','code'); setNotice(receivedMessage || (kind === 'appearance' ? '已存入外观预设，可在预设列表中选择应用。' : '已载入，请在装扮确认区选择需要应用的部分。')); })}>领取并载入预设</button></>}
        </> : (tab!=='submit'||confirmedWork) && <>
          {!session ? <div>
            <p>首次提交建立作者身份，当前浏览器会记住登录。换设备时，用作者码和密码恢复。</p>
            <div className="beauty-share-actions"><button aria-pressed={!loginMode} onClick={() => setLoginMode(false)}>首次使用</button><button aria-pressed={loginMode} onClick={() => setLoginMode(true)}>恢复作者身份</button></div>
            {loginMode && <label>作者码<input value={authorCode} maxLength={20} autoComplete="username" onChange={e => setAuthorCode(e.target.value)}/></label>}
            <label>密码（12–128 字符）<input type="password" value={password} minLength={12} maxLength={128} autoComplete={loginMode ? 'current-password' : 'new-password'} onChange={e => setPassword(e.target.value)}/></label>
            {!loginMode && <label>再次输入密码<input type="password" value={repeat} maxLength={128} autoComplete="new-password" onChange={e => setRepeat(e.target.value)}/></label>}
            <label className="beauty-share-check"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/>记住作者身份，随个人完整备份搬家（含密码，不进入美化分享文件）</label>
            <button onClick={authenticate}>{loginMode ? '登录' : '建立作者身份'}</button>
          </div> : <>
            <p>作者码：<strong className="beauty-share-code">{session.authorCode}</strong></p>
            <div className="beauty-share-actions"><button onClick={() => run(async () => { await shareOrDownloadFile({ content: `糯米机美化作者码：${session.authorCode}\n请另行妥善保存您设置的密码。恢复身份需要作者码和密码；本文件不是美化分享码。`, fileName: '糯米机-作者码.txt', mimeType: 'text/plain' }); })}>保存作者码</button><button onClick={() => run(async () => { await beautyRequest('/auth/logout', { method: 'POST', token: session.token }); saveBeautySession(null);forgetBeautyAuthor();setRemembered(null);setRemember(false);setPassword('');setAuthorCode(''); setSession(null); setSubmissions([]); setLoaded(false); setMustSave(false); })}>退出登录</button></div>
            <details className="beauty-author-backup"><summary>作者身份与搬家</summary>{remembered?.authorCode===session.authorCode?<><p>已记住作者身份。个人完整备份会携带作者码和密码，导入后可直接登录，原投稿绑定也会保留。</p><button onClick={()=>{forgetBeautyAuthor();setRemembered(null);setRemember(false);}}>不再随备份保存身份</button></>:<><p>首次开启请验证一次密码。仅写入本机及个人完整备份，不会出现在美化分享文件里。</p><label>验证作者密码<input type="password" maxLength={128} autoComplete="current-password" value={memoryPassword} onChange={e=>setMemoryPassword(e.target.value)}/></label><button onClick={()=>run(async()=>{validateBeautyPassword(memoryPassword);const next=await beautyRequest<BeautySession>('/auth/login',{method:'POST',body:{authorCode:session.authorCode,password:memoryPassword}});rememberBeautyAuthor(next.authorCode,memoryPassword);saveBeautySession(next);setSession(next);setRemembered(readRememberedBeautyAuthor());setMemoryPassword('');setNotice('已开启作者身份搬家');})}>验证并记住身份</button></>}</details>
            {mustSave && <label className="beauty-share-check"><input type="checkbox" checked={false} onChange={() => setMustSave(false)}/>我已妥善保存作者码和密码（清缓存或换设备后需要使用）</label>}
            {tab === 'submit' ? <>
              {editing && <><h3>更新：{editing.metadata.name}</h3><button onClick={() => { setEditing(null);setConfirmedWork(null);setSubmissionPreview(null); setMetadata(initialMetadata()); }}>取消更新，改为新投稿</button></>}
              <label>美化名<input value={metadata.name} maxLength={80} onChange={e => field('name', e.target.value)}/></label>
              <label>署名<input value={metadata.credit} maxLength={60} onChange={e => field('credit', e.target.value)}/></label>
              <p>发放平台（可多选，方便使用者找到作者 Repo）</p>{BEAUTY_PLATFORMS.map(p => <label className="beauty-share-check" key={p}><input type="checkbox" checked={metadata.platforms.includes(p)} onChange={e => field('platforms', e.target.checked ? [...metadata.platforms, p] : metadata.platforms.filter(v => v !== p))}/>{p}</label>)}
              <label>如何找到你（选填）<input value={metadata.contact} maxLength={160} placeholder="如群昵称或 DC 用户名" onChange={e => field('contact', e.target.value)}/></label>
              <label className="beauty-share-check"><input type="checkbox" checked={metadata.allowRemix} onChange={e => field('allowRemix', e.target.checked)}/>允许二改</label><label className="beauty-share-check"><input type="checkbox" checked={metadata.allowRedistribute} onChange={e => field('allowRedistribute', e.target.checked)}/>允许二次传播</label>
              <label className="beauty-share-check"><input type="checkbox" checked={metadata.allowPublicListing===true} onChange={e=>field('allowPublicListing',e.target.checked)}/>允许在装扮库公开展示（选填）</label>
              {metadata.allowPublicListing&&confirmedWork&&<BeautyCatalogConsent key={confirmedWork.source} pack={selectedWork} cover={catalogCover} onCover={setCatalogCover}/>}
              <p>糯米机版本：{APP_VERSION}（当前导出版本）</p>
              <label>Bug 反馈<select value={metadata.bugFeedback} onChange={e => field('bugFeedback', e.target.value as BeautyMetadata['bugFeedback'])}><option value="welcome">欢迎反馈</option><option value="self-fix">Bug 请自行修复处理</option></select></label>
              <label>作者留言<textarea rows={4} value={metadata.message} maxLength={2000} onChange={e => field('message', e.target.value)}/></label>
              <div className="beauty-submit-next"><p>人工审核通常需要 1–2 天，审核前仅你和管理员可见。{editing?'通过后才会替换原分享码的内容。':'通过后获得专属分享码。'}文件最多 20 MB。</p><button className="beauty-submit-primary" disabled={mustSave} onClick={submit}>送交审核 <span aria-hidden="true">→</span></button></div>
            </> : <>
              <div className="beauty-list-tools"><label>提交状态<select value={filter} onChange={e => { setFilter(e.target.value); void run(() => refresh(session, 0, e.target.value)); }}><option value="all">全部</option><option value="pending">人工审核中</option><option value="approved">已通过</option><option value="rejected">已退回</option></select></label><label>查找作品<input value={query} maxLength={80} placeholder="名称或美化码" onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); setAppliedQuery(query); void run(() => refresh(session, 0, filter, query)); } }}/></label></div>
              <div className="beauty-share-actions"><button onClick={() => { setAppliedQuery(query); void run(() => refresh(session, 0, filter, query)); }}>查找</button><button onClick={() => run(() => refresh())}>刷新状态</button><span className="beauty-list-count">共 {page.total} 份作品</span></div>
              <div className="beauty-share-actions"><button disabled={!submissions.some(item=>item.shareCode&&!item.pendingRevision)} onClick={()=>setSelectedTerms(current=>[...current,...submissions.filter(item=>item.shareCode&&!item.pendingRevision&&!current.some(x=>x.id===item.id))])}>选择本页可修改的作品</button><button disabled={!selectedTerms.length} onClick={()=>setTermsItems(selectedTerms)}>批量修改协议（{selectedTerms.length}）</button>{selectedTerms.length>0&&<button onClick={()=>setSelectedTerms([])}>清空选择</button>}</div>
              {loaded && !submissions.length && <p className="beauty-empty">{filter !== 'all' || appliedQuery ? '没有符合条件的提交，试试其他状态或名称。' : '还没有提交。点击「投稿获取分享码」分享你的第一份美化吧。'}</p>}
              {submissions.map(item => <article key={item.id}>{item.shareCode&&!item.pendingRevision&&<label className="beauty-share-check"><input type="checkbox" checked={selectedTerms.some(x=>x.id===item.id)} onChange={e=>setSelectedTerms(current=>e.target.checked?[...current.filter(x=>x.id!==item.id),item]:current.filter(x=>x.id!==item.id))}/>选择修改协议</label>}<strong>{item.metadata.name}</strong><p className="beauty-item-meta">{item.kind === 'appearance' ? '桌面主题' : '美化预设'} <span className={`beauty-status is-${item.status}`}>{item.status === 'pending' ? '人工审核中' : item.status === 'approved' ? '审核通过' : '已退回'}</span></p>{item.status === 'pending' && <p className="beauty-share-message">人工审核通常需要 1–2 天，请耐心等待。</p>}{item.reviewNote && <p className="beauty-share-message">审核说明：{item.reviewNote}</p>}{item.shareCode && <><p className="beauty-share-code">{item.shareCode}</p>{item.status !== 'approved' && <p>分享码仍提供上次审核通过的版本。</p>}<button onClick={() => run(async () => { await shareOrDownloadFile({ content: `${item.shareCode}\n在糯米机「聊天装扮」或「外观装扮」的「导入装扮 → 用码领取」输入此码，自动识别美化类型。`, fileName: '美化分享码.txt', mimeType: 'text/plain' }); })}>分享码保存为文件</button><button onClick={() => run(async () => { await navigator.clipboard.writeText(item.shareCode!); setNotice('美化码已复制'); })}>复制美化码</button></>}
                <div className="beauty-share-actions">{item.shareCode && <button onClick={() => run(async () => { const { openBeautyPoster } = await import('./BeautyPosterDialog'); await openBeautyPoster(item.shareCode!); })}>分享预览图</button>}<button disabled={!!item.pendingRevision || (!unified && item.kind !== kind)} onClick={() => { setEditing(item);setConfirmedWork(null);setSubmissionPreview(null); if (unified) { setFileKind(item.kind); setSource(sources.find(s => s.kind === item.kind)?.id || 'file'); setFile(null); } setMetadata({ ...item.metadata, allowPublicListing:!item.catalogHidden&&item.metadata.allowPublicListing===true, exportVersion: APP_VERSION }); setTab('submit'); }}>选择文件更新</button><button disabled={!!item.pendingRevision} onClick={()=>checkOriginal(item)}>一键更新</button>{item.shareCode&&<button disabled={!!item.pendingRevision} onClick={()=>setTermsItems([item])}>修改协议</button>}{!item.catalogHidden&&(item.catalogPublic||item.metadata.allowPublicListing)&&<button onClick={()=>run(async()=>{await beautyRequest(`/submissions/${item.id}/hide-catalog`,{method:'POST',token:session.token});await refresh();setNotice('已取消公开展示。静态目录与缓存会稍后更新，已下载副本无法收回；原分享码仍可使用。');})}>取消公开展示</button>}<button onClick={() => setDeleteId(item.id)}>删除</button></div>{!unified && item.kind !== kind && <p>请到{item.kind === 'appearance' ? '桌面主题' : '美化预设'}更新此作品。</p>}
              {deleteId === item.id && <div className="beauty-delete-confirm"><p>删除「{item.metadata.name}」？分享码立即失效，已下载的副本无法收回。</p><button onClick={() => run(async () => { await beautyRequest(`/submissions/${item.id}`, { method: 'DELETE', token: session.token }); if (editing?.id === item.id) setEditing(null); await refresh(); setNotice('已删除该作品。'); })}>确认删除</button><button onClick={() => setDeleteId(null)}>取消</button></div>}</article>)}
              {page.total > 0 && <div className="beauty-pagination" aria-label="我的提交分页"><button disabled={!page.offset} onClick={() => run(() => refresh(session, Math.max(0, page.offset - page.pageSize)))}>上一页</button><span>第 {Math.floor(page.offset / page.pageSize) + 1} / {Math.max(1, Math.ceil(page.total / page.pageSize))} 页</span><button disabled={page.nextOffset === null} onClick={() => run(() => refresh(session, page.nextOffset!))}>下一页</button></div>}
            </>}
          </>}
        </>}
      </fieldset>
      {busy && <p role="status">处理中，请稍候…</p>}
    </>}
    {termsItems&&session&&<BeautyTermsEditor items={termsItems} session={session} onClose={()=>setTermsItems(null)} onDone={async()=>{setSelectedTerms([]);await refresh();}}/>}
    {updateCandidate&&<BeautyConfirmDialog title="提交新版装扮" confirm="提交审核" onClose={()=>setUpdateCandidate(null)} onConfirm={async()=>{
      if(!session)throw Error('请重新登录作者身份');
      const candidate=updateCandidate;
      const pack=normalizeBeautyPackage(selectedCandidate,candidate.item.kind);
      const fingerprint=await beautyFingerprint(pack,candidate.item.kind);
      await candidate.source.beforeSubmit?.();
      if(!(await confirmExportSafety(pack)))throw Error('尚未确认文件分享');
      const result=await beautyRequest<{id:string;revision:string}>(`/submissions/${candidate.item.id}`,{method:'POST',token:session.token,body:{metadata:{...candidate.item.metadata,allowPublicListing:!candidate.item.catalogHidden&&candidate.item.metadata.allowPublicListing===true,exportVersion:APP_VERSION},...(!candidate.item.catalogHidden&&candidate.item.metadata.allowPublicListing?{catalogCover:validateCatalogCover(candidateCover)}:{}),package:pack,expectedRevision:candidate.item.latestRevision}});
      trackBeauty('submit','revision');
      // A submitted snapshot, not a later edit, becomes the comparison baseline.
      try{await bindBeautySource(session.authorCode,candidate.item.id,{sourceId:candidate.source.bindingId!,kind:candidate.item.kind,fingerprint,revision:result.revision,selection:candidate.selection});}catch{setError('新版已提交，但本机关联未保存，请勿重复提交。');}
      setNotice('新版已送交人工审核，通常需要 1–2 天。通过后原分享码将提供新版，审核期间继续提供已通过的版本。');
      setUpdateCandidate(null);
      try{await refresh();}catch{setError('提交成功，状态刷新失败，请手动刷新。');}
    }}><p>检测到您的原始装扮已经更新，是否提交？</p><p>「{updateCandidate.source.name}」</p><BeautyShareContents pack={updateCandidate.pack} selection={updateCandidate.selection} onChange={selection=>setUpdateCandidate({...updateCandidate,selection})}/><p>沿用原投稿的署名和使用规范。需要修改说明时，请使用「选择文件更新」。</p>{!updateCandidate.item.catalogHidden&&updateCandidate.item.metadata.allowPublicListing&&<BeautyCatalogConsent pack={selectedCandidate} cover={candidateCover} onCover={setCandidateCover}/>}<details><summary>查看本次更新预览</summary><BeautyPresetPreview data={selectedCandidate}/></details></BeautyConfirmDialog>}
  </section>;
}
