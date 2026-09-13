import { trackSARFeature } from '../../utils/sarAnalytics';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArrowLeft, ArrowDown, ArrowUp, BookOpenText, CircleNotch, DotsThree, DownloadSimple, Moon, SealCheck, ShareNetwork, Sun, X } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile, Message, UserProfile } from '../../types';
import './sarReading.css';
import { findSARPendingReply, isSARDeletedReply, replaceSARSimulationReply } from '../../utils/vrWorld/sarSimulationEdits';
import { shareOrDownloadBlob } from '../../utils/shareExport';
import {
    archiveSARSimulationRun,
    buildSARArchiveMarkdown,
    getSARArchiveFilename,
    getSARSimulationPhase,
    getSARWorldNarration,
    loadSARSimulationMessages,
    resolveSARWorldlineProfile,
    runSARSimulationTurn,
    shareSARArchiveWithCharacter,
    type SARIdentityCard,
    type SARSimulationRun,
} from '../../utils/vrWorld/sarSimulation';

export const SAR_SESSION_THEME_KEY = 'vr_sar_session_theme_v1';
export type SARSessionTheme = 'light' | 'dark';

export const readSARSessionTheme = (): SARSessionTheme => {
    try { return localStorage.getItem(SAR_SESSION_THEME_KEY) === 'dark' ? 'dark' : 'light'; }
    catch { return 'light'; }
};

const messageScene = (message: Message) => `第 ${Number(message.metadata?.sarTurn) || 0} 幕`;

