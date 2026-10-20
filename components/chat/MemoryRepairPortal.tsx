import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    EyeSlash,
    FloppyDisk,
    LinkSimple,
    MagnifyingGlass,
    PaperPlaneTilt,
    PencilSimple,
    Sparkle,
    X,
} from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile, UserProfile } from '../../types';
import { useBlobRefUrl } from '../../utils/blobRef';
import {
    diagnoseRecallIssue,
    formatRepairMemoryDate,
    getMemoryGuideCopy,
    loadRecallRepairSnapshot,
    patchRecallMemory,
    searchEditableMemories,
    type RecallRepairSnapshot,
    type RepairNode,
} from '../../utils/memoryPalace/memoryRepair';
import { getRoomLabel, type EmbeddingConfig, type RemoteVectorConfig } from '../../utils/memoryPalace/types';

const SKIP_ANIMATION_KEY = 'os_memory_repair_skip_animation';

type EditorTarget =
    | { type: 'node'; id: string }
    | { type: 'box'; id: string }
    | null;

interface MemoryRepairPortalProps {
    inline?: boolean;
    char: CharacterProfile;
    user: UserProfile;
    apiConfig: APIConfig;
    embeddingConfig: EmbeddingConfig;
    remoteVectorConfig?: RemoteVectorConfig;
    sinceTs: number;
    userMessage?: string;
    assistantReply?: string;
    onClose: () => void;
}

function readSkipAnimation(): boolean {
    try {
        return localStorage.getItem(SKIP_ANIMATION_KEY) === '1';
    } catch {
        return false;
    }
}

function nodeKindLabel(item: RepairNode): string {
    if (item.kind === 'summary') return '整合回忆';
    if (item.kind === 'archived') return '旧细节（已合入总结）';
    if (item.kind === 'live') return '近期片段';
    return '独立记忆';
}

function boxDateLabel(nodes: RepairNode[]): string {
    if (nodes.length === 0) return '日期不详';
    const timestamps = nodes
        .filter(item => item.kind !== 'summary')
        .map(item => item.node.createdAt)
        .filter(value => Number.isFinite(value))
        .sort((a, b) => a - b);
    const source = timestamps.length > 0
        ? timestamps
        : nodes.map(item => item.node.createdAt).filter(value => Number.isFinite(value));
    if (source.length === 0) return '日期不详';
    const first = formatRepairMemoryDate(source[0]);
    const last = formatRepairMemoryDate(source[source.length - 1]);
    return first === last ? first : `${first} — ${last}`;
}

