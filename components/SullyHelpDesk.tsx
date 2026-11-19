import { trackEvent } from '../utils/analytics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpenText, CaretRight, ChatsCircle, ClockCounterClockwise, Compass, Lightning, MagnifyingGlass, Paperclip, PaperPlaneTilt, Smiley, SquaresFour, X } from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { askSullyHelpDesk, automaticScope, helpDeskCatalog, helpTopicLabel, isAvailableHelpScope, type buildHelpDeskKnowledge, type HelpDeskScope } from '../utils/sullyHelpDesk';
import { appendHelpRecord, CONSULTATION_IDLE_MS, currentConsultation, HELP_HISTORY_LIMIT, HELP_QUESTION_LIMIT, loadHelpHistory, newConsultation, recordConsultation, rememberConsultation, sameHelpThread, type HelpRecord, type HelpConsultation } from '../utils/sullyHelpHistory';
import { readHelpDeskSettings } from '../utils/sullyHelpSettings';
import { SULLY_HELP_DESK_AVATAR } from '../utils/sullyIdentity';
import { HelpImageError, helpFileAccept, readHelpFile, type HelpAttachment } from '../utils/sullyHelpAttachments';
import { migrateDataUrlToRef } from '../utils/blobRef';
import { useChatViewportAnchor } from '../utils/useChatViewportAnchor';
import { HelpAttachmentView, HelpStickerPicker } from './SullyHelpAttachments';
import './SullyHelpDesk.css';

const categories = { app: '具体 App', system: '跨 App 系统', community: '社区规则' } as const;
type Panel = 'catalog' | 'history' | null;