export const SARSimulationSession: React.FC<{
    card: SARIdentityCard;
    run: SARSimulationRun;
    char?: CharacterProfile;
    apiConfig: APIConfig;
    userProfile: UserProfile;
    onRunChange: (run: SARSimulationRun) => void;
    onThemeChange?: (theme: SARSessionTheme) => void;
    onBack: () => void;
}> = ({ card, run, char, apiConfig, userProfile, onRunChange, onThemeChange, onBack }) => {
    useEffect(() => { trackSARFeature('simulation'); }, []);
    const [messages, setMessages] = useState<Message[]>([]);
    const [draft, setDraft] = useState('');
    const [replyAction, setReplyAction] = useState<{ message: Message; mode: 'menu' | 'edit' | 'delete' } | null>(null);
    const [editText, setEditText] = useState('');
    const [editNarration, setEditNarration] = useState('');
    const busyRef = useRef(false);
    const pendingReply = findSARPendingReply(messages);
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const [pendingText, setPendingText] = useState('');
    const [streamText, setStreamText] = useState('');
    const [page, setPage] = useState<'story' | 'details'>('story');
    const [hasNewText, setHasNewText] = useState(false);
    const followEndRef = useRef(true);
    const [error, setError] = useState('');
    const [archiveConfirm, setArchiveConfirm] = useState(false);
    const [theme, setTheme] = useState<SARSessionTheme>(readSARSessionTheme);
    const [archiveAction, setArchiveAction] = useState('');
    const [sharing, setSharing] = useState(false);
    const logRef = useRef<HTMLDivElement>(null);
    const draftRef = useRef<HTMLTextAreaElement>(null);
    const textStateRef = useRef('');
    const active = run.status === 'active' && run.interactionsUsed < run.maxInteractions;

    const worldline = useMemo(() => resolveSARWorldlineProfile(card), [card]);
    const phase = useMemo(() => getSARSimulationPhase(run.interactionsUsed), [run.interactionsUsed]);

    useLayoutEffect(() => {
        const input = draftRef.current;
        if (!input || page !== 'story') return;
        const fit = () => {
            input.style.height = 'auto';
            const limit = Math.max(44, parseFloat(getComputedStyle(input).maxHeight) || 136);
            input.style.height = `${Math.min(input.scrollHeight, limit)}px`;
            input.style.overflowY = 'auto';
        };
        fit();
        let width = input.clientWidth;
        const observer = new ResizeObserver(() => {
            if (input.clientWidth !== width) { width = input.clientWidth; fit(); }
        });
        observer.observe(input);
        return () => observer.disconnect();
    }, [draft, page, active]);

    textStateRef.current = JSON.stringify({
        app: 'sar-simulation',
        identity: card.profile.title,
        character: card.charName,
        world: worldline.worldName,
        storyPhase: phase.label,
        page,
        activeCrisis: worldline.activeCrisis,
        sharedObjective: worldline.sharedObjective,
        countdown: worldline.countdown,
        status: run.status,
        archiveReason: run.archiveReason || null,
        progress: { used: run.interactionsUsed, max: run.maxInteractions },
        interactionMode: 'offline',
        readingTheme: theme,
        sending,
        archiveConfirm,
        archiveActions: active ? [] : ['reread', 'download', run.sharedAt ? 'shared' : 'share-to-character'],
        visibleMessages: messages.slice(-4).map(message => ({ role: message.role, scene: messageScene(message), worldNarration: getSARWorldNarration(message).slice(0, 140) || null, text: message.content.slice(0, 180) })),
        input: { enabled: active && Boolean(char) && !sending, draftLength: draft.length },
    });

    useEffect(() => {
        const target = window as Window & { render_game_to_text?: () => string; advanceTime?: (ms: number) => void };
        const previous = target.render_game_to_text;
        const previousAdvance = target.advanceTime;
        const renderState = () => textStateRef.current;
        target.render_game_to_text = renderState;
        target.advanceTime = () => undefined;
        return () => {
            if (target.render_game_to_text === renderState) {
                if (previous) target.render_game_to_text = previous;
                else delete target.render_game_to_text;
            }
            target.advanceTime = previousAdvance;
        };
    }, []);

    useEffect(() => {
        try { localStorage.setItem(SAR_SESSION_THEME_KEY, theme); } catch { /* 主题持久化失败不影响阅读。 */ }
        onThemeChange?.(theme);
    }, [theme, onThemeChange]);

    useEffect(() => {
        let live = true;
        setLoading(true);
        loadSARSimulationMessages(run.id)
            .then(items => { if (live) setMessages(items); })
            .catch(cause => { if (live) setError(cause?.message || '推演记录读取失败'); })
            .finally(() => { if (live) setLoading(false); });
        return () => { live = false; };
    }, [run.id]);

    useEffect(() => {
        const node = logRef.current;
        if (!node) return;
        if (followEndRef.current) { node.scrollTop = node.scrollHeight; setHasNewText(false); }
        else setHasNewText(true);
    }, [messages, pendingText, streamText, sending]);

    useEffect(() => {
        if (active || loading) return;
        const node = logRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, [active, loading, messages.length, run.id]);

    const send = async (retryReplyId?: number) => {
        const retryId = retryReplyId ?? pendingReply?.id;
        const text = retryId !== undefined ? '' : draft.trim();
        if ((!text && retryId === undefined) || !char || (!active && retryId === undefined) || busyRef.current) return;
        busyRef.current = true;
        setReplyAction(null);
        followEndRef.current = true;
        setSending(true);
        setError('');
        setPendingText(text);
        setStreamText('');
        if (retryId === undefined) setDraft('');
        try {
            const result = await runSARSimulationTurn({
                card,
                run,
                char,
                apiConfig,
                userProfile,
                userText: text,
                retryReplyId: retryId,
                onDelta: setStreamText,
            });
            setMessages(result.messages);
            onRunChange(result.run);
        } catch (cause: any) {
            setError(cause?.message || '本轮推演中断，没有消耗互动次数');
            if (retryId === undefined) setDraft(text);
        } finally {
            setPendingText('');
            setStreamText('');
            setSending(false);
            busyRef.current = false;
        }
    };

    const saveReply = async (deleted = false) => {
        if (!replyAction || busyRef.current || (!deleted && !editText.trim())) return;
        busyRef.current = true; setSending(true); setError('');
        try {
            await replaceSARSimulationReply(run.id, replyAction.message, { content: editText.trim(), worldNarration: editNarration.trim(), deleted });
            setMessages(await loadSARSimulationMessages(run.id));
            setReplyAction(null);
            setArchiveAction(deleted ? '回复已删除，可从这一幕重新生成' : '修改已保存');
        } catch (cause: any) { setError(cause?.message || '保存失败，原文未改动'); }
        finally { busyRef.current = false; setSending(false); }
    };
    const copyReply = async (message: Message) => {
        try {
            await navigator.clipboard.writeText([getSARWorldNarration(message), message.content].filter(Boolean).join('\n\n'));
            setArchiveAction('已复制这条回复'); setReplyAction(null);
        } catch { setError('复制失败，请检查剪贴板权限'); }
    };

    const archive = () => {
        try {
            const archived = archiveSARSimulationRun(run.id);
            onRunChange(archived);
            setArchiveConfirm(false);
        } catch (cause: any) {
            setError(cause?.message || '紧急封存失败');
        }
    };

    const reread = () => {
        followEndRef.current = false;
        logRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
        setArchiveAction('已回到档案开头');
    };

    const downloadArchive = async () => {
        try {
            const text = buildSARArchiveMarkdown(card, run, messages, userProfile.name);
            const result = await shareOrDownloadBlob({
                blob: new Blob([text], { type: 'text/markdown;charset=utf-8' }),
                fileName: getSARArchiveFilename(card, run),
                shareTitle: `${card.profile.title} · SAR 封存档案`,
                preferDownloadOnWeb: true,
            });
            setArchiveAction(result === 'shared' ? '已打开系统文件保存/分享' : result === 'downloaded' ? '完整档案已下载' : '已取消导出');
        } catch (cause: any) {
            setError(cause?.message || '档案下载失败');
        }
    };

    const shareToCharacter = async () => {
        if (sharing || run.sharedAt) return;
        setSharing(true);
        setError('');
        try {
            const updated = await shareSARArchiveWithCharacter({ card, run, messages, userName: userProfile.name });
            onRunChange(updated);
            setArchiveAction(`返航简报已分享给${card.charName}`);
        } catch (cause: any) {
            setError(cause?.message || '返航简报分享失败');
        } finally {
            setSharing(false);
        }
    };


    const latest = () => { followEndRef.current = true; logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }); setHasNewText(false); };
    return (
        <main className={`sars-session is-${theme}`}>
            <header className="sars-reader-header">
                <button type="button" disabled={page==='story'&&sending} aria-label={page==='details'?'返回故事':'返回身份卡'} onClick={page==='details'?()=>setPage('story'):onBack}><ArrowLeft size={21}/></button>
                <div><h1>{page==='details'?'演绎资料':card.profile.title}</h1><p>{worldline.worldName} · {card.charName}</p></div>
                {page==='story'&&<button type="button" aria-label="演绎资料与设置" onClick={()=>setPage('details')}><DotsThree size={25} weight="bold"/></button>}
            </header>
            <div className="sars-reader-body" hidden={page!=='story'}>
                <div className="sars-log" ref={logRef} onScroll={()=>{const el=logRef.current;if(el){followEndRef.current=el.scrollHeight-el.scrollTop-el.clientHeight<72;if(followEndRef.current)setHasNewText(false);}}}>
                    <div className="sars-reading-column">
                        <p className="sars-opening-label">故事从这里开始</p>
                        <article className="sars-narration"><p>{card.profile.openingScene}</p></article>
                        <article className="sars-message is-assistant"><header>{card.charName}</header><p>{card.profile.openingLine}</p></article>
                        {loading?<div className="sars-loading"><CircleNotch size={17} className="animate-spin"/>正在翻开故事……</div>:messages.map(message=>isSARDeletedReply(message)
                            ? <div key={message.id} className="sars-deleted-reply"><span>{messageScene(message)} · 回复已删除</span><button type="button" disabled={sending||!char} onClick={()=>void send(message.id)}>生成这一幕</button></div>
                            : <React.Fragment key={message.id}>
                            {message.role==='assistant'&&getSARWorldNarration(message)&&<article className="sars-narration" aria-label="世界旁白"><p>{getSARWorldNarration(message)}</p></article>}
                            <article className={`sars-message is-${message.role}`} data-sar-message-id={message.id}><header>{message.role==='user'?userProfile.name:card.charName}<span>{messageScene(message)}</span>{message.role==='assistant'&&<button type="button" className="sars-reply-menu" aria-label={messageScene(message)+'回复操作'} disabled={sending} onClick={()=>setReplyAction({message,mode:'menu'})}><DotsThree size={19}/></button>}</header><p>{message.content}</p></article>
                        </React.Fragment>)}
                        {pendingText&&<article className="sars-message is-user is-pending"><header>{userProfile.name}</header><p>{pendingText}</p></article>}
                        {sending&&<div className="sars-loading" role="status"><CircleNotch size={16} className="animate-spin"/>{streamText||'正在接续这一刻……'}</div>}
                        {!active&&!pendingReply&&<section className="sars-sealed">
                            <SealCheck size={28} weight="light"/><h2>{run.archiveReason==='completed'?'这一段故事，已收好':'故事暂存于此'}</h2>
                            <p>{run.archiveReason==='completed'?'这段共同经历已经结束，原文留在这里，随时可以回来。':`保留到第 ${run.interactionsUsed} 次互动。封存后可以阅读和导出，当前无法直接续写。`}</p>
                            <div className="sars-archive-actions"><button type="button" onClick={reread}><BookOpenText size={17}/>从头重读</button><button type="button" onClick={()=>void downloadArchive()}><DownloadSimple size={17}/>保存全文</button><button type="button" disabled={sharing||!!run.sharedAt} onClick={()=>void shareToCharacter()}><ShareNetwork size={17}/>{run.sharedAt?'已分享':sharing?'正在分享…':`分享给${card.charName}`}</button></div>
                            {archiveAction&&<output role="status">{archiveAction}</output>}
                        </section>}
                    </div>
                </div>
                <footer className="sars-composer">
                    {hasNewText&&<button type="button" className="sars-new-text" onClick={latest}><ArrowDown size={14}/>回到最新内容</button>}
                    {error&&<p role="alert" className="sars-error">{error}</p>}
                    {archiveAction&&<output className="sars-action-status" role="status">{archiveAction}</output>}
                    {pendingReply&&<p className="sars-action-status">{messageScene(pendingReply)}等待重新生成，沿用当时的输入。</p>}
                    {active||pendingReply?<div className="sars-compose-row">
                        <textarea ref={draftRef} rows={1} aria-label="你说的话或动作" value={draft} maxLength={4000} disabled={sending||!char||!!pendingReply} placeholder={pendingReply?'点击生成，重试已删除的回复':char?'说些什么，或做个动作…':'角色资料已不存在，无法继续'} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void send();}}}/>
                        <button type="button" aria-label={pendingReply?'生成':'发送'} disabled={(!draft.trim()&&!pendingReply)||sending||!char} onClick={()=>void send()}>{sending?<CircleNotch size={19} className="animate-spin"/>:<ArrowUp size={21} weight="bold"/>}</button>
                    </div>:<div className="sars-readonly">已封存 · {run.interactionsUsed} 次互动</div>}
                </footer>
            </div>
            {page==='details'&&<section className="sars-details">
                <div className="sars-reading-column">
                    <div className="sars-progress"><span>本段互动</span><strong>{run.interactionsUsed}<small> / {run.maxInteractions}</small></strong></div>
                    <p className="sars-detail-note">{active?'每次发送成功后记一次。离开页面可以稍后继续；这段经历将在五十次互动内自然收束。':'本段故事已封存，可以回看、保存全文或分享给角色。'}</p>
                    <button type="button" className="sars-setting-row" onClick={()=>setTheme(value=>value==='light'?'dark':'light')} aria-label={theme==='light'?'切换到深色阅读':'切换到浅色阅读'}><span>{theme==='light'?<Moon size={18}/>:<Sun size={18}/>}阅读外观</span><span>{theme==='light'?'浅色':'深色'}</span></button>
                    <details><summary>世界与开场</summary><h3>{worldline.worldName}</h3><p>{worldline.worldPremise}</p><h3>开场时的状况</h3><p>{worldline.activeCrisis}</p><h3>角色起初关心的事</h3><p>{worldline.sharedObjective}</p><h3>故事里的时间</h3><p>{worldline.countdown}</p><small>这里是身份卡中的开场资料，后续变化以正文为准。</small></details>
                    <details><summary>角色与这次身份</summary><h3>{card.charName}</h3><p>{card.profile.identity}</p><h3>与你的关系</h3><p>{card.profile.relationship}</p></details>
                    {active&&<div className="sars-end-section"><button type="button" disabled={sending} onClick={()=>setArchiveConfirm(true)}><Archive size={17}/>提前封存</button><p>如果只是稍后再玩，直接返回即可。提前封存会结束这段演绎。</p></div>}
                    {error&&<p role="alert" className="sars-error">{error}</p>}
                </div>
            </section>}
            {replyAction&&<div className="sars-confirm" role="dialog" aria-modal="true" aria-label="回复操作"><section>
                <button type="button" className="sars-confirm-close" aria-label="关闭回复操作" disabled={sending} onClick={()=>setReplyAction(null)}><X size={18}/></button>
                <h2>{messageScene(replyAction.message)} · {replyAction.mode==='edit'?'修改回复':replyAction.mode==='delete'?'删除回复？':'回复操作'}</h2>
                {replyAction.mode==='menu'?<div className="sars-reply-actions">
                    <button type="button" onClick={()=>void copyReply(replyAction.message)}>复制</button>
                    <button type="button" onClick={()=>{setEditText(replyAction.message.content);setEditNarration(getSARWorldNarration(replyAction.message));setReplyAction({...replyAction,mode:'edit'});}}>修改</button>
                    <button type="button" disabled={!char} onClick={()=>void send(replyAction.message.id)}>重新生成</button>
                    <button type="button" onClick={()=>setReplyAction({...replyAction,mode:'delete'})}>删除</button>
                </div>:replyAction.mode==='edit'?<>
                    <label className="sars-edit-label">世界旁白<textarea aria-label="修改世界旁白" value={editNarration} maxLength={2400} disabled={sending} onChange={e=>setEditNarration(e.target.value)}/></label>
                    <label className="sars-edit-label">角色回复<textarea aria-label="修改角色回复" value={editText} maxLength={12000} disabled={sending} onChange={e=>setEditText(e.target.value)}/></label>
                    <p>后续已有剧情不会自动改写。</p><button type="button" className="sars-reply-submit" disabled={sending||!editText.trim()} onClick={()=>void saveReply()}>保存修改</button>
                </>:<><p>删除这一幕的回复与旁白，保留你的输入。之后点生成会重试这一幕，后续已有剧情保留。</p><button type="button" className="sars-reply-submit" disabled={sending} onClick={()=>void saveReply(true)}>确认删除回复</button></>}
                {error&&<p role="alert" className="sars-error">{error}</p>}
            </section></div>}
            {archiveConfirm&&<div className="sars-confirm" role="alertdialog" aria-modal="true" aria-label="确认提前封存"><section><button type="button" className="sars-confirm-close" aria-label="取消封存" onClick={()=>setArchiveConfirm(false)}><X size={18}/></button><h2>把故事收在这里？</h2><p>已完成 {run.interactionsUsed} 次互动。原文会完整保留，封存后当前无法直接续写。</p><div><button type="button" onClick={()=>setArchiveConfirm(false)}>继续演绎</button><button type="button" onClick={()=>{archive();setPage('story');}}>确认封存</button></div></section></div>}
        </main>
    );
};
