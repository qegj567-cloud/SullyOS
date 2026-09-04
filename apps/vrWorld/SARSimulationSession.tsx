import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, BookOpenText, CircleNotch, Compass, DownloadSimple, Moon, PaperPlaneRight, SealCheck, SealWarning, ShareNetwork, Sun, WifiHigh, X } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile, Message, UserProfile } from '../../types';
import TokenImg from '../../components/os/TokenImg';
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
    type SARInteractionMode,
    type SARSimulationRun,
} from '../../utils/vrWorld/sarSimulation';

export const SAR_SESSION_THEME_KEY = 'vr_sar_session_theme_v1';
export type SARSessionTheme = 'light' | 'dark';

export const readSARSessionTheme = (): SARSessionTheme => {
    try { return localStorage.getItem(SAR_SESSION_THEME_KEY) === 'dark' ? 'dark' : 'light'; }
    catch { return 'light'; }
};

const modeCopy: Record<SARInteractionMode, { label: string; note: string }> = {
    online: { label: '线上', note: '文字联系' },
    offline: { label: '线下', note: '同场相处' },
};

const messageMode = (message: Message): SARInteractionMode => message.metadata?.sarMode === 'offline' ? 'offline' : 'online';

export const SARSimulationSession: React.FC<{
    card: SARIdentityCard;
    run: SARSimulationRun;
    char?: CharacterProfile;
    apiConfig: APIConfig;
    userProfile: UserProfile;
    onRunChange: (run: SARSimulationRun) => void;
    onThemeChange?: (theme: SARSessionTheme) => void;
}> = ({ card, run, char, apiConfig, userProfile, onRunChange, onThemeChange }) => {
    const [messages, setMessages] = useState<Message[]>([]);
    const [mode, setMode] = useState<SARInteractionMode>('offline');
    const [draft, setDraft] = useState('');
    const [loading, setLoading] = useState(true);
    const [sending, setSending] = useState(false);
    const [pendingText, setPendingText] = useState('');
    const [streamText, setStreamText] = useState('');
    const [error, setError] = useState('');
    const [archiveConfirm, setArchiveConfirm] = useState(false);
    const [theme, setTheme] = useState<SARSessionTheme>(readSARSessionTheme);
    const [archiveAction, setArchiveAction] = useState('');
    const [sharing, setSharing] = useState(false);
    const logRef = useRef<HTMLDivElement>(null);
    const textStateRef = useRef('');
    const active = run.status === 'active' && run.interactionsUsed < run.maxInteractions;

    const progress = useMemo(() => Array.from({ length: run.maxInteractions }, (_, index) => index < run.interactionsUsed), [run.interactionsUsed, run.maxInteractions]);
    const worldline = useMemo(() => resolveSARWorldlineProfile(card), [card]);
    const phase = useMemo(() => getSARSimulationPhase(run.interactionsUsed), [run.interactionsUsed]);

    textStateRef.current = JSON.stringify({
        app: 'sar-simulation',
        identity: card.profile.title,
        character: card.charName,
        world: worldline.worldName,
        storyPhase: phase.label,
        activeCrisis: worldline.activeCrisis,
        sharedObjective: worldline.sharedObjective,
        countdown: worldline.countdown,
        status: run.status,
        archiveReason: run.archiveReason || null,
        progress: { used: run.interactionsUsed, max: run.maxInteractions },
        interactionMode: mode,
        readingTheme: theme,
        sending,
        archiveConfirm,
        archiveActions: active ? [] : ['reread', 'download', run.sharedAt ? 'shared' : 'share-to-character'],
        visibleMessages: messages.slice(-4).map(message => ({ role: message.role, mode: messageMode(message), worldNarration: getSARWorldNarration(message).slice(0, 140) || null, text: message.content.slice(0, 180) })),
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
        if (node) node.scrollTop = node.scrollHeight;
    }, [messages, pendingText, streamText, sending]);

    useEffect(() => {
        if (active || loading) return;
        const timer = window.setTimeout(() => {
            const node = logRef.current;
            if (node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
        }, 520);
        return () => window.clearTimeout(timer);
    }, [active, loading, messages.length, run.id]);

    const send = async () => {
        const text = draft.trim();
        if (!text || !char || !active || sending) return;
        setSending(true);
        setError('');
        setPendingText(text);
        setStreamText('');
        setDraft('');
        try {
            const result = await runSARSimulationTurn({
                card,
                run,
                char,
                apiConfig,
                userProfile,
                mode,
                userText: text,
                onDelta: setStreamText,
            });
            setMessages(result.messages);
            onRunChange(result.run);
        } catch (cause: any) {
            setError(cause?.message || '本轮推演中断，没有消耗互动次数');
            setDraft(text);
        } finally {
            setPendingText('');
            setStreamText('');
            setSending(false);
        }
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

    return (
        <main className={`sars-session is-${theme}`}>
            <SARSessionStyle />
            <section className="sars-console-head">
                <div className="sars-topline">
                    <div className="sars-subject">
                        <div className="sars-subject__portrait">
                            {card.charAvatar ? <TokenImg value={card.charAvatar} alt={card.charName} /> : card.charName.slice(0, 1)}
                            <i />
                        </div>
                        <div><small>ACTIVE VARIANT / {card.charName}</small><h2>{card.profile.title}</h2></div>
                    </div>
                    <button type="button" className="sars-theme" aria-label={theme === 'light' ? '切换到深色阅读' : '切换到浅色阅读'} onClick={() => setTheme(value => value === 'light' ? 'dark' : 'light')}>
                        {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
                        <span>{theme === 'light' ? '深色' : '浅色'}</span>
                    </button>
                </div>
                <section className="sars-crisis">
                    <header><small>DIFFERENT COORDINATE · {worldline.worldName}</small><b>{phase.label}</b></header>
                    <p>{worldline.activeCrisis}</p>
                    <div><span><i>目标</i>{worldline.sharedObjective}</span><span><i>倒计时</i>{worldline.countdown}</span></div>
                </section>
                <div className="sars-life">
                    <div><span>{run.status === 'active' ? `世界线推进中 · ${phase.label}` : run.archiveReason === 'completed' ? '异世界结局完成 · 已封存' : '紧急封存 · 只读存档'}</span><b>{run.interactionsUsed}<i>/</i>{run.maxInteractions}</b></div>
                    <div className="sars-life__ticks" aria-label={`已完成 ${run.interactionsUsed} 次，共 ${run.maxInteractions} 次`}>
                        {progress.map((filled, index) => <i key={index} className={filled ? 'is-used' : ''} />)}
                    </div>
                </div>
                <div className="sars-mode-row">
                    <div className="sars-mode-switch" aria-label="交互方式">
                        {(Object.keys(modeCopy) as SARInteractionMode[]).map(value => (
                            <button type="button" key={value} className={mode === value ? 'is-active' : ''} disabled={!active || sending} onClick={() => setMode(value)}>
                                {value === 'online' ? <WifiHigh size={12} /> : <span className="sars-mode-dot" />}
                                <b>{modeCopy[value].label}</b><small>{modeCopy[value].note}</small>
                            </button>
                        ))}
                    </div>
                    {active && <button type="button" className="sars-archive-button" disabled={sending} onClick={() => setArchiveConfirm(true)}><Archive size={13} /> 紧急封存</button>}
                </div>
            </section>

            <div className="sars-log" ref={logRef}>
                <article className="sars-gm sars-gm--prologue">
                    <header><span><Compass size={13} weight="duotone" /> 世界意志</span><i>SCENE 00 · 投放完成</i></header>
                    <p>{card.profile.openingScene}</p>
                </article>
                <article className="sars-message is-assistant sars-opening-line"><header><span>{card.charName}</span><i>第 0 幕</i></header><p>{card.profile.openingLine}</p></article>

                {loading ? <div className="sars-loading"><CircleNotch className="animate-spin" size={17} /> 正在调取演算记录</div> : messages.map(message => <React.Fragment key={message.id}>
                    {message.role === 'assistant' && getSARWorldNarration(message) && <article className="sars-gm">
                        <header><span><Compass size={13} weight="duotone" /> 世界意志</span><i>{modeCopy[messageMode(message)].label} · {String(message.metadata?.sarTurn || '').padStart(2, '0')}</i></header>
                        <p>{getSARWorldNarration(message)}</p>
                    </article>}
                    <article className={`sars-message is-${message.role}`}>
                        <header><span>{message.role === 'user' ? userProfile.name : card.charName}</span><i>{modeCopy[messageMode(message)].label} · {String(message.metadata?.sarTurn || '').padStart(2, '0')}</i></header>
                        <p>{message.content}</p>
                    </article>
                </React.Fragment>)}

                {pendingText && <article className="sars-message is-user is-pending"><header><span>{userProfile.name}</span><i>{modeCopy[mode].label} · {(run.interactionsUsed + 1).toString().padStart(2, '0')}</i></header><p>{pendingText}</p></article>}
                {sending && <><article className="sars-gm is-generating"><header><span><Compass size={13} weight="duotone" /> 世界意志</span><i>WORLD IN MOTION</i></header><div><i /><i /><i /><span>场景、倒计时与返航航线正在变化</span></div></article><article className="sars-message is-assistant is-generating"><header><span>{card.charName}</span><i>等待演出</i></header>{streamText ? <p>{streamText}</p> : <div><i /><i /><i /><span>角色正在作出回应</span></div>}</article></>}

                {!active && <section className={`sars-sealed is-${run.archiveReason || 'emergency'}`}>
                    <div className="sars-seal-mark"><i /><i />{run.archiveReason === 'completed' ? <SealCheck size={34} weight="thin" /> : <SealWarning size={34} weight="thin" />}</div>
                    <small>{run.archiveReason === 'completed' ? 'RETURN CONFIRMED · ARCHIVE SEALED' : 'EMERGENCY RECOVERY · ARCHIVE SEALED'}</small>
                    <h3>{run.archiveReason === 'completed' ? '坐标关闭，你已返回现实' : '世界意志已收束这条坐标'}</h3>
                    <p>{run.archiveReason === 'completed' ? '五十轮故事已经完整落定。异界身份随坐标封存，现实关系不会被自动改写。' : `这条世界线停在 ${run.interactionsUsed}/50。现有记录完整保留，之后可使用凯恩提供的重启模块。`}</p>
                    <div className="sars-archive-actions">
                        <button type="button" onClick={reread}><BookOpenText size={16} /><span>重读全卷<small>从第 0 幕开始</small></span></button>
                        <button type="button" onClick={() => void downloadArchive()}><DownloadSimple size={16} /><span>下载档案<small>完整 Markdown</small></span></button>
                        <button type="button" disabled={sharing || Boolean(run.sharedAt)} onClick={() => void shareToCharacter()}><ShareNetwork size={16} /><span>{run.sharedAt ? '已经分享' : sharing ? '正在投递' : `分享给${card.charName}`}<small>发送返航简报</small></span></button>
                    </div>
                    {archiveAction && <output>{archiveAction}</output>}
                    <footer>档案编号 {run.id.toUpperCase()}</footer>
                </section>}
            </div>

            <footer className="sars-composer">
                {error && <p className="sars-error">{error}</p>}
                {active ? <div className="sars-compose-row">
                    <textarea
                        value={draft}
                        maxLength={4000}
                        disabled={sending || !char}
                        placeholder={char ? (mode === 'online' ? '在危机中发给这个异格……' : '回应眼前正在发生的事……') : '原角色资料已不存在，无法继续推演'}
                        onChange={event => setDraft(event.target.value)}
                        onKeyDown={event => {
                            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                    />
                    <button type="button" aria-label="发送并推进一轮" disabled={!draft.trim() || sending || !char} onClick={() => void send()}>{sending ? <CircleNotch size={17} className="animate-spin" /> : <PaperPlaneRight size={17} weight="fill" />}</button>
                </div> : <div className="sars-readonly"><Archive size={14} /> 封存记录可反复阅读 · 最终进度 {run.interactionsUsed}/50</div>}
                <small>{active ? `本轮由世界意志掌舵旁白；成功生成后从 ${run.interactionsUsed}/50 前往 ${run.interactionsUsed + 1}/50` : '下载保留完整逐字记录；分享给角色的是较短的返航简报'}</small>
            </footer>

            {archiveConfirm && <div className="sars-confirm" role="alertdialog" aria-modal="true" aria-label="确认紧急封存">
                <section><button type="button" aria-label="取消封存" onClick={() => setArchiveConfirm(false)}><X size={15} /></button><SealWarning size={28} weight="thin" /><small>EMERGENCY SEAL</small><h3>在 {run.interactionsUsed}/50 提前封存？</h3><p>这段推演会立刻停止，现有对话永久保留；当前版本不能直接恢复，之后需要凯恩的重启模块。</p><div><button type="button" onClick={() => setArchiveConfirm(false)}>继续推演</button><button type="button" onClick={archive}>确认封存</button></div></section>
            </div>}
        </main>
    );
};

const SARSessionStyle = () => <style>{`
    .sars-session{position:relative;z-index:2;height:calc(100% - var(--sarc-top) - 55px);display:grid;grid-template-rows:auto minmax(0,1fr) auto;color:#dce8eb;background:linear-gradient(180deg,#0b1419,#070d11 48%,#05090c);overflow:hidden}
    .sars-console-head{padding:12px 16px 9px;border-bottom:1px solid #58768144;background:radial-gradient(circle at 86% 0,#3d68751c,transparent 35%),#081115}.sars-subject{display:flex;align-items:center;gap:10px}.sars-subject__portrait{position:relative;width:39px;height:39px;flex:0 0 39px;display:grid;place-items:center;overflow:hidden;border:1px solid #7197a3;border-radius:50%;background:#13242b;color:#bcd3d9;font:500 13px/1 "Noto Serif SC",serif}.sars-subject__portrait img{width:100%;height:100%;object-fit:cover}.sars-subject__portrait i{position:absolute;right:1px;bottom:2px;width:6px;height:6px;border-radius:50%;background:#83c8ca;box-shadow:0 0 8px #83c8ca}.sars-subject small{font:5.5px/1 monospace;letter-spacing:.18em;color:#6f8c96}.sars-subject h2{margin:5px 0 0;font:500 14px/1.2 "Noto Serif SC",serif;letter-spacing:.1em}
    .sars-crisis{position:relative;margin-top:11px;padding:10px 11px 9px;overflow:hidden;border-left:1px solid #b17a70;border-right:1px solid #5f464155;background:linear-gradient(90deg,#3d201d4f,#161416 64%,#0d1518)}.sars-crisis:before{content:"";position:absolute;left:0;top:0;width:34%;height:1px;background:#c38b80;box-shadow:0 0 8px #a85f54;animation:sars-crisis-line 2.4s ease-in-out infinite}.sars-crisis header{display:flex;align-items:center;justify-content:space-between;gap:8px}.sars-crisis header small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#97716b;font:5.5px/1 monospace;letter-spacing:.13em}.sars-crisis header b{flex:0 0 auto;color:#d7b8b1;font:500 8px/1 "Noto Serif SC",serif;letter-spacing:.1em}.sars-crisis>p{margin:7px 0 8px;color:#d6c6c2;font:500 9px/1.6 "Noto Serif SC",serif}.sars-crisis>div{display:grid;grid-template-columns:1fr 1fr;gap:8px;border-top:1px solid #7656503b;padding-top:7px}.sars-crisis>div span{min-width:0;color:#8e7d79;font-size:6.5px;line-height:1.45}.sars-crisis>div i{display:block;margin-bottom:3px;color:#9f746d;font:5.5px/1 monospace;font-style:normal;letter-spacing:.12em}
    .sars-life{margin-top:9px}.sars-life>div:first-child{display:flex;align-items:end;justify-content:space-between;color:#71909a;font-size:7px;letter-spacing:.09em}.sars-life b{font:500 17px/1 monospace;color:#c8dce1}.sars-life b i{margin:0 2px;font-style:normal;font-size:8px;color:#58727b}.sars-life__ticks{display:grid;grid-template-columns:repeat(25,1fr);gap:2px;margin-top:6px}.sars-life__ticks i{height:3px;background:#21343b}.sars-life__ticks i.is-used{background:#7db5bd;box-shadow:0 0 5px #62a8b455}
    .sars-mode-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px}.sars-mode-switch{display:grid;grid-template-columns:1fr 1fr;width:174px;border:1px solid #496671;background:#060c0f}.sars-mode-switch button{height:31px;display:grid;grid-template-columns:14px auto 1fr;align-items:center;gap:4px;padding:0 7px;color:#5f7a84;border:0;background:none;text-align:left}.sars-mode-switch button+button{border-left:1px solid #496671}.sars-mode-switch button.is-active{color:#d5e7ea;background:#294b5766}.sars-mode-switch b{font-size:8px}.sars-mode-switch small{font-size:5.5px;color:currentColor;opacity:.64}.sars-mode-dot{width:7px;height:7px;border:1px solid currentColor;border-radius:50%}.sars-archive-button{height:31px;display:flex;align-items:center;gap:5px;padding:0 9px;color:#a77f78;border:1px solid #795b5659;background:#2f171544;font-size:7px}
    .sars-log{overflow-y:auto;padding:13px 16px 22px;scrollbar-width:none;scroll-behavior:smooth}.sars-log::-webkit-scrollbar{display:none}.sars-prologue{margin:0 0 21px;padding:0 0 17px;border-bottom:1px solid #5876813d}.sars-prologue small{font:5.5px/1 monospace;letter-spacing:.2em;color:#6d8993}.sars-prologue>p{margin:9px 0 12px;color:#879ba2;font:400 9px/1.8 "Noto Serif SC",serif}.sars-prologue blockquote{margin:0;padding:9px 11px;border-left:1px solid #79a3ae;background:#14242a;color:#d5e5e8;font:500 10.5px/1.7 "Noto Serif SC",serif}.sars-prologue blockquote b{display:block;margin-bottom:3px;color:#77959f;font:5.5px/1 monospace;letter-spacing:.15em}
    .sars-message{position:relative;margin:0 0 18px;padding-left:15px}.sars-message:before{content:"";position:absolute;left:0;top:3px;bottom:0;width:1px;background:#496671}.sars-message header{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}.sars-message header span{color:#9bb4bb;font:600 7px/1 monospace;letter-spacing:.13em}.sars-message header i{font:5.5px/1 monospace;font-style:normal;letter-spacing:.12em;color:#526b74}.sars-message p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:#c9d7da;font-size:10.5px;line-height:1.75}.sars-message.is-user{margin-left:36px;padding:10px 11px 10px 14px;border:1px solid #4d6b7555;background:#11212999}.sars-message.is-user:before{background:#77a5b1}.sars-message.is-user p{color:#b6c9ce}.sars-message.is-pending{opacity:.55}.sars-message.is-assistant{margin-right:20px}.sars-message.is-assistant:before{box-shadow:0 0 8px #6fa9b544}.sars-message.is-generating>div{display:flex;align-items:center;gap:5px;color:#66818b;font-size:7px}.sars-message.is-generating>div>i{width:4px;height:4px;border-radius:50%;background:#7aaab3;animation:sars-pulse 1.1s infinite}.sars-message.is-generating>div>i:nth-child(2){animation-delay:.16s}.sars-message.is-generating>div>i:nth-child(3){animation-delay:.32s}.sars-message.is-generating>div>span{margin-left:4px}
    .sars-loading{display:flex;align-items:center;justify-content:center;gap:7px;padding:30px;color:#6e8790;font-size:8px}.sars-sealed{margin:25px 0 8px;padding:24px 12px;text-align:center;border-top:1px solid #73575055;border-bottom:1px solid #73575055;color:#9e7c75;background:linear-gradient(90deg,transparent,#3e201d33,transparent)}.sars-sealed small{display:block;margin-top:9px;font:5.5px/1 monospace;letter-spacing:.2em}.sars-sealed h3{margin:7px 0 6px;color:#d2bbb6;font:500 12px/1.4 "Noto Serif SC",serif}.sars-sealed p{max-width:260px;margin:auto;color:#816f6b;font-size:7.5px;line-height:1.6}
    .sars-composer{padding:9px 13px calc(var(--sarc-bottom) + 10px);border-top:1px solid #58768144;background:#070d11e8;backdrop-filter:blur(10px)}.sars-compose-row{display:grid;grid-template-columns:1fr 42px;align-items:end;gap:8px}.sars-compose-row textarea{height:47px;max-height:110px;resize:none;padding:10px 11px;color:#d7e4e7;border:1px solid #496671;background:#0d181d;outline:none;font:400 10px/1.5 inherit}.sars-compose-row textarea:focus{border-color:#769da8;box-shadow:0 0 0 1px #6f9da733}.sars-compose-row textarea::placeholder{color:#526a73}.sars-compose-row>button{width:42px;height:42px;display:grid;place-items:center;color:#e0eef0;border:1px solid #7aa6b2;background:#31586688;clip-path:polygon(8px 0,100% 0,100% calc(100% - 8px),calc(100% - 8px) 100%,0 100%,0 8px)}.sars-compose-row>button:disabled{color:#4e656d;border-color:#334b54;background:#0d171b}.sars-composer>small{display:block;margin-top:5px;text-align:center;color:#4f676f;font:5.5px/1.2 monospace;letter-spacing:.06em}.sars-error{margin:0 0 7px;padding:7px 9px;color:#d3a19a;border-left:1px solid #a46d65;background:#542b2733;font-size:7.5px;line-height:1.45}.sars-readonly{padding:11px;text-align:center;color:#6d7e83;border:1px solid #394d54;font:7px/1 monospace;letter-spacing:.16em}
    .sars-confirm{position:fixed;z-index:50;inset:0;display:grid;place-items:center;padding:24px;background:#020405d9;backdrop-filter:blur(8px)}.sars-confirm>section{position:relative;width:min(100%,320px);padding:25px 21px 19px;text-align:center;border:1px solid #86645e;background:radial-gradient(circle at 50% 0,#63342e33,transparent 42%),#0d1214;clip-path:polygon(12px 0,100% 0,100% calc(100% - 12px),calc(100% - 12px) 100%,0 100%,0 12px)}.sars-confirm>section>button{position:absolute;right:9px;top:9px;width:29px;height:29px;display:grid;place-items:center;color:#9b817c;border:1px solid #644b47;background:#171719}.sars-confirm>section>svg{color:#b27d74}.sars-confirm small{display:block;margin-top:10px;color:#966d66;font:5.5px/1 monospace;letter-spacing:.22em}.sars-confirm h3{margin:8px 0;color:#e0c9c5;font:500 16px/1.35 "Noto Serif SC",serif}.sars-confirm p{margin:0;color:#93817d;font-size:8.5px;line-height:1.7}.sars-confirm>section>div{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:17px}.sars-confirm>section>div button{height:40px;color:#9baeb3;border:1px solid #4c646d;background:#0e181c;font-size:9px}.sars-confirm>section>div button:last-child{color:#dfc5c0;border-color:#8d625b;background:#4e292544}
    /* v2 reading surface: light by default, with a persisted dark alternative. */
    .sars-session.is-light{--sars-paper:#f4f0e7;--sars-paper-deep:#ebe5d8;--sars-ink:#27353a;--sars-muted:#68787b;--sars-faint:#91a09f;--sars-line:#b8c3bf;--sars-cyan:#3d737a;--sars-cyan-soft:#dce8e5;--sars-rust:#965f54;--sars-rust-soft:#eee0da;--sars-gm:#5b657f;--sars-gm-soft:#e3e4eb;--sars-input:#fffdf8;--sars-shadow:#33474c18}
    .sars-session.is-dark{--sars-paper:#0b1418;--sars-paper-deep:#071014;--sars-ink:#dce8eb;--sars-muted:#91a5aa;--sars-faint:#60767c;--sars-line:#3f5961;--sars-cyan:#83b8bd;--sars-cyan-soft:#173039;--sars-rust:#c18a7f;--sars-rust-soft:#35211f;--sars-gm:#a8add0;--sars-gm-soft:#202436;--sars-input:#101c21;--sars-shadow:#0005}
    .sars-session{color:var(--sars-ink);background:var(--sars-paper);transition:color .24s ease,background .24s ease}
    .sars-console-head{padding:13px 16px 11px;border-bottom:1px solid var(--sars-line);background:linear-gradient(180deg,var(--sars-paper),var(--sars-paper-deep));box-shadow:0 6px 18px var(--sars-shadow)}
    .sars-topline{display:flex;align-items:center;justify-content:space-between;gap:12px}.sars-subject{min-width:0}.sars-subject__portrait{width:43px;height:43px;flex-basis:43px;border-color:var(--sars-cyan);background:var(--sars-cyan-soft);color:var(--sars-cyan)}.sars-subject__portrait i{background:var(--sars-cyan);box-shadow:none}.sars-subject small{font-size:8px;color:var(--sars-muted)}.sars-subject h2{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:4px;color:var(--sars-ink);font-size:16px}
    .sars-theme{height:36px;min-width:58px;display:flex;align-items:center;justify-content:center;gap:6px;padding:0 9px;color:var(--sars-cyan);border:1px solid var(--sars-line);border-radius:2px;background:transparent;font-size:10px}.sars-theme:active{background:var(--sars-cyan-soft)}
    .sars-crisis{margin-top:12px;padding:11px 12px 10px;border:0;border-left:3px solid var(--sars-rust);background:var(--sars-rust-soft);box-shadow:none}.sars-crisis:before{width:38%;height:2px;background:var(--sars-rust);box-shadow:none}.sars-crisis header small{color:var(--sars-rust);font-size:8px}.sars-crisis header b{color:var(--sars-rust);font-size:10px}.sars-crisis>p{margin:8px 0;color:var(--sars-ink);font-size:12px;line-height:1.55}.sars-crisis>div{gap:12px;border-top-color:color-mix(in srgb,var(--sars-rust) 24%,transparent);padding-top:8px}.sars-crisis>div span{color:var(--sars-muted);font-size:9px;line-height:1.45}.sars-crisis>div i{margin-bottom:3px;color:var(--sars-rust);font-size:8px}
    .sars-life{margin-top:10px}.sars-life>div:first-child{color:var(--sars-muted);font-size:9px}.sars-life b{color:var(--sars-ink);font-size:19px}.sars-life b i{color:var(--sars-faint);font-size:10px}.sars-life__ticks{gap:2px;margin-top:6px}.sars-life__ticks i{height:4px;background:color-mix(in srgb,var(--sars-line) 55%,transparent)}.sars-life__ticks i.is-used{background:var(--sars-cyan);box-shadow:none}
    .sars-mode-row{margin-top:10px}.sars-mode-switch{width:190px;border-color:var(--sars-line);background:transparent}.sars-mode-switch button{height:36px;color:var(--sars-muted);grid-template-columns:15px auto 1fr;padding:0 8px}.sars-mode-switch button+button{border-left-color:var(--sars-line)}.sars-mode-switch button.is-active{color:var(--sars-cyan);background:var(--sars-cyan-soft)}.sars-mode-switch b{font-size:10px}.sars-mode-switch small{font-size:8px}.sars-archive-button{height:36px;padding:0 10px;color:var(--sars-rust);border-color:color-mix(in srgb,var(--sars-rust) 45%,transparent);background:transparent;font-size:10px}
    .sars-log{padding:20px 17px 30px;background-image:linear-gradient(color-mix(in srgb,var(--sars-line) 16%,transparent) 1px,transparent 1px);background-size:100% 29px}
    .sars-gm{position:relative;margin:0 0 13px;padding:13px 14px;border-left:3px solid var(--sars-gm);background:var(--sars-gm-soft);box-shadow:0 7px 18px var(--sars-shadow);animation:sars-paper-in .28s ease-out both}.sars-gm--prologue{margin-bottom:16px}.sars-gm header,.sars-message header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.sars-gm header span{display:flex;align-items:center;gap:5px;color:var(--sars-gm);font:700 9px/1 monospace;letter-spacing:.08em}.sars-gm header i,.sars-message header i{color:var(--sars-faint);font:8px/1 monospace;font-style:normal;letter-spacing:.08em}.sars-gm p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--sars-ink);font:400 13px/1.78 "Noto Serif SC",serif}
    .sars-message{margin:0 12px 19px 4px;padding:3px 0 3px 15px}.sars-message:before{width:2px;background:var(--sars-cyan)}.sars-message header span{color:var(--sars-cyan);font-size:10px}.sars-message p{color:var(--sars-ink);font:400 14px/1.8 "Noto Serif SC",serif}.sars-message.is-user{margin:0 0 19px 42px;padding:12px 13px;border:1px solid var(--sars-line);border-right:3px solid var(--sars-cyan);background:var(--sars-cyan-soft);box-shadow:0 6px 16px var(--sars-shadow)}.sars-message.is-user:before{display:none}.sars-message.is-user p{color:var(--sars-ink)}.sars-message.is-assistant{margin-right:18px}.sars-message.is-assistant:before{box-shadow:none}.sars-opening-line{margin-bottom:24px}.sars-opening-line p{font-weight:550}
    .sars-message.is-generating>div,.sars-gm.is-generating>div{display:flex;align-items:center;gap:6px;color:var(--sars-muted);font-size:10px}.sars-message.is-generating>div>i,.sars-gm.is-generating>div>i{width:5px;height:5px;border-radius:50%;background:var(--sars-cyan);animation:sars-pulse 1.1s infinite}.sars-gm.is-generating>div>i{background:var(--sars-gm)}.sars-message.is-generating>div>i:nth-child(2),.sars-gm.is-generating>div>i:nth-child(2){animation-delay:.16s}.sars-message.is-generating>div>i:nth-child(3),.sars-gm.is-generating>div>i:nth-child(3){animation-delay:.32s}.sars-message.is-generating>div>span,.sars-gm.is-generating>div>span{margin-left:3px}
    .sars-loading{padding:35px;color:var(--sars-muted);font-size:11px}
    .sars-sealed{position:relative;margin:35px 0 10px;padding:31px 16px 17px;overflow:hidden;border:1px solid var(--sars-line);color:var(--sars-rust);background:var(--sars-input);box-shadow:0 18px 40px var(--sars-shadow);animation:sars-seal-arrive .7s cubic-bezier(.2,.8,.2,1) both}.sars-sealed:before{content:"";position:absolute;inset:8px;border:1px solid color-mix(in srgb,var(--sars-rust) 22%,transparent);pointer-events:none}.sars-seal-mark{position:relative;width:76px;height:76px;margin:0 auto 15px;display:grid;place-items:center;color:var(--sars-rust);border:1px solid var(--sars-rust);border-radius:50%;animation:sars-stamp .58s .16s cubic-bezier(.16,1.4,.4,1) both}.sars-seal-mark i{position:absolute;inset:8px;border:1px dashed color-mix(in srgb,var(--sars-rust) 60%,transparent);border-radius:50%;animation:sars-orbit 12s linear infinite}.sars-seal-mark i:nth-child(2){inset:-7px;border-style:solid;border-color:color-mix(in srgb,var(--sars-rust) 18%,transparent);animation-direction:reverse}.sars-sealed>small{position:relative;margin-top:0;color:var(--sars-rust);font-size:8px}.sars-sealed h3{position:relative;margin:9px 0 7px;color:var(--sars-ink);font-size:20px;letter-spacing:.04em}.sars-sealed>p{position:relative;max-width:320px;color:var(--sars-muted);font-size:11px;line-height:1.7}.sars-archive-actions{position:relative;display:grid;grid-template-columns:1fr 1fr;margin-top:21px;border-top:1px solid var(--sars-line);border-left:1px solid var(--sars-line)}.sars-archive-actions button{min-height:57px;display:flex;align-items:center;gap:9px;padding:9px 11px;text-align:left;color:var(--sars-ink);border:0;border-right:1px solid var(--sars-line);border-bottom:1px solid var(--sars-line);background:transparent}.sars-archive-actions button:last-child{grid-column:1/-1;color:var(--sars-rust)}.sars-archive-actions button:disabled{opacity:.48}.sars-archive-actions button>span{font-size:11px}.sars-archive-actions button small{display:block;margin-top:3px;color:var(--sars-muted);font:8px/1.2 monospace;letter-spacing:.04em}.sars-sealed output{position:relative;display:block;margin-top:10px;color:var(--sars-cyan);font-size:10px}.sars-sealed>footer{position:relative;margin-top:15px;padding-top:10px;border-top:1px solid color-mix(in srgb,var(--sars-line) 55%,transparent);color:var(--sars-faint);font:7px/1 monospace;letter-spacing:.08em}
    .sars-composer{padding:10px 13px calc(var(--sarc-bottom) + 11px);border-top-color:var(--sars-line);background:color-mix(in srgb,var(--sars-paper) 92%,transparent);box-shadow:0 -8px 22px var(--sars-shadow)}.sars-compose-row{grid-template-columns:1fr 46px;gap:9px}.sars-compose-row textarea{height:52px;padding:10px 12px;color:var(--sars-ink);border-color:var(--sars-line);background:var(--sars-input);font-size:13px}.sars-compose-row textarea:focus{border-color:var(--sars-cyan);box-shadow:0 0 0 2px color-mix(in srgb,var(--sars-cyan) 14%,transparent)}.sars-compose-row textarea::placeholder{color:var(--sars-faint)}.sars-compose-row>button{width:46px;height:46px;color:var(--sars-input);border-color:var(--sars-cyan);background:var(--sars-cyan)}.sars-compose-row>button:disabled{color:var(--sars-faint);border-color:var(--sars-line);background:var(--sars-paper-deep)}.sars-composer>small{margin-top:7px;color:var(--sars-muted);font-size:8px}.sars-error{padding:9px 10px;color:var(--sars-rust);border-left-color:var(--sars-rust);background:var(--sars-rust-soft);font-size:10px}.sars-readonly{display:flex;align-items:center;justify-content:center;gap:7px;padding:11px;color:var(--sars-muted);border-color:var(--sars-line);font-size:9px}
    .sars-confirm{background:#141918b8}.sars-confirm>section{border-color:var(--sars-rust);background:var(--sars-paper);box-shadow:0 24px 70px #0005}.sars-confirm>section>button{color:var(--sars-muted);border-color:var(--sars-line);background:var(--sars-paper-deep)}.sars-confirm>section>svg,.sars-confirm small{color:var(--sars-rust)}.sars-confirm small{font-size:8px}.sars-confirm h3{color:var(--sars-ink);font-size:18px}.sars-confirm p{color:var(--sars-muted);font-size:11px}.sars-confirm>section>div button{height:43px;color:var(--sars-muted);border-color:var(--sars-line);background:var(--sars-paper-deep);font-size:11px}.sars-confirm>section>div button:last-child{color:var(--sars-rust);border-color:var(--sars-rust);background:var(--sars-rust-soft)}
    @keyframes sars-pulse{0%,70%,100%{opacity:.25;transform:translateY(0)}35%{opacity:1;transform:translateY(-2px)}}@keyframes sars-crisis-line{0%,100%{opacity:.25;transform:translateX(-40%)}50%{opacity:.85;transform:translateX(220%)}}@keyframes sars-paper-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@keyframes sars-seal-arrive{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}@keyframes sars-stamp{from{opacity:0;transform:scale(1.55) rotate(-8deg)}to{opacity:1;transform:scale(1) rotate(-3deg)}}@keyframes sars-orbit{to{transform:rotate(360deg)}}
    @media(min-width:700px){.sars-session{max-width:600px;margin:0 auto;border-left:1px solid #425b6444;border-right:1px solid #425b6444}}
`}</style>;