export function SullyHelpDesk({ knowledge }: { knowledge: ReturnType<typeof buildHelpDeskKnowledge> }) {
    const os = useOS();
    const [rows, setRows] = useState<HelpRecord[]>([]);
    const [session, setSession] = useState(newConsultation);
    const [visibleCount, setVisibleCount] = useState(50);
    function activate(next: HelpConsultation) { rememberConsultation(next); setSession(next); }
    function touch() {
        const now = Date.now();
        if (ready && !working.current && now - session.lastActive < CONSULTATION_IDLE_MS)
            activate({ ...session, lastActive: now });
    }
    function startNew(manual: boolean) {
        activate(newConsultation());
        if (manual) { setDraft(''); setAttachment(undefined); trackEvent('新建客服咨询'); }
        setPanel(null); setStickers(false); setError(''); setImageFailed(false);
        setScope(automaticScope); setSelected(null); setVisibleCount(50);
    }
    const [ready, setReady] = useState(false);
    const [scope, setScope] = useState(automaticScope);
    const [selected, setSelected] = useState<string | null>(null);
    const previousCharacter = useRef('');
    const [panel, setPanel] = useState<Panel>(null);
    const [filter, setFilter] = useState('');
    const [category, setCategory] = useState<HelpDeskScope['category']>('app');
    const [draft, setDraft] = useState('');
    const [attachment, setAttachment] = useState<HelpAttachment>();
    const [stickers, setStickers] = useState(false);
    const [imageFailed, setImageFailed] = useState(false);
    const fileInput = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [stage, setStage] = useState('');
    const [attempt, setAttempt] = useState(0);
    const request = useRef<AbortController | null>(null);
    const working = useRef(false);
    const alive = useRef(false);
    const log = useRef<HTMLDivElement>(null);
    const charId = scope.category === 'community' ? '' : selected ?? os.activeCharacterId ?? '';
    const char = os.characters.find(c => c.id === charId);
    const preferredCharacter = os.characters.find(c => c.id === previousCharacter.current)
        ?? os.characters.find(c => c.id === os.activeCharacterId) ?? os.characters[0];
    const thread = useMemo(() => rows.filter(row => recordConsultation(row) === session.id && sameHelpThread(row, scope, charId)), [rows, session.id, scope, charId]);
    const last = thread[thread.length - 1];
    const pendingImages = useMemo(() => {
        const recent = thread.slice(-HELP_HISTORY_LIMIT);
        return recent.slice(recent.map(row => row.role).lastIndexOf('assistant') + 1).some(row => row.attachment?.kind === 'image' && row.attachment.url);
    }, [thread]);
    const topic = helpDeskCatalog.find(page => page.title === scope.topic);
    const configured = !!os.apiConfig.baseUrl.trim() && !!os.apiConfig.model.trim();
    useChatViewportAnchor(log, scope.topic + ':' + charId, !panel && ready);

    useEffect(() => {
        alive.current = true;
        let current = true;
        loadHelpHistory().then(saved => {
            if (!current) return;
            setRows(saved);
            const active = currentConsultation(saved);
            activate(active);
            const latest = [...saved].reverse().find(row => recordConsultation(row) === active.id && isAvailableHelpScope(row.scope));
            if (latest) {
                setScope(latest.scope);
                if (latest.scope.category !== 'community') setSelected(latest.characterId);
            }
            setReady(true);
            setError('');
        }).catch(() => { if (current) setError('本机客服记录暂时打不开。'); });
        const refresh = () => {
            if (!working.current) void loadHelpHistory().then(saved => { if (current && !working.current) setRows(saved); }).catch(() => {});
        };
        window.addEventListener('focus', refresh);
        return () => {
            alive.current = false;
            current = false;
            request.current?.abort();
            window.removeEventListener('focus', refresh);
        };
    }, [attempt]);

    useEffect(() => {
        if (!ready || busy || !rows.some(row => recordConsultation(row) === session.id)) return;
        const expire = () => { if (Date.now() - session.lastActive >= CONSULTATION_IDLE_MS) startNew(false); };
        const timer = window.setTimeout(expire, Math.max(0, session.lastActive + CONSULTATION_IDLE_MS - Date.now()));
        window.addEventListener('focus', expire);
        return () => { window.clearTimeout(timer); window.removeEventListener('focus', expire); };
    }, [session, ready, busy, rows]);

    useEffect(() => {
        if (!panel && log.current) log.current.scrollTop = last ? log.current.scrollHeight : 0;
    }, [panel, last?.id, stage]);

    function choose(next: HelpDeskScope, characterId?: string) {
        setVisibleCount(50);
        if (characterId !== undefined) trackEvent('重开最近咨询');
        else if (next.category === 'community') trackEvent('选择客服咨询方向', { 方向: '社区' });
        else if (next.category === 'system') trackEvent('选择客服咨询方向', { 方向: '系统' });
        else if (next.category === 'app') trackEvent('选择客服咨询方向', { 方向: next.topic === automaticScope.topic ? '帮我找入口' : 'App' });
        setScope(next);
        if (characterId !== undefined && next.category !== 'community') setSelected(characterId);
        setPanel(null);
        setStickers(false);
        setImageFailed(false);
        setError('');
        setFilter('');
    }
    function browse(type: HelpDeskScope['category']) {
        setCategory(type);
        setFilter('');
        setPanel('catalog');
    }
    function selectConfig(characterId: string) {
        if (char) previousCharacter.current = char.id;
        setSelected(characterId);
        setError('');
        setImageFailed(false);
    }
    async function selectFile(file?: File) {
        if (!file || working.current) return;
        working.current = true;
        setBusy(true);
        setError('');
        setStickers(false);
        try {
            const item = await readHelpFile(file);
            if (alive.current) setAttachment(item);
        } catch (cause) {
            if (alive.current) setError(cause instanceof Error ? cause.message : '读取附件失败，请重新选择。');
        } finally {
            working.current = false;
            if (alive.current) setBusy(false);
        }
    }
    async function run(generate: boolean, textOnly = false) {
        const question = draft.trim();
        if (!ready || working.current || (generate ? !configured || last?.role !== 'user' : !question && !attachment)) return;
        const expired = Date.now() - session.lastActive >= CONSULTATION_IDLE_MS;
        if (expired && generate) { startNew(false); return; }
        const active = expired ? newConsultation() : { ...session, lastActive: Date.now() };
        activate(active);
        working.current = true;
        setBusy(true);
        setError('');
        setImageFailed(false);
        setStickers(false);
        const controller = new AbortController();
        request.current = controller;
        try {
            const makeRecord = (role: HelpRecord['role'], content: string): HelpRecord => ({
                id: Array.from(crypto.getRandomValues(new Uint32Array(4)), word => word.toString(16).padStart(8, '0')).join(''),
                scope, characterId: charId, role, content, consultationId: active.id, sentAt: Date.now(),
            });
            if (!generate) {
                const record = makeRecord('user', question);
                if (attachment) record.attachment = attachment.kind !== 'file' && attachment.url.startsWith('data:image/')
                    ? { ...attachment, url: await migrateDataUrlToRef(attachment.url) } : attachment;
                const saved = await appendHelpRecord(record);
                if (attachment?.kind === 'file') trackEvent('发送客服附件', { 类型: '文件' });
                else if (attachment?.kind === 'image') trackEvent('发送客服附件', { 类型: '图片' });
                else if (attachment?.kind === 'sticker') trackEvent('发送客服附件', { 类型: '表情包' });
                if (alive.current) { setRows(saved); setDraft(''); setAttachment(undefined); }
                return;
            }
            const saved = await loadHelpHistory();
            if (controller.signal.aborted) return;
            setRows(saved);
            const turns = saved.filter(row => recordConsultation(row) === active.id).slice(-HELP_HISTORY_LIMIT).filter(row => sameHelpThread(row, scope, charId));
            const pending = turns[turns.length - 1];
            if (pending?.role !== 'user') return;
            setStage('11 号在翻手册…');
            const settings = scope.category === 'community' ? null : await readHelpDeskSettings(os, char);
            if (controller.signal.aborted) return;
            const answer = await askSullyHelpDesk(os.apiConfig, knowledge, turns, settings, controller.signal, scope,
                titles => { if (!controller.signal.aborted && titles.length) setStage('正在查 ' + titles.join('、')); }, textOnly);
            if (controller.signal.aborted) return;
            const updated = await appendHelpRecord(makeRecord('assistant', answer), pending.id);
            if (alive.current) { setRows(updated); activate({ ...active, lastActive: Date.now() }); }
        } catch (cause) {
            if (alive.current && !controller.signal.aborted) {
                setError(cause instanceof Error ? cause.message : '这次没完成，请再试一次。');
                setImageFailed(cause instanceof HelpImageError);
            }
        } finally {
            working.current = false;
            request.current = null;
            if (alive.current) { setStage(''); setBusy(false); }
        }
    }

    const historyThreads = useMemo(() => {
        const list: HelpRecord[] = [];
        const seen = new Set<string>();
        for (let i = rows.length - 1; i >= 0; i--) {
            const row = rows[i];
            const key = JSON.stringify([recordConsultation(row), row.scope.category, row.scope.topic, row.scope.category === 'community' ? '' : row.characterId]);
            if (seen.has(key) || !isAvailableHelpScope(row.scope)) continue;
            seen.add(key);
            list.push(row);
        }
        return list;
    }, [rows]);
    const catalogMatches = helpDeskCatalog.filter(page => filter.trim()
        ? (helpTopicLabel(page.title) + ' ' + page.areas.map(a => a.label).join(' ')).toLowerCase().includes(filter.trim().toLowerCase())
        : page.category === category);
    const welcome = <div className={'s11-welcome' + (topic ? ' s11-topic' : '') + (thread.length ? ' s11-compact' : '')} aria-label="当前咨询">
        <div><span>{topic ? 'Sully-11 · 当前正在咨询' : thread.length ? 'Sully-11 · 当前咨询' : '糯米机答疑'}</span>
            <h2>{topic ? helpTopicLabel(topic.title) : thread.length ? '自动找入口' : 'Sully-11'}</h2>
            {!thread.length && <p>{topic ? '想问「' + topic.areas.slice(0, 2).map(a => a.label).join('」或「') + '」？也可以直接说你卡在哪一步。' : <>卡在哪一步啦？<br />你说，我去翻手册。</>}</p>}
        </div><img src={SULLY_HELP_DESK_AVATAR} alt="戴墨镜的 11 号黑猫" />
    </div>;

    return <section className="s11" aria-label="Sully-11 答疑" onPointerDownCapture={touch} onInputCapture={touch}>
        <div className="s11-bar">
            <button type="button" disabled={busy || !ready} onClick={() => panel ? setPanel(null) : browse(scope.category)}>
                {panel ? <ArrowLeft /> : <Compass />} {panel ? '返回咨询' : '功能目录'}
            </button>
            <button type="button" disabled={busy || !ready} aria-pressed={panel === 'history'} onClick={() => setPanel(panel === 'history' ? null : 'history')}>
                <ClockCounterClockwise /> 最近咨询
            </button>
            <button type="button" disabled={busy || !ready} onClick={() => startNew(true)}>新咨询</button>
        </div>
        {panel ? <div className="s11-scroll s11-sheet">
            <h2>{panel === 'catalog' ? '功能目录' : '最近咨询'}</h2>
            {panel === 'catalog' ? <>
                <label className="s11-search"><MagnifyingGlass /><input aria-label="搜索功能目录" value={filter} onChange={e => setFilter(e.target.value)} placeholder="搜 App、开关或玩法" /></label>
                {filter.trim() ? <p>全部目录中找到 {catalogMatches.length} 个主题</p> : <div className="s11-tabs" role="group" aria-label="目录分类">{(Object.keys(categories) as (keyof typeof categories)[]).map(k =>
                    <button key={k} aria-pressed={category === k} onClick={() => { setCategory(k); setFilter(''); }}>{categories[k]}</button>)}</div>}
                <button className="s11-row" onClick={() => choose(automaticScope)}><Compass /><span>说不准，帮我找入口</span><CaretRight /></button>
                {catalogMatches.map(page => <button className="s11-catalog-row" key={page.title} onClick={() => choose({ category: page.category, topic: page.title })}>
                    <span><strong>{helpTopicLabel(page.title)}</strong><small>{page.areas.map(a => a.label).join(' · ')}</small></span><em>{page.areas.length} 区</em><CaretRight />
                </button>)}
                {!catalogMatches.length && <p>目录里没找到这个词，可以选「帮我找入口」直接问。</p>}
            </> : <>
                <p>20 分钟没有互动或开启新咨询后归档。点开记录可以续聊，11 号只读这段咨询最近 {HELP_HISTORY_LIMIT} 条。</p>
                {historyThreads.map(row => <button key={row.id} className="s11-catalog-row" onClick={() => {
                    activate({ id: recordConsultation(row), lastActive: Date.now() }); setDraft(''); setAttachment(undefined); choose(row.scope, row.characterId);
                }}>
                    <span><strong>{helpTopicLabel(row.scope.topic)}{row.scope.category !== 'community' && ' · ' + (row.characterId ? (os.characters.find(c => c.id === row.characterId)?.name ?? '原角色已移除') : '所有角色')}</strong><small>{recordConsultation(row) === session.id ? '进行中' : '已归档'}{row.sentAt ? ' · ' + new Date(row.sentAt).toLocaleString() : ''}</small><small>{(row.content || row.attachment?.name || '').slice(0, 60)}</small></span><CaretRight />
                </button>)}
                {!historyThreads.length && <p>发出第一条问题后，可以在这里接着聊。</p>}
            </>}
        </div> : <>
            {thread.length > 0 && welcome}
            <div ref={log} className="s11-scroll s11-log" role="log" aria-live="polite">
                {thread.length > visibleCount && <button type="button" className="s11-row" onClick={() => setVisibleCount(count => count + 50)}>查看更早消息</button>}
                {!thread.length ? <>
                    {welcome}
                    {!topic && <div className="s11-routes" role="group" aria-label="咨询方向">
                        <button className="s11-row" disabled={busy || !ready} onClick={() => browse('app')}><SquaresFour /><span>具体 App</span><ArrowUpRight /></button>
                        <button className="s11-row" disabled={busy || !ready} onClick={() => browse('system')}><BookOpenText /><span>跨 App 系统</span><ArrowUpRight /></button>
                        <button className="s11-row" disabled={busy || !ready} onClick={() => choose({ category: 'community', topic: 'Discord 社区规则' })}><ChatsCircle /><span>社区规则</span><ArrowUpRight /></button>
                    </div>}
                </> : thread.slice(-visibleCount).map(row => <div key={row.id} className={'s11-turn ' + row.role}>
                    {row.role === 'assistant' && <img src={SULLY_HELP_DESK_AVATAR} alt="11 号" />}
                    <div className="s11-bubble" aria-label={row.role === 'user' ? '你' : 'Sully-11'}>
                        {row.attachment && <HelpAttachmentView item={row.attachment} />}
                        {row.content && <p>{row.content}</p>}
                    </div>
                </div>)}
                {stage && <p role="status" className="s11-note">{stage}</p>}
            </div>
            <form className="s11-dock" onSubmit={e => { e.preventDefault(); void run(false); }}>
                {error && <div role="alert" className="s11-error">{error} {!ready && <button type="button" onClick={() => setAttempt(n => n + 1)}>重新读取</button>}{imageFailed && <button type="button" disabled={busy} onClick={() => void run(true, true)}>仅用文字回复</button>}</div>}
                <input type="file" ref={fileInput} hidden accept={helpFileAccept} aria-label="选择附件" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; void selectFile(file); }} />
                {stickers && <HelpStickerPicker onClose={() => setStickers(false)} onPick={item => { setAttachment(item); setStickers(false); setError(''); }} />}
                {attachment && <div className="s11-pending"><HelpAttachmentView item={attachment} /><button type="button" disabled={busy} aria-label="移除待发附件" onClick={() => setAttachment(undefined)}><X /></button></div>}
                {scope.category !== 'community' && <div className="s11-config" role="group" aria-label="询问配置">
                    <div className="s11-config-row">
                        <strong>询问配置：</strong>
                        <div className="s11-config-modes">
                            <button type="button" aria-pressed={!charId} disabled={busy || !ready} onClick={() => selectConfig('')}>所有角色</button>
                            <button type="button" aria-pressed={!!charId} disabled={busy || !ready || !os.characters.length} onClick={() => { if (!charId && preferredCharacter) selectConfig(preferredCharacter.id); }}>指定角色</button>
                        </div>
                        {charId && <select aria-label="选择要询问配置的角色" value={charId} disabled={busy || !ready} onChange={e => selectConfig(e.target.value)}>
                            {!char && <option value={charId}>原角色已移除</option>}
                            {os.characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>}
                    </div>
                    <p>{char ? `查看共用设置和「${char.name}」的角色设置，如记忆宫殿。`
                        : charId ? '原角色已不在当前空间，本次只能查看共用设置。'
                        : '只查看所有角色共用的设置，如主 API、自动回复。'}</p>
                </div>}
                <div className="s11-meta">
                    <div className="s11-tools"><button type="button" disabled={busy || !ready} onClick={() => fileInput.current?.click()}><Paperclip />附件</button>
                        <button type="button" disabled={busy || !ready} aria-expanded={stickers} onClick={() => setStickers(s => !s)}><Smiley />表情包</button></div>
                </div>
                <div className="s11-inputline">
                    <textarea aria-label="你的糯米机问题" placeholder="描述你遇到的问题…" rows={1} maxLength={HELP_QUESTION_LIMIT} value={draft} onChange={e => setDraft(e.target.value)} disabled={busy || !ready}
                        onKeyDown={e => {
                            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                            e.preventDefault();
                            if (!e.repeat) e.currentTarget.form?.requestSubmit();
                        }} />
                    <button className="s11-send" type="submit" aria-label={attachment ? '发送附件' : '发送文字'} title="发送消息" disabled={busy || !ready || (!draft.trim() && !attachment)}><PaperPlaneTilt weight="fill" /></button>
                    <button className="s11-generate" type="button" aria-label="生成回复" title="让 11 号回复已发送的消息" disabled={busy || !ready || !configured || last?.role !== 'user'} onClick={() => void run(true)}><Lightning weight="fill" /></button>
                </div>
                <p className="s11-disclosure">{!configured ? '生成前请在设置中配置对话 API' : last?.role === 'user'
                    ? '点闪电回复时，你的 API 会收到相关对话、附件、手册和' + (scope.category === 'community' ? '社区规则。' : '设置摘要。')
                    : 'Enter 或纸飞机发送 · Shift + Enter 换行 · 闪电回复'}{(pendingImages || attachment?.kind === 'image') && (os.apiConfig.visionApi?.enabled ? ' 图片由独立识图 API 读取。' : ' 图片需要支持识图的对话模型。')}</p>
            </form>
        </>}
    </section>;
}