const MemoryRepairPortal: React.FC<MemoryRepairPortalProps> = ({
    inline=false,
    char,
    user,
    apiConfig,
    embeddingConfig,
    remoteVectorConfig,
    sinceTs,
    userMessage,
    assistantReply,
    onClose,
}) => {
    const roomChibi = useBlobRefUrl(char.sprites?.chibi);
    const guideCopy = useMemo(
        () => getMemoryGuideCopy(char, user.name || '你'),
        [char, user.name],
    );
    const [skipAnimation, setSkipAnimation] = useState(readSkipAnimation);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [snapshot, setSnapshot] = useState<RecallRepairSnapshot | null>(null);
    const [loading, setLoading] = useState(true);
    const [revealed, setRevealed] = useState(skipAnimation);
    const [editorTarget, setEditorTarget] = useState<EditorTarget>(null);
    const [concern, setConcern] = useState('');
    const [diagnosing, setDiagnosing] = useState(false);
    const [dialogue, setDialogue] = useState<Array<{ role: 'user' | 'guide'; text: string }>>([]);
    const [suspectIds, setSuspectIds] = useState<string[]>([]);
    const [reasons, setReasons] = useState<Record<string, string>>({});
    const [notice, setNotice] = useState('');
    const [farewell, setFarewell] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<RepairNode[]>([]);
    const [searching, setSearching] = useState(false);

    useEffect(() => {
        let alive = true;
        setLoading(true);
        loadRecallRepairSnapshot(char.id, sinceTs)
            .then(result => {
                if (alive) setSnapshot(result);
            })
            .catch(error => {
                if (alive) setNotice(error?.message || '没能打开这次召回留下的痕迹');
            })
            .finally(() => {
                if (alive) setLoading(false);
            });
        return () => { alive = false; };
    }, [char.id, sinceTs]);

    useEffect(() => {
        if (skipAnimation) {
            setRevealed(true);
            return;
        }
        const timer = window.setTimeout(() => setRevealed(true), 950);
        return () => window.clearTimeout(timer);
    }, [skipAnimation]);

    useEffect(() => {
        const query = searchQuery.trim();
        if (!query) {
            setSearchResults([]);
            setSearching(false);
            return;
        }
        let alive = true;
        setSearching(true);
        const timer = window.setTimeout(() => {
            searchEditableMemories(
                char.id,
                query,
                snapshot?.receipt?.ids || [],
            )
                .then(results => {
                    if (alive) setSearchResults(results);
                })
                .catch(error => {
                    if (alive) setNotice(error?.message || '没有搜到这片记忆');
                })
                .finally(() => {
                    if (alive) setSearching(false);
                });
        }, 160);
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
    }, [char.id, searchQuery, snapshot?.receipt?.ts]);

    const allNodeCount = (snapshot?.standalone.length || 0)
        + (snapshot?.boxes.reduce((sum, group) => sum + group.nodes.length, 0) || 0);
    const recalledCount = snapshot?.receipt?.ids.length || 0;
    const searchActive = searchQuery.trim().length > 0;

    const toggleSkipAnimation = () => {
        const next = !skipAnimation;
        setSkipAnimation(next);
        setRevealed(true);
        try {
            localStorage.setItem(SKIP_ANIMATION_KEY, next ? '1' : '0');
        } catch {}
    };

    const replaceNode = useCallback((updated: RepairNode['node']) => {
        setSnapshot(current => {
            if (!current) return current;
            return {
                ...current,
                standalone: current.standalone.map(item =>
                    item.node.id === updated.id ? { ...item, node: updated } : item
                ),
                boxes: current.boxes.map(group => ({
                    ...group,
                    nodes: group.nodes.map(item =>
                        item.node.id === updated.id ? { ...item, node: updated } : item
                    ),
                })),
            };
        });
        setSearchResults(current => current.map(item =>
            item.node.id === updated.id ? { ...item, node: updated } : item
        ));
    }, []);

    const saveNode = async (item: RepairNode, content: string) => {
        setNotice('');
        const updated = await patchRecallMemory(
            item.node.id,
            content,
            embeddingConfig,
            remoteVectorConfig,
        );
        replaceNode(updated);
        setNotice('修改已保存，下次聊到相关话题时会按新内容回忆。');
    };

    const submitConcern = async () => {
        const text = concern.trim();
        if (!text || !snapshot || diagnosing) return;
        setDialogue(items => [...items, { role: 'user', text }]);
        setConcern('');
        setDiagnosing(true);
        setNotice('');
        try {
            const result = await diagnoseRecallIssue({
                char,
                user,
                apiConfig,
                snapshot,
                userConcern: text,
                userMessage,
                assistantReply,
            });
            setDialogue(items => [...items, { role: 'guide', text: result.reply }]);
            setSuspectIds(result.suspectIds);
            setReasons(result.reasons);
        } catch (error: any) {
            setDialogue(items => [
                ...items,
                { role: 'guide', text: `我没能完成这次核对：${error?.message || '请求失败'}` },
            ]);
        } finally {
            setDiagnosing(false);
        }
    };

    const openNode = (id: string) => setEditorTarget({ type: 'node', id });
    const openSuspect = (id: string) => {
        const group = snapshot?.boxes.find(box => box.nodes.some(item => item.node.id === id));
        setEditorTarget(group ? { type: 'box', id: group.box.id } : { type: 'node', id });
    };

    const finish = () => {
        setFarewell(true);
        window.setTimeout(onClose, skipAnimation ? 280 : 1900);
    };

    const editorNode = editorTarget?.type === 'node'
        ? snapshot?.standalone.find(item => item.node.id === editorTarget.id)
            || snapshot?.boxes.flatMap(group => group.nodes).find(item => item.node.id === editorTarget.id)
            || searchResults.find(item => item.node.id === editorTarget.id)
        : undefined;
    const editorBox = editorTarget?.type === 'box'
        ? snapshot?.boxes.find(group => group.box.id === editorTarget.id)
        : undefined;

    const portal = (
        <div className={`memory-repair-root ${farewell ? 'is-farewell' : ''}`}>
            <style>{`
                .memory-repair-root {
                    --ink: #f5efff;
                    --muted: rgba(229, 218, 247, .62);
                    --line: rgba(207, 181, 255, .18);
                    position: fixed; inset: 0; z-index: 1600;
                    overflow: hidden; color: var(--ink);
                    background:
                        radial-gradient(circle at 50% 18%, rgba(161, 123, 220, .22), transparent 27rem),
                        radial-gradient(circle at 12% 90%, rgba(89, 119, 158, .18), transparent 30rem),
                        linear-gradient(155deg, #171422 0%, #0c0c15 58%, #11131b 100%);
                    font-family: ui-serif, "Songti SC", "Noto Serif SC", serif;
                    animation: memoryRepairEnter .55s ease both;
                }
                .memory-repair-root::before {
                    content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .34;
                    background-image: radial-gradient(rgba(255,255,255,.28) .6px, transparent .6px);
                    background-size: 23px 23px;
                    mask-image: linear-gradient(to bottom, black, transparent 75%);
                }
                .memory-repair-scroll { position: relative; height: 100%; overflow-y: auto; overscroll-behavior: contain; }
                .memory-repair-shell { width: min(760px, 100%); min-height: 100%; margin: 0 auto; padding: 76px 22px 140px; }
                .memory-guide-orbit {
                    width: 156px; height: 156px; margin: 8px auto 22px; position: relative;
                    display: grid; place-items: center;
                }
                .memory-guide-orbit::before, .memory-guide-orbit::after {
                    content: ""; position: absolute; border-radius: 999px; inset: 16px;
                    border: 1px solid rgba(216, 193, 255, .22);
                    animation: memoryOrbit 8s linear infinite;
                }
                .memory-guide-orbit::after { inset: 0; border-style: dashed; animation-duration: 14s; animation-direction: reverse; }
                .memory-guide-image {
                    max-width: 126px; max-height: 126px; object-fit: contain;
                    filter: drop-shadow(0 12px 28px rgba(152, 114, 222, .3));
                    animation: memoryFloat 4.8s ease-in-out infinite;
                }
                .memory-guide-light {
                    width: 38px; height: 38px; border-radius: 999px;
                    background: #fff8df;
                    box-shadow: 0 0 18px #fff2bc, 0 0 48px rgba(199,160,255,.9), 0 0 96px rgba(128,107,201,.65);
                    animation: memoryBreathe 3.2s ease-in-out infinite;
                }
                .memory-guide-name { text-align: center; letter-spacing: .32em; font-size: 12px; color: rgba(238,228,255,.55); }
                .memory-guide-line {
                    max-width: 540px; margin: 14px auto 42px; text-align: center;
                    font-size: clamp(16px, 4vw, 20px); line-height: 1.9; letter-spacing: .04em;
                    text-wrap: balance; animation: memoryTextIn .9s .2s ease both;
                }
                .memory-trail { position: relative; max-width: 660px; margin: 0 auto; padding-left: 28px; }
                .memory-trail::before {
                    content: ""; position: absolute; left: 7px; top: 11px; bottom: 8px; width: 1px;
                    background: linear-gradient(to bottom, rgba(225,205,255,.55), rgba(225,205,255,.04));
                }
                .memory-trail-title { color: var(--muted); font-size: 13px; letter-spacing: .12em; margin-bottom: 18px; }
                .memory-search {
                    position: relative; margin: 0 0 10px;
                }
                .memory-search svg {
                    position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
                    color: rgba(222,203,255,.48); pointer-events: none;
                }
                .memory-search input {
                    width: 100%; min-height: 42px; padding: 0 40px;
                    color: #f7f0ff; border: 1px solid rgba(226,205,255,.13); border-radius: 14px;
                    outline: none; background: rgba(255,255,255,.035);
                    font: 13px/1 ui-sans-serif, system-ui;
                    transition: border-color .2s ease, background .2s ease;
                }
                .memory-search input:focus {
                    border-color: rgba(218,185,255,.42); background: rgba(255,255,255,.055);
                }
                .memory-search input::placeholder { color: rgba(235,225,248,.34); }
                .memory-search-clear {
                    position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
                    width: 30px; height: 30px; display: grid; place-items: center;
                    color: rgba(235,225,248,.45); border: 0; background: transparent;
                }
                .memory-search-status {
                    min-height: 24px; padding: 4px 8px 3px;
                    color: rgba(229,218,247,.46); font: 11px/1.5 ui-sans-serif, system-ui;
                }
                .memory-strip {
                    position: relative; width: 100%; text-align: left; color: inherit; border: 0;
                    border-bottom: 1px solid var(--line); background: transparent;
                    padding: 17px 8px 17px 12px; opacity: 0; transform: translateY(14px);
                    transition: background .25s ease, border-color .25s ease, opacity .7s ease, transform .7s ease;
                }
                .memory-strip.is-revealed { opacity: 1; transform: translateY(0); }
                .memory-strip::before {
                    content: ""; position: absolute; left: -25px; top: 25px; width: 9px; height: 9px;
                    border-radius: 50%; background: #d7c0ff; box-shadow: 0 0 16px rgba(205,178,255,.72);
                }
                .memory-strip:hover, .memory-strip.is-suspect { background: linear-gradient(90deg, rgba(174,130,236,.12), transparent); border-color: rgba(232,211,255,.38); }
                .memory-strip.is-suspect::before { background: #ffd69b; box-shadow: 0 0 18px rgba(255,194,111,.9); }
                .memory-strip-kicker { display: flex; gap: 8px; align-items: center; margin-bottom: 7px; font: 600 11px/1.2 ui-sans-serif, system-ui; color: rgba(222,203,255,.63); letter-spacing: .08em; }
                .memory-strip-copy { font-size: 15px; line-height: 1.7; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
                .memory-suspect-reason { margin-top: 9px; color: #ffdca8; font: 12px/1.6 ui-sans-serif, system-ui; }
                .memory-actions {
                    position: fixed; z-index: 5; left: 50%; bottom: max(22px, env(safe-area-inset-bottom));
                    transform: translateX(-50%); width: min(660px, calc(100% - 32px));
                    display: flex; gap: 10px; padding: 10px;
                    border: 1px solid rgba(222,201,255,.16); border-radius: 22px;
                    background: rgba(19,17,29,.76); backdrop-filter: blur(20px);
                    box-shadow: 0 18px 70px rgba(0,0,0,.38);
                }
                .memory-action-primary, .memory-action-quiet {
                    min-height: 46px; border-radius: 15px; padding: 0 18px; border: 1px solid transparent;
                    font: 600 13px/1 ui-sans-serif, system-ui; transition: transform .2s ease, background .2s ease;
                }
                .memory-action-primary { flex: 1; color: #1b1228; background: linear-gradient(135deg, #f6e9ff, #d5b7ff); }
                .memory-action-quiet { color: #eee4ff; background: rgba(255,255,255,.055); border-color: rgba(255,255,255,.08); }
                .memory-action-primary:active, .memory-action-quiet:active { transform: scale(.98); }
                .memory-top {
                    position: fixed; inset: max(14px, env(safe-area-inset-top)) 16px auto; z-index: 8;
                    display: flex; justify-content: space-between; align-items: center; pointer-events: none;
                }
                .memory-top button { pointer-events: auto; }
                .memory-icon-btn {
                    width: 42px; height: 42px; display: grid; place-items: center; border-radius: 50%;
                    color: #eee5fb; border: 1px solid rgba(255,255,255,.1); background: rgba(14,13,22,.58); backdrop-filter: blur(18px);
                }
                .memory-settings {
                    position: fixed; right: 16px; top: 64px; z-index: 12; width: 230px; padding: 14px;
                    border: 1px solid rgba(255,255,255,.1); border-radius: 16px; background: rgba(23,20,34,.94);
                    box-shadow: 0 18px 54px rgba(0,0,0,.4); font: 13px/1.5 ui-sans-serif, system-ui;
                }
                .memory-drawer {
                    position: fixed; z-index: 20; inset: 0; background: rgba(4,4,9,.54); backdrop-filter: blur(8px);
                    display: flex; align-items: flex-end; animation: memoryVeilIn .25s ease both;
                }
                .memory-drawer-sheet {
                    width: min(760px, 100%); max-height: min(82vh, 820px); margin: 0 auto;
                    overflow-y: auto; border-radius: 30px 30px 0 0; padding: 20px 20px max(28px, env(safe-area-inset-bottom));
                    border: 1px solid rgba(228,210,255,.14);
                    background: linear-gradient(170deg, rgba(39,32,52,.98), rgba(17,16,25,.99));
                    box-shadow: 0 -22px 80px rgba(0,0,0,.48); animation: memorySheetIn .42s cubic-bezier(.2,.8,.2,1) both;
                }
                .memory-editor {
                    padding: 16px 0 20px; border-bottom: 1px solid rgba(255,255,255,.08);
                }
                .memory-editor textarea, .memory-dialogue textarea {
                    width: 100%; resize: vertical; color: #f8f2ff; border-radius: 15px;
                    border: 1px solid rgba(226,205,255,.16); outline: none; background: rgba(255,255,255,.045);
                    padding: 14px; font: 14px/1.7 ui-sans-serif, system-ui;
                }
                .memory-editor textarea:focus, .memory-dialogue textarea:focus { border-color: rgba(218,185,255,.5); }
                .memory-dialogue-log { display: grid; gap: 11px; margin: 18px 0; }
                .memory-dialogue-bubble { max-width: 87%; padding: 11px 14px; border-radius: 17px; font: 13px/1.65 ui-sans-serif, system-ui; }
                .memory-dialogue-bubble.user { margin-left: auto; color: #251a31; background: #dec9f7; border-bottom-right-radius: 5px; }
                .memory-dialogue-bubble.guide { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.08); border-bottom-left-radius: 5px; }
                .memory-empty { padding: 32px 0; text-align: center; color: var(--muted); line-height: 1.8; }
                .memory-notice {
                    position: fixed; z-index: 30; top: 70px; left: 50%; transform: translateX(-50%);
                    width: min(520px, calc(100% - 42px)); padding: 10px 14px; text-align: center;
                    color: #f8edff; border: 1px solid rgba(237,215,255,.16); border-radius: 14px;
                    background: rgba(32,26,43,.92); font: 12px/1.5 ui-sans-serif, system-ui;
                }
                .memory-farewell {
                    position: fixed; z-index: 40; inset: 0; display: grid; place-items: center;
                    padding: 30px; text-align: center; background: rgba(10,9,16,.9);
                    font-size: clamp(18px, 5vw, 25px); line-height: 1.9; letter-spacing: .08em;
                    animation: memoryFarewell 1.8s ease both;
                }
                .memory-farewell-copy { display: grid; gap: 8px; }
                .memory-farewell-line {
                    opacity: 0; transform: translateY(7px);
                    animation: memoryFarewellLine .48s ease forwards;
                }
                .memory-farewell-line:first-child {
                    color: rgba(239,228,255,.72); font-size: .78em; letter-spacing: .14em;
                    animation-delay: .18s;
                }
                .memory-farewell-line:last-child { animation-delay: .68s; }
                .memory-repair-root.is-farewell > :not(.memory-farewell) { animation: memoryDissolve .8s ease both; }
                @keyframes memoryRepairEnter { from { opacity: 0; } to { opacity: 1; } }
                @keyframes memoryTextIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
                @keyframes memoryFloat { 0%,100% { transform: translateY(3px); } 50% { transform: translateY(-7px); } }
                @keyframes memoryBreathe { 0%,100% { transform: scale(.88); opacity: .72; } 50% { transform: scale(1.08); opacity: 1; } }
                @keyframes memoryOrbit { to { transform: rotate(360deg); } }
                @keyframes memoryVeilIn { from { opacity: 0; } to { opacity: 1; } }
                @keyframes memorySheetIn { from { transform: translateY(100%); } to { transform: translateY(0); } }
                @keyframes memoryDissolve { to { opacity: 0; filter: blur(12px); transform: scale(1.015); } }
                @keyframes memoryFarewell { 0% { opacity: 0; letter-spacing: .02em; } 35%,75% { opacity: 1; } 100% { opacity: 0; letter-spacing: .14em; } }
                @keyframes memoryFarewellLine { to { opacity: 1; transform: translateY(0); } }
                @media (prefers-reduced-motion: reduce) {
                    .memory-repair-root *, .memory-repair-root *::before, .memory-repair-root *::after {
                        animation-duration: .01ms !important; animation-iteration-count: 1 !important;
                        transition-duration: .01ms !important;
                    }
                }
            `}</style>

            <div className="memory-top">
                <button className="memory-icon-btn" onClick={onClose} aria-label="离开记忆链接">
                    <X size={19} />
                </button>
                <div className="flex items-center gap-2">
                    <span className="text-[11px] tracking-[.18em] text-white/45">记忆链接</span>
                    <button className="memory-icon-btn" onClick={() => setSettingsOpen(value => !value)} aria-label="显影设置">
                        <EyeSlash size={18} />
                    </button>
                </div>
            </div>

            {settingsOpen && (
                <div className="memory-settings">
                    <button className="w-full flex items-center justify-between gap-4 text-left" onClick={toggleSkipAnimation}>
                        <span>
                            <b className="block text-white/90 mb-1">跳过显影动画</b>
                            <span className="text-white/45 text-xs">以后进入时直接看见召回痕迹</span>
                        </span>
                        <span className={`w-10 h-6 rounded-full p-1 transition-colors ${skipAnimation ? 'bg-violet-400' : 'bg-white/15'}`}>
                            <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${skipAnimation ? 'translate-x-4' : ''}`} />
                        </span>
                    </button>
                </div>
            )}

            {notice && <button className="memory-notice" onClick={() => setNotice('')}>{notice}</button>}

            <div className="memory-repair-scroll">
                <main className="memory-repair-shell">
                    <div className="memory-guide-orbit" aria-label={roomChibi ? `${char.name}的小屋 Chibi` : '一枚未知光点'}>
                        {roomChibi
                            ? <img className="memory-guide-image" src={roomChibi} alt="" />
                            : <div className="memory-guide-light" />}
                    </div>
                    <div className="memory-guide-name">？？？</div>
                    <p className="memory-guide-line">{guideCopy.greeting}</p>

                    <section className="memory-trail">
                        <div className="memory-trail-title">
                            {loading ? '正在辨认刚才的脚印……' : snapshot?.receipt ? guideCopy.trail : guideCopy.empty}
                        </div>

                        {!loading && (
                            <div className="memory-search">
                                <MagnifyingGlass size={16} />
                                <input
                                    type="search"
                                    value={searchQuery}
                                    onChange={event => setSearchQuery(event.target.value)}
                                    placeholder={`模糊搜索 ${char.name} 的记忆、日期或标签`}
                                    aria-label="模糊搜索可修改的记忆"
                                />
                                {searchActive && (
                                    <button
                                        className="memory-search-clear"
                                        onClick={() => setSearchQuery('')}
                                        aria-label="清空记忆搜索"
                                    >
                                        <X size={14} />
                                    </button>
                                )}
                            </div>
                        )}

                        {!loading && searchActive && (
                            <>
                                <div className="memory-search-status">
                                    {searching
                                        ? '正在记忆库里寻找相近的痕迹……'
                                        : `找到 ${searchResults.length} 条可修改的记忆 · 仅本地搜索`}
                                </div>
                                {!searching && searchResults.map(item => (
                                    <button
                                        key={item.node.id}
                                        className={`memory-strip is-revealed ${suspectIds.includes(item.node.id) ? 'is-suspect' : ''}`}
                                        onClick={() => openNode(item.node.id)}
                                    >
                                        <div className="memory-strip-kicker">
                                            <span>{nodeKindLabel(item)}</span>
                                            <span>·</span>
                                            <span>{formatRepairMemoryDate(item.node.createdAt)}</span>
                                            <span>·</span>
                                            <span>{getRoomLabel(item.node.room, user.name)}</span>
                                            {item.recalled && <span>刚才用到了这条</span>}
                                            {item.kind === 'archived' && <span>已合入总结 · 刚才没直接读</span>}
                                        </div>
                                        <div className="memory-strip-copy">{item.node.content}</div>
                                    </button>
                                ))}
                                {!searching && searchResults.length === 0 && (
                                    <div className="memory-empty">
                                        没有找到相近的记忆。可以少写几个字，或换一个日期、名字、地点试试。
                                    </div>
                                )}
                            </>
                        )}

                        {!loading && !searchActive && snapshot?.receipt && (
                            <>
                                {snapshot.standalone.map((item, index) => (
                                    <button
                                        key={item.node.id}
                                        className={`memory-strip ${revealed ? 'is-revealed' : ''} ${suspectIds.includes(item.node.id) ? 'is-suspect' : ''}`}
                                        style={{ transitionDelay: skipAnimation ? '0ms' : `${index * 120}ms` }}
                                        onClick={() => openNode(item.node.id)}
                                    >
                                        <div className="memory-strip-kicker">
                                            <span>独立记忆</span>
                                            <span>·</span>
                                            <span>{formatRepairMemoryDate(item.node.createdAt)}</span>
                                            <span>·</span>
                                            <span>{getRoomLabel(item.node.room, user.name)}</span>
                                            {suspectIds.includes(item.node.id) && <span>可能有关</span>}
                                        </div>
                                        <div className="memory-strip-copy">{item.node.content}</div>
                                        {reasons[item.node.id] && <div className="memory-suspect-reason">{reasons[item.node.id]}</div>}
                                    </button>
                                ))}
                                {snapshot.boxes.map((group, groupIndex) => {
                                    const hitSuspects = group.nodes.filter(item => suspectIds.includes(item.node.id));
                                    return (
                                        <button
                                            key={group.box.id}
                                            className={`memory-strip ${revealed ? 'is-revealed' : ''} ${hitSuspects.length ? 'is-suspect' : ''}`}
                                            style={{ transitionDelay: skipAnimation ? '0ms' : `${(snapshot.standalone.length + groupIndex) * 120}ms` }}
                                            onClick={() => setEditorTarget({ type: 'box', id: group.box.id })}
                                        >
                                            <div className="memory-strip-kicker">
                                                <span>事件盒</span><span>·</span>
                                                <span>{boxDateLabel(group.nodes)}</span><span>·</span>
                                                <span>刚才用到了其中 {group.recalledNodeIds.length} 条</span><span>·</span>
                                                <span>共 {group.nodes.length} 条相关记录</span>
                                            </div>
                                            <div className="memory-strip-copy">「{group.box.name}」</div>
                                            {hitSuspects.length > 0 && (
                                                <div className="memory-suspect-reason">
                                                    ？？？标出了 {hitSuspects.length} 处可能影响刚才回复的内容
                                                </div>
                                            )}
                                        </button>
                                    );
                                })}
                            </>
                        )}

                        {!loading && !searchActive && (!snapshot?.receipt || allNodeCount === 0) && (
                            <div className="memory-empty">
                                <Sparkle size={20} className="mx-auto mb-3 opacity-50" />
                                这里没有可以修改的召回记忆。<br />
                                刚才的问题可能来自模型理解或普通聊天上下文。
                            </div>
                        )}
                    </section>
                </main>
            </div>

            <div className="memory-actions">
                <button
                    className="memory-action-quiet flex items-center justify-center gap-2"
                    onClick={() => setEditorTarget({ type: 'box', id: '__dialogue__' })}
                    disabled={!snapshot?.receipt || allNodeCount === 0}
                >
                    <LinkSimple size={17} />
                    和？？？说
                </button>
                <button className="memory-action-primary" onClick={finish}>
                    完成修补
                </button>
            </div>

            {editorTarget && (
                <div className="memory-drawer" onMouseDown={event => {
                    if (event.target === event.currentTarget) setEditorTarget(null);
                }}>
                    <div className="memory-drawer-sheet">
                        <div className="flex items-start justify-between gap-4 mb-3">
                            <div>
                                <div className="text-[11px] uppercase tracking-[.18em] text-violet-200/45 mb-2">
                                    {editorTarget.id === '__dialogue__' ? '核对记忆' : '直接修改'}
                                </div>
                                <h2 className="text-xl leading-tight">
                                    {editorTarget.id === '__dialogue__'
                                        ? '告诉我，刚才哪里不对劲？'
                                        : editorBox
                                            ? `事件盒「${editorBox.box.name}」`
                                            : '修改这条记忆'}
                                </h2>
                                {editorBox && (
                                    <p className="mt-2 text-xs leading-6 text-white/45">
                                        这里列出了这件事的总括和全部 {editorBox.nodes.length} 条前后经过（按日期排列）。
                                        任意一条都可以直接修改，保存后立即生效。
                                    </p>
                                )}
                            </div>
                            <button className="memory-icon-btn shrink-0" onClick={() => setEditorTarget(null)}>
                                <X size={18} />
                            </button>
                        </div>

                        {editorTarget.id === '__dialogue__' ? (
                            <div className="memory-dialogue">
                                {(userMessage || assistantReply) && (
                                    <details className="mb-4 text-xs text-white/45">
                                        <summary className="cursor-pointer select-none">查看刚才这一轮对话</summary>
                                        <div className="mt-3 pl-3 border-l border-white/10 space-y-2 leading-6">
                                            {userMessage && <p><b className="text-white/65">你：</b>{userMessage}</p>}
                                            {assistantReply && <p><b className="text-white/65">{char.name}：</b>{assistantReply}</p>}
                                        </div>
                                    </details>
                                )}
                                <div className="memory-dialogue-log">
                                    {dialogue.map((item, index) => (
                                        <div key={index} className={`memory-dialogue-bubble ${item.role}`}>
                                            {item.role === 'guide' && <div className="text-[10px] tracking-[.2em] text-white/40 mb-1">？？？</div>}
                                            {item.text}
                                        </div>
                                    ))}
                                    {diagnosing && (
                                        <div className="memory-dialogue-bubble guide">
                                            <div className="text-[10px] tracking-[.2em] text-white/40 mb-1">？？？</div>
                                            我在逐条对照刚才经过的记忆……
                                        </div>
                                    )}
                                </div>
                                {suspectIds.length > 0 && (
                                    <div className="mb-4">
                                        <div className="text-xs text-amber-100/65 mb-2">可能需要核对</div>
                                        <div className="flex flex-wrap gap-2">
                                            {suspectIds.map((id, index) => (
                                                <button
                                                    key={id}
                                                    onClick={() => openSuspect(id)}
                                                    className="px-3 py-2 rounded-full bg-amber-200/10 border border-amber-100/15 text-xs text-amber-50"
                                                >
                                                    线索 {index + 1} · 去修改
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                <div className="relative">
                                    <textarea
                                        rows={4}
                                        value={concern}
                                        onChange={event => setConcern(event.target.value)}
                                        placeholder="比如：ta 把旅行地点说错了；这件事其实发生在另一个人身上……"
                                    />
                                    <button
                                        onClick={submitConcern}
                                        disabled={!concern.trim() || diagnosing}
                                        className="absolute right-3 bottom-3 w-10 h-10 rounded-full grid place-items-center bg-violet-200 text-violet-950 disabled:opacity-35"
                                    >
                                        <PaperPlaneTilt size={17} weight="fill" />
                                    </button>
                                </div>
                                <p className="mt-3 text-[11px] leading-5 text-white/35">
                                    ？？？在这里只对照角色基础设定和上面列出的这几条记忆帮你排查，不会再去翻其它记忆或聊天记录。
                                </p>
                            </div>
                        ) : editorNode ? (
                            <NodeEditor item={editorNode} reason={reasons[editorNode.node.id]} onSave={saveNode} />
                        ) : editorBox ? (
                            <div>
                                {editorBox.nodes.map(item => (
                                    <NodeEditor
                                        key={item.node.id}
                                        item={item}
                                        reason={reasons[item.node.id]}
                                        onSave={saveNode}
                                    />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
            )}

            {farewell && (
                <div className="memory-farewell">
                    <div className="memory-farewell-copy">
                        <span className="memory-farewell-line">谢谢你</span>
                        <span className="memory-farewell-line">这次【我】会好好记得——</span>
                    </div>
                </div>
            )}
        </div>
    );

    return inline?portal:createPortal(portal, document.body);
};

const NodeEditor: React.FC<{
    item: RepairNode;
    reason?: string;
    onSave: (item: RepairNode, content: string) => Promise<void>;
}> = ({ item, reason, onSave }) => {
    const [content, setContent] = useState(item.node.content);
    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const dirty = content.trim() !== item.node.content.trim();

    useEffect(() => setContent(item.node.content), [item.node.content]);

    const save = async () => {
        if (!dirty || saving) return;
        setSaving(true);
        setError('');
        try {
            await onSave(item, content);
            setEditing(false);
        } catch (cause: any) {
            setError(cause?.message || '保存失败');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="memory-editor">
            <div className="flex items-center justify-between gap-3 mb-3">
                <div className="flex items-center gap-2 text-[11px] tracking-[.08em] text-white/45">
                    <span>{nodeKindLabel(item)}</span>
                    <span>·</span>
                    <span>{formatRepairMemoryDate(item.node.createdAt)}</span>
                    <span>·</span>
                    <span>{getRoomLabel(item.node.room)}</span>
                    {item.recalled && <span className="text-violet-200/75">刚才用到了这条</span>}
                    {item.kind === 'archived' && <span className="text-white/35">已合入总结 · 刚才没直接读</span>}
                    {!item.recalled && item.kind !== 'archived' && <span className="text-white/35">同事件顺带列出 · 刚才没直接读</span>}
                </div>
                {!editing && (
                    <button
                        className="flex items-center gap-1.5 text-xs text-violet-100/75"
                        onClick={() => setEditing(true)}
                    >
                        <PencilSimple size={14} /> 修改
                    </button>
                )}
            </div>
            {reason && <div className="mb-3 text-xs leading-6 text-amber-100/70">？？？：{reason}</div>}
            {editing ? (
                <>
                    <textarea rows={Math.min(12, Math.max(5, Math.ceil(content.length / 34)))} value={content} onChange={event => setContent(event.target.value)} />
                    {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
                    <div className="flex justify-end gap-2 mt-3">
                        <button
                            className="memory-action-quiet"
                            onClick={() => { setContent(item.node.content); setEditing(false); setError(''); }}
                        >
                            取消
                        </button>
                        <button
                            className="memory-action-primary !flex-none flex items-center gap-2"
                            onClick={save}
                            disabled={!dirty || saving || !content.trim()}
                        >
                            {saving ? <Sparkle size={15} className="animate-pulse" /> : <FloppyDisk size={15} />}
                            {saving ? '正在保存…' : '保存修改'}
                        </button>
                    </div>
                </>
            ) : (
                <p className="text-sm leading-7 text-white/82 whitespace-pre-wrap">{item.node.content}</p>
            )}
        </div>
    );
};

export default MemoryRepairPortal;
