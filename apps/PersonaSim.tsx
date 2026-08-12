import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useOS } from '../context/OSContext';
import { DB } from '../utils/db';
import { CharacterProfile, PhoneSimLog, CharacterBuff, UserProfile } from '../types';
import type { SimBeat as Beat, SimBeatKind as BeatKind, SimScript } from '../types';
import { ContextBuilder } from '../utils/context';
import { injectMemoryPalace } from '../utils/memoryPalace/pipeline';
import { isScheduleFeatureOn } from '../utils/scheduleGenerator';
import { safeResponseJson } from '../utils/safeApi';
import { trackEvent } from '../utils/analytics';
import {
    CaretLeft, Play, Pause, FastForward, Lock, MagnifyingGlass, MusicNotes,
    BellRinging, ImageSquare, NotePencil, Globe, CloudSun, ArrowClockwise,
    HourglassMedium, Sparkle, ClockCounterClockwise, X, CaretRight, ArrowRight,
    PaperPlaneTilt, Check,
} from '@phosphor-icons/react';

// ============================================================
//  TYPES (runtime script model) — Beat / SimScript 已移到 types.ts 共享，
//  以便「生活记录」存完整脚本快照用于重播。
// ============================================================
export interface SimApiConfig { apiKey: string; baseUrl: string; model: string; }
export type SimState =
    | { status: 'idle' }
    | { status: 'loading'; mode: 'daily' | 'event'; theme: string }
    | { status: 'ready'; mode: 'daily' | 'event'; theme: string; script: SimScript; replay?: boolean }
    | { status: 'error'; mode: 'daily' | 'event'; theme: string };

interface Props {
    targetChar: CharacterProfile;
    onExit: () => void;
    openLifeLog: () => void;
    sim: SimState;
    onStart: (mode: 'daily' | 'event', theme: string, presence: 'default' | 'light' | 'none', tone: 'mix' | 'depressive' | 'darkhumor' | 'cute') => void;
    onConsumed: () => void;
}

const DAILY = ['平凡的周二', '周末宅家', '深夜失眠', '上班的一天', '放学后的傍晚'];
const EVENTS = ['第一次见到某人', '告白当天', '考试成绩公布', '离职那天', '医院检查结果出来的下午', '一场争吵之后'];

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const ACCENT = '#b89bff';

// ============================================================
//  TYPEWRITER — the soul of screenlife (type → delete → retype)
// ============================================================
const Typewriter: React.FC<{ drafts: string[]; sent?: string | null; className?: string; placeholder?: string }> =
    ({ drafts, sent, className, placeholder }) => {
        const [text, setText] = useState('');
        const [blink, setBlink] = useState(true);
        useEffect(() => {
            let cancelled = false;
            const type = async (s: string) => {
                for (let k = 0; k <= s.length; k++) { if (cancelled) return; setText(s.slice(0, k)); await wait(48); }
            };
            const erase = async (s: string) => {
                for (let k = s.length; k >= 0; k--) { if (cancelled) return; setText(s.slice(0, k)); await wait(26); }
            };
            (async () => {
                for (const d of drafts) {
                    await type(d); if (cancelled) return;
                    await wait(750); if (cancelled) return;
                    await erase(d); if (cancelled) return;
                    await wait(280);
                }
                if (sent != null && sent !== '') { await type(sent); setBlink(false); }
                else setBlink(false);
            })();
            return () => { cancelled = true; };
        }, []);
        return (
            <span className={className}>
                {text || <span className="opacity-30">{placeholder}</span>}
                {blink && <span className="inline-block w-[2px] h-[1em] align-middle ml-0.5 bg-current animate-pulse" />}
            </span>
        );
    };

// ============================================================
//  BACKGROUND GENERATOR (runs at CheckPhone level so it survives navigation)
// ============================================================
export async function generatePersonaScript(opts: {
    char: CharacterProfile; userProfile: UserProfile; apiConfig: SimApiConfig;
    mode: 'daily' | 'event'; theme: string; userPresence?: 'default' | 'light' | 'none';
    tone?: 'mix' | 'depressive' | 'darkhumor' | 'cute';
}): Promise<SimScript> {
    const { char, userProfile, apiConfig, mode, theme, userPresence = 'default', tone = 'mix' } = opts;
    await injectMemoryPalace(char, undefined, theme, userProfile.name);
    const context = ContextBuilder.buildCoreContext(char, userProfile, true, char.memoryPalaceInjection);
    const msgs = await DB.getMessagesByCharId(char.id);
    // 跟随用户为该角色设置的最大上下文（没设则默认 500）——避免「吵完架来看 if 线，结果 char 不记得吵什么」
    const ctxLimit = char.contextLimit && char.contextLimit > 0 ? char.contextLimit : 500;
    const recent = msgs.slice(-ctxLimit).map(m => {
        const who = m.role === 'user' ? userProfile.name : char.name;
        const c = m.type === 'text' ? m.content : `[${m.type}]`;
        return `${who}: ${c}`;
    }).join('\n');
    const firstTs = msgs.find(m => typeof m.timestamp === 'number')?.timestamp;
    const acquaintance = describeAcquaintance(firstTs, userProfile.name, char.name);
    const prompt = buildDirectorPrompt(context, recent, mode, theme, char.name, acquaintance, userProfile.name, userPresence, tone);
    const res = await fetch(`${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiConfig.apiKey}` },
        body: JSON.stringify({ model: apiConfig.model, messages: [{ role: 'user', content: prompt }], temperature: 0.98, max_tokens: 24000 }),
    });
    if (!res.ok) throw new Error('API');
    const data = await safeResponseJson(res);
    // 截断直接报错，不兜底：模型输出被 token 上限截断时 finish_reason 为 'length'
    if (data.choices?.[0]?.finish_reason === 'length') throw new Error('演出生成被截断');
    const rawContent: string = data.choices?.[0]?.message?.content ?? '';
    const parsed = parseScript(rawContent);
    // 诊断友好：把失败原因和原文片段带进报错，方便从「系统调试终端」复制定位
    if (!parsed) {
        const head = rawContent.slice(0, 200).replace(/\s+/g, ' ');
        const tail = rawContent.length > 400 ? ' … ' + rawContent.slice(-200).replace(/\s+/g, ' ') : '';
        // 大括号能配上但解析仍失败 → 多半是字符串里有未转义引号；配不上 → 多半是被截断
        const balanced = rawContent.lastIndexOf('}') > rawContent.indexOf('{') && rawContent.indexOf('{') !== -1;
        const hint = !rawContent.trim() ? '模型返回为空' : balanced ? 'JSON 语法错误(疑似未转义引号)' : '输出不完整/疑似截断';
        throw new Error(`演出解析失败: ${hint} · len=${rawContent.length} · ${head}${tail}`);
    }
    if (!parsed.beats?.length) throw new Error('演出解析失败: 无 beats');
    // 不兜底：结尾必须是模型自己收束好的 end，否则视为不完整/被截断，报错让用户重试
    if (parsed.beats[parsed.beats.length - 1].kind !== 'end') throw new Error('演出结尾不完整');
    return parsed;
}

// ============================================================
//  COMPONENT
// ============================================================
const PersonaSim: React.FC<Props> = ({ targetChar, onExit, openLifeLog, sim, onStart, onConsumed }) => {
    const { updateCharacter, addToast } = useOS();

    const [phase, setPhase] = useState<'idle' | 'play' | 'end'>('idle');
    const [mode, setMode] = useState<'daily' | 'event'>('daily');
    const [theme, setTheme] = useState('');
    const [presence, setPresence] = useState<'default' | 'light' | 'none'>('default');
    const [tone, setTone] = useState<'mix' | 'depressive' | 'darkhumor' | 'cute'>('mix');
    const [script, setScript] = useState<SimScript | null>(null);
    const [idx, setIdx] = useState(0);
    const [autoplay, setAutoplay] = useState(false);
    const [memorySent, setMemorySent] = useState(false);
    const savedRef = useRef(false);
    const ffTimer = useRef<ReturnType<typeof setInterval> | null>(null);

    const beats = script?.beats || [];
    const beat = beats[idx];

    // 图层化：找出「当前可见的屏幕」(lock/app/flashback)，通知/独白叠在它上面弹出，
    // 背景屏幕只在真正切屏时才重新进场 —— 这是去掉「PPT 翻页感」的关键。
    const screenIdx = (() => {
        for (let i = idx; i >= 0; i--) {
            const k = beats[i]?.kind;
            if (k === 'lock' || k === 'app' || k === 'flashback') return i;
        }
        return -1;
    })();
    const screenBeat = screenIdx >= 0 ? beats[screenIdx] : undefined;
    const isOverlay = beat?.kind === 'notification' || beat?.kind === 'thought';

    // ----- kick off background generation (runs in CheckPhone) -----
    const requestStart = (m: 'daily' | 'event', t: string) => {
        const trimmed = t.trim();
        if (!trimmed) { addToast('请选择或输入体验内容', 'error'); return; }
        setMode(m); setTheme(trimmed);
        onStart(m, trimmed, presence, tone);
    };

    // ----- consume a ready script (generated in background) and start playing -----
    useEffect(() => {
        if (phase === 'idle' && sim.status === 'ready') {
            setMode(sim.mode); setTheme(sim.theme);
            // 重播：脚本来自生活记录已存档的快照，别再 persist 一遍（否则生活记录里出现重复）
            setScript(normalizeScript(sim.script)); setIdx(0); savedRef.current = !!sim.replay; setMemorySent(false); setPhase('play');
            onConsumed();
        }
    }, [sim, phase, onConsumed]);

    // ----- persistence on reaching the end -----
    const persist = useCallback(async () => {
        if (savedRef.current || !script) return;
        savedRef.current = true;

        const log: PhoneSimLog = {
            id: `sim-${Date.now()}`,
            mode,
            theme,
            title: script.title || theme,
            summary: script.summary || '',
            ending: script.ending,
            beatsCount: beats.length,
            memoryText: buildMemoryText(script),
            timestamp: Date.now(),
            script,   // 存完整脚本快照 → 生活记录可原样重播
        };

        // emotion buff — only if the schedule feature is on for this character
        const scheduleOn = isScheduleFeatureOn(targetChar);
        const newBuff: CharacterBuff | null = (scheduleOn && script.buff?.label) ? {
            id: `buff_${Date.now()}`,
            name: script.buff.name || `sim_${Date.now()}`,
            label: script.buff.label,
            intensity: (script.buff.intensity && [1, 2, 3].includes(script.buff.intensity) ? script.buff.intensity : 2) as 1 | 2 | 3,
            emoji: script.buff.emoji,
            color: script.buff.color || ACCENT,
            description: script.buff.description,
        } : null;
        if (newBuff) log.buff = { label: newBuff.label, emoji: newBuff.emoji, color: newBuff.color };

        // 关键：基于「最新」角色状态合并，绝不用可能过期的 targetChar 快照整体覆盖 phoneState
        //（否则在异步间隙里别处的写入会把刚存的 simLogs / 其它 phoneState 字段抹掉）。
        let dispatchBuffs: CharacterBuff[] | null = null;
        updateCharacter(targetChar.id, (cur) => {
            const phoneState = {
                ...cur.phoneState,
                records: cur.phoneState?.records || [],
                simLogs: [log, ...(cur.phoneState?.simLogs || [])],
            };
            if (newBuff && script.buff) {
                const existing = (cur.activeBuffs || []).filter(b => b.id !== newBuff.id);
                const nextBuffs = [newBuff, ...existing].slice(0, 4);
                dispatchBuffs = nextBuffs;
                return {
                    activeBuffs: nextBuffs,
                    buffInjection: script.buff.description ? `（${newBuff.emoji || ''}${newBuff.label}）${script.buff.description}` : '',
                    phoneState,
                };
            }
            return { phoneState };
        });
        if (newBuff) {
            // buffs 拿不到就退化成「纯刷新」信号——buffSyncHandler 会从 DB 兜底重读
            window.dispatchEvent(new CustomEvent('emotion-updated',
                dispatchBuffs ? { detail: { charId: targetChar.id, buffs: dispatchBuffs, buffInjection: '' } }
                              : { detail: { charId: targetChar.id } }));
        }
        addToast('已存入生活记录', 'success');
    }, [script, mode, theme, beats.length, targetChar, updateCharacter, addToast]);

    // ----- advance -----
    const advance = useCallback(() => {
        setIdx(i => {
            if (i >= beats.length - 1) return i;
            return i + 1;
        });
    }, [beats.length]);

    useEffect(() => {
        if (phase === 'play' && beat?.kind === 'end') {
            setPhase('end');
            setAutoplay(false);
            persist();
        }
    }, [idx, phase, beat, persist]);

    // ----- autoplay -----
    useEffect(() => {
        if (phase !== 'play' || !autoplay || !beat) return;
        const base = beat.kind === 'flashback' ? 6500 : beat.kind === 'thought' ? 3600 : 3000;
        const delay = base + (beat.pace === 3 ? 3500 : beat.pace === 2 ? 1600 : 0);
        const t = setTimeout(advance, delay);
        return () => clearTimeout(t);
    }, [phase, autoplay, idx, beat, advance]);

    // ----- long-press fast-forward -----
    const startFF = () => {
        if (ffTimer.current) return;
        ffTimer.current = setInterval(advance, 320);
    };
    const stopFF = () => { if (ffTimer.current) { clearInterval(ffTimer.current); ffTimer.current = null; } };
    useEffect(() => () => stopFF(), []);

    const restart = () => {
        // 重看同一场演出不再重复写入「生活记录」(savedRef 保持已保存)
        setIdx(0);
        setPhase('play');
    };

    // 把这场演出作为「真实回忆」发送到聊天 —— 角色会把它当成亲身经历（进入上下文）
    const sendAsMemory = async () => {
        if (!script || memorySent) return;
        const title = script.title || theme;
        const summary = script.summary || '';
        const digest = buildMemoryText(script);
        const content = `【一段亲身经历 · ${title}】\n${digest}${summary ? `\n\n回过头想：${summary}` : ''}`;
        try {
            await DB.saveMessage({
                charId: targetChar.id, role: 'assistant', type: 'sim_card', content,
                metadata: { simCard: { mode, theme, title, summary, ending: script.ending } },
            } as any);
            setMemorySent(true);
            addToast('已作为回忆发送给 TA', 'success');
        } catch (e) {
            console.error(e);
            addToast('发送失败，请重试', 'error');
        }
    };

    const wallpaper = targetChar.dateBackground;

    // ========================================================
    //  RENDER: SELECT
    // ========================================================
    if (phase === 'idle' && (sim.status === 'idle' || sim.status === 'error')) {
        return (
            <Shell wallpaper={wallpaper}>
                <TopBar onBack={onExit} right={
                    <button onClick={() => { openLifeLog(); trackEvent('打开生活记录'); }} className="flex items-center gap-1 text-[11px] text-white/60 active:scale-95 transition">
                        <ClockCounterClockwise size={15} /> 生活记录
                    </button>
                } />
                <div className="flex-1 overflow-y-auto no-scrollbar px-6 pt-2 pb-10">
                    <div className="mb-5">
                        <div className="text-[10px] tracking-[0.35em] uppercase" style={{ color: ACCENT }}>Persona Simulation</div>
                        <h1 className="text-[26px] font-light text-white mt-2 leading-tight" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                            成为 {targetChar.name} 的<br />一段人生
                        </h1>
                    </div>

                    {/* 体验卡 · 中二叠甲：显得很牛逼，同时声明这只是小剧场、不代表角色真实情况 */}
                    <div className="relative rounded-2xl overflow-hidden mb-6 border border-[#b89bff]/25"
                        style={{ background: 'linear-gradient(135deg, rgba(184,155,255,0.16), rgba(184,155,255,0.03))' }}>
                        <div className="absolute left-0 top-0 bottom-0 w-1" style={{ background: ACCENT }} />
                        <div className="absolute -top-8 -right-6 w-28 h-28 rounded-full blur-2xl pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(184,155,255,0.4), transparent 70%)' }} />
                        <div className="relative p-4 pl-5">
                            <div className="flex items-center justify-between mb-2.5">
                                <span className="text-[9px] tracking-[0.28em] uppercase font-bold" style={{ color: ACCENT }}>✦ Experience Ticket · 体验卡</span>
                                <span className="text-[8px] tracking-[0.2em] uppercase text-white/45 border border-white/15 rounded px-1.5 py-0.5">Fiction Only</span>
                            </div>
                            <p className="text-[11.5px] text-white/75 leading-relaxed" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>
                                这是一张通往 TA 的体验卡。我们借这部手机，为你点演一段「<span style={{ color: ACCENT }}>可能发生过</span>」的人生切片——画面、独白与痕迹，皆由此刻的 AI 即兴演绎。
                            </p>
                            <p className="text-[10px] text-white/45 leading-relaxed mt-2.5 pt-2.5 border-t border-dashed border-white/15">
                                ※ 它只是献给你的一出小剧场，是一种「如果」。<br />并不等于角色的真实经历或设定——纵情入戏，散场即忘，无需当真。
                            </p>
                        </div>
                    </div>

                    {/* mode tabs */}
                    <div className="flex gap-2 mb-4 p-1 rounded-2xl bg-white/[0.04] border border-white/[0.06]">
                        {(['daily', 'event'] as const).map(m => (
                            <button key={m} onClick={() => { setMode(m); trackEvent('切换人格模拟类型', { mode: m }); }}
                                className="flex-1 py-2.5 rounded-xl text-[12px] font-semibold transition"
                                style={mode === m ? { background: ACCENT, color: '#1a1530' } : { color: 'rgba(255,255,255,0.5)' }}>
                                {m === 'daily' ? '日常模拟' : '事件模拟'}
                            </button>
                        ))}
                    </div>
                    <p className="text-[11px] text-white/35 mb-4 px-1">
                        {mode === 'daily' ? '体验 TA 某个普通日子的生活 · 生活感与陪伴' : '体验 TA 人生中的某个特殊事件 · 情绪张力'}
                    </p>

                    {/* 你的存在感（这一天里"你"占多少分量） */}
                    <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 px-1">你的存在感</div>
                    <div className="grid grid-cols-3 gap-2 mb-5">
                        {([
                            { id: 'default', label: '默认', desc: '自然出现' },
                            { id: 'light', label: '轻度', desc: '淡淡背景' },
                            { id: 'none', label: '无你', desc: '只有 TA' },
                        ] as const).map(o => {
                            const active = presence === o.id;
                            return (
                                <button key={o.id} onClick={() => { setPresence(o.id); trackEvent('选择你的存在感', { presence: o.id }); }}
                                    className="rounded-2xl py-2.5 border transition active:scale-[0.98] text-center"
                                    style={active
                                        ? { background: ACCENT, color: '#1a1530', borderColor: 'transparent' }
                                        : { background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.8)' }}>
                                    <div className="text-[12.5px] font-semibold">{o.label}</div>
                                    <div className={`text-[9px] mt-0.5 ${active ? 'text-[#1a1530]/70' : 'text-white/35'}`}>{o.desc}</div>
                                </button>
                            );
                        })}
                    </div>

                    {/* 演出基调（丧的大前提下偏哪种味道） */}
                    <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 px-1">演出基调</div>
                    <div className="grid grid-cols-2 gap-2 mb-5">
                        {([
                            { id: 'mix', label: '随心', desc: '每场随机' },
                            { id: 'depressive', label: '致郁', desc: '一路丧到底' },
                            { id: 'darkhumor', label: '黑色幽默', desc: '荒诞又毒舌' },
                            { id: 'cute', label: '轻盈可爱', desc: '活泼俏皮' },
                        ] as const).map(o => {
                            const active = tone === o.id;
                            return (
                                <button key={o.id} onClick={() => { setTone(o.id); trackEvent('选择演出基调', { tone: o.id }); }}
                                    className="rounded-2xl py-2.5 border transition active:scale-[0.98] text-center"
                                    style={active
                                        ? { background: ACCENT, color: '#1a1530', borderColor: 'transparent' }
                                        : { background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.8)' }}>
                                    <div className="text-[12.5px] font-semibold">{o.label}</div>
                                    <div className={`text-[9px] mt-0.5 ${active ? 'text-[#1a1530]/70' : 'text-white/35'}`}>{o.desc}</div>
                                </button>
                            );
                        })}
                    </div>

                    {/* ① 选方向（点一下填进下方，可继续编辑） */}
                    <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 px-1">① 选个大方向</div>
                    <div className="grid grid-cols-2 gap-2 mb-5">
                        {(mode === 'daily' ? DAILY : EVENTS).map(s => {
                            const active = theme.trim() === s;
                            return (
                                <button key={s} onClick={() => setTheme(s)}
                                    className="text-left rounded-2xl px-3.5 py-3 border transition active:scale-[0.98]"
                                    style={active
                                        ? { background: ACCENT, color: '#1a1530', borderColor: 'transparent' }
                                        : { background: 'rgba(255,255,255,0.035)', borderColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.85)' }}>
                                    <span className="text-[12.5px] font-medium">{s}</span>
                                </button>
                            );
                        })}
                    </div>

                    {/* ② 补细节（与方向合并，二者不再二选一） */}
                    <div className="text-[10px] uppercase tracking-wider text-white/40 mb-2 px-1">② 补点细节 · 也可直接自己写</div>
                    <textarea value={theme} onChange={e => setTheme(e.target.value)}
                        placeholder="选个方向后在这里补充具体情境，或直接写你想看的。例如：放学后的傍晚 · 下了雨，TA 没带伞，在便利店门口等一个不一定会来的人。"
                        className="w-full h-24 bg-white/[0.05] border border-white/[0.08] rounded-2xl px-3.5 py-3 text-[12.5px] text-white placeholder-white/25 outline-none resize-none leading-relaxed mb-4 no-scrollbar" />

                    <button onClick={() => requestStart(mode, theme)} disabled={!theme.trim()}
                        className="w-full py-3.5 rounded-2xl text-[13px] font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition disabled:opacity-40"
                        style={{ background: ACCENT, color: '#1a1530' }}>
                        开始演出 <ArrowRight size={15} weight="bold" />
                    </button>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  RENDER: LOADING (background generation in progress / about to play)
    // ========================================================
    if (phase === 'idle') {
        const t = sim.status === 'loading' ? sim.theme : theme;
        return (
            <Shell wallpaper={wallpaper}>
                <TopBar onBack={onExit} />
                <div className="flex-1 flex flex-col items-center justify-center gap-5 px-10 text-center">
                    <div className="relative">
                        <HourglassMedium size={40} weight="light" style={{ color: ACCENT }} className="animate-pulse" />
                        <div className="absolute inset-0 blur-2xl rounded-full" style={{ background: `${ACCENT}55` }} />
                    </div>
                    <div className="text-[13px] text-white/75">正在编排「{t}」…</div>
                    <div className="text-[11px] text-white/35 leading-relaxed">把记忆、对话与情绪编排成 TA 的一天，<br />可能需要较长时间。</div>
                    <button onClick={onExit} className="mt-3 px-5 py-2.5 rounded-xl text-[12px] text-white/75 bg-white/[0.06] border border-white/[0.08] active:scale-95 transition">
                        先去别处逛逛 · 好了通知我
                    </button>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  RENDER: END
    // ========================================================
    if (phase === 'end') {
        return (
            <Shell wallpaper={wallpaper}>
                <div className="flex-1 flex flex-col items-center justify-center px-8 text-center animate-fade-in">
                    <Lock size={26} weight="light" className="text-white/30 mb-5" />
                    <div className="text-[10px] tracking-[0.3em] uppercase text-white/35 mb-3">演出结束</div>
                    <h2 className="text-[20px] font-light text-white mb-2" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{script?.title}</h2>
                    {script?.ending && <div className="text-[11px] mb-4 px-3 py-1 rounded-full" style={{ color: ACCENT, background: `${ACCENT}1f` }}>{script.ending}</div>}
                    <p className="text-[13.5px] text-white/65 leading-loose max-w-[280px]" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{script?.summary}</p>

                    {script?.buff?.label && isScheduleFeatureOn(targetChar) && (
                        <div className="mt-7 flex items-center gap-2 px-4 py-2 rounded-2xl border" style={{ borderColor: `${script.buff.color || ACCENT}55`, background: `${script.buff.color || ACCENT}14` }}>
                            <span className="text-base">{script.buff.emoji || '✨'}</span>
                            <div className="text-left">
                                <div className="text-[12px] font-semibold text-white">{script.buff.label}</div>
                                <div className="text-[9px] text-white/45">情绪状态已写入 TA</div>
                            </div>
                        </div>
                    )}

                    {/* 把这场演出作为真实回忆送给角色 */}
                    <button onClick={sendAsMemory} disabled={memorySent}
                        className="mt-8 w-full max-w-[300px] py-3 rounded-2xl text-[13px] font-semibold flex items-center justify-center gap-2 active:scale-[0.99] transition disabled:opacity-60"
                        style={memorySent
                            ? { background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.55)', border: '1px solid rgba(255,255,255,0.1)' }
                            : { background: ACCENT, color: '#1a1530' }}>
                        {memorySent
                            ? <><Check size={15} weight="bold" /> 已成为 TA 的回忆</>
                            : <><PaperPlaneTilt size={15} weight="fill" /> 作为回忆发送给 TA</>}
                    </button>
                    <p className="text-[10px] text-white/30 mt-2 max-w-[280px] leading-relaxed">
                        会以一张卡片发到聊天里，TA 将把这段经历当成真实记忆。
                    </p>

                    <div className="flex gap-3 mt-6">
                        <button onClick={restart} className="px-5 py-2.5 rounded-xl text-[12px] text-white/70 bg-white/[0.06] border border-white/[0.08] flex items-center gap-1.5 active:scale-95 transition">
                            <ArrowClockwise size={14} /> 再看一次
                        </button>
                        <button onClick={() => { openLifeLog(); }} className="px-5 py-2.5 rounded-xl text-[12px] font-semibold text-[#1a1530] flex items-center gap-1.5 active:scale-95 transition" style={{ background: ACCENT }}>
                            <ClockCounterClockwise size={14} weight="bold" /> 生活记录
                        </button>
                    </div>
                    <button onClick={onExit} className="mt-4 text-[11px] text-white/30">退出演出</button>
                </div>
            </Shell>
        );
    }

    // ========================================================
    //  RENDER: PLAY
    // ========================================================
    return (
        <Shell wallpaper={wallpaper}>
            {/* phone status time */}
            <div className="h-8 flex justify-between items-center px-6 pt-2 text-white/55 text-[11px] z-30 relative shrink-0">
                <span className="font-semibold tabular-nums">{beat?.time || ''}</span>
                <div className="flex items-center gap-1">
                    <Lock size={11} weight="fill" className="opacity-50" />
                    <span className="opacity-50">{targetChar.name}</span>
                </div>
            </div>

            {/* beat stage + tap to advance */}
            <div
                className="flex-1 relative z-10 overflow-hidden select-none"
                onClick={advance}
                onPointerDown={e => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); const t = setTimeout(startFF, 420); (e.currentTarget as any)._ff = t; }}
                onPointerUp={e => { clearTimeout((e.currentTarget as any)._ff); stopFF(); }}
                onPointerLeave={e => { clearTimeout((e.currentTarget as any)._ff); stopFF(); }}
            >
                {/* background screen — re-enters ONLY when the underlying screen changes */}
                {screenBeat && (
                    <div key={`s${screenIdx}`} className={`absolute inset-0 ${screenEntrance(screenBeat.kind)}`}>
                        <ScreenContent beat={screenBeat} char={targetChar} showMono={!isOverlay} dimmed={isOverlay} />
                    </div>
                )}
                {/* overlay — notification drops / thought fades, on top of the live screen */}
                {beat && isOverlay && (
                    <div key={`o${idx}`} className="absolute inset-0">
                        <Overlay beat={beat} />
                    </div>
                )}
            </div>

            {/* progress + controls */}
            <div className="shrink-0 z-30 px-5 pb-6 pt-2">
                <div className="h-[3px] rounded-full bg-white/10 overflow-hidden mb-3">
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${((idx + 1) / beats.length) * 100}%`, background: ACCENT }} />
                </div>
                <div className="flex items-center justify-between">
                    <button onClick={(e) => { e.stopPropagation(); onExit(); }} className="text-[11px] text-white/35">退出</button>
                    <span className="text-[10px] text-white/30">轻触继续 · 长按快进</span>
                    <button onClick={(e) => { e.stopPropagation(); setAutoplay(a => !a); trackEvent('切换演出自动播放'); }}
                        className="w-9 h-9 rounded-full flex items-center justify-center border border-white/[0.1] text-white/70 active:scale-90 transition"
                        style={autoplay ? { background: ACCENT, color: '#1a1530', borderColor: 'transparent' } : undefined}>
                        {autoplay ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
                    </button>
                </div>
            </div>
        </Shell>
    );
};

// ============================================================
//  ENTRANCE + MONOLOGUE
// ============================================================
// 每种屏幕的进场动作 —— App 从底部弹起(像真的启动)、锁屏淡入、闪回淡入
const screenEntrance = (kind: BeatKind): string =>
    kind === 'app' ? 'animate-app-open' : 'animate-fade-in';

type Vibe = NonNullable<Beat['vibe']>;
// 确定性伪随机（按种子），保证同一 beat 每次渲染散布一致
const rnd = (n: number) => { const x = Math.sin(n * 99.73) * 43758.545; return x - Math.floor(x); };

const vibeTint: Record<Vibe, string> = {
    calm: 'rgba(255,255,255,0.9)',
    chaotic: 'rgba(255,255,255,0.85)',
    happy: '#ffb3d9',
    anxious: '#ff9a9a',
    numb: 'rgba(255,255,255,0.45)',
    tender: '#e6c9ff',
};

// 内心独白气泡（逐字敲出，按情绪微调色调）
const MonoBubble: React.FC<{ text: string; vibe?: Vibe }> = ({ text, vibe = 'calm' }) => (
    <span className="inline-block px-3 py-1 rounded-2xl bg-black/70">
        <Typewriter drafts={[]} sent={text} placeholder=""
            className={`text-[15px] leading-relaxed ${vibe === 'anxious' ? 'tracking-tight' : ''}`} />
    </span>
);

// 浮在屏幕底部的内心独白（用于锁屏 / 通知等无底部输入框的场景）
const MonoLine: React.FC<{ text: string; vibe?: Vibe }> = ({ text, vibe = 'calm' }) => (
    <div className="absolute left-0 right-0 bottom-6 px-8 text-center pointer-events-none z-20">
        <MonoBubble text={text} vibe={vibe} />
    </div>
);

// 情绪化的「内心独白」全屏演出：混乱铺满 / 开心粉色飘飘 / 麻木冷淡 / 焦虑紧绷
const MoodThought: React.FC<{ text: string; vibe?: Vibe }> = ({ text, vibe = 'calm' }) => {
    if (vibe === 'chaotic') {
        const frags = text.split(/[，。、！？!?,.\s]+/).filter(Boolean);
        const pool = frags.length >= 4 ? frags : [...frags, ...frags, ...frags].slice(0, Math.max(6, frags.length));
        return (
            <div className="absolute inset-0 overflow-hidden">
                {pool.map((f, i) => (
                    <span key={i} className="absolute animate-fade-in"
                        style={{
                            top: `${6 + rnd(i + 1) * 62}%`, left: `${6 + rnd(i + 7) * 44}%`,
                            maxWidth: '46%', wordBreak: 'break-word', textAlign: 'center', lineHeight: 1.3,
                            transform: `rotate(${(rnd(i + 3) - 0.5) * 30}deg)`,
                            fontSize: `${13 + rnd(i + 5) * 14}px`,
                            opacity: 0.35 + rnd(i + 9) * 0.6,
                            color: 'white',
                            animationDelay: `${i * 90}ms`, animationFillMode: 'backwards',
                            textShadow: '0 1px 8px rgba(0,0,0,0.5)',
                        }}>
                        {f}
                    </span>
                ))}
            </div>
        );
    }
    if (vibe === 'happy') {
        const deco = ['✿', '♡', '❀', '✦', '♥', '✧'];
        return (
            <div className="absolute inset-0 overflow-hidden flex items-center justify-center px-10">
                {deco.map((d, i) => (
                    <span key={i} className="absolute animate-float" style={{
                        bottom: `${10 + rnd(i + 2) * 20}%`, left: `${8 + rnd(i + 4) * 80}%`,
                        fontSize: `${14 + rnd(i + 6) * 14}px`, color: '#ffc2e0',
                        animationDelay: `${i * 350}ms`, opacity: 0.8,
                    }}>{d}</span>
                ))}
                <p className="text-[20px] text-center leading-relaxed animate-fade-in"
                    style={{ background: 'linear-gradient(90deg,#ffd6ec,#ffb3d9,#ffc2e0)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                    {text}
                </p>
            </div>
        );
    }
    if (vibe === 'anxious') {
        return (
            <div className="absolute inset-0 flex items-center justify-center px-10">
                <p className="text-[18px] text-center leading-relaxed tracking-tight animate-pulse"
                    style={{ color: vibeTint.anxious, textShadow: '0 0 12px rgba(255,80,80,0.3)' }}>
                    {text}
                </p>
            </div>
        );
    }
    if (vibe === 'numb') {
        return (
            <div className="absolute inset-0 flex items-center justify-center px-12">
                <p className="text-[14px] text-center leading-loose animate-fade-in" style={{ color: vibeTint.numb, animationDuration: '2s' }}>
                    {text}
                </p>
            </div>
        );
    }
    // calm / tender → typed, soft
    return (
        <div className="absolute inset-0 flex items-center justify-center px-10">
            <Typewriter drafts={[]} sent={text} placeholder=""
                className="text-[19px] text-center leading-relaxed"
                />
            {vibe === 'tender' && <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(circle at 50% 50%, rgba(230,201,255,0.12), transparent 60%)' }} />}
        </div>
    );
};

// ============================================================
//  SCREEN CONTENT — lock / app / flashback (the persistent layer)
// ============================================================
const ScreenContent: React.FC<{ beat: Beat; char: CharacterProfile; showMono: boolean; dimmed?: boolean }> =
    ({ beat, char, showMono, dimmed }) => {
        const mono = showMono && beat.monologue ? <MonoLine text={beat.monologue} vibe={beat.vibe} /> : null;
        const dim = dimmed ? <div className="absolute inset-0 bg-black/45 z-10 pointer-events-none" /> : null;

        if (beat.kind === 'lock') {
            return (
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                    <div className="text-[64px] font-extralight text-white tracking-tight tabular-nums leading-none animate-fade-in" style={{ textShadow: '0 4px 24px rgba(0,0,0,0.5)' }}>{beat.time || ''}</div>
                    {beat.notif && (
                        <div className="mt-10 w-[78%] rounded-2xl px-4 py-3 bg-black/70 border border-white/[0.15] animate-slide-up">
                            <div className="text-[10px] text-white/50 uppercase tracking-wide mb-0.5">{beat.notif.app}</div>
                            <div className="text-[12.5px] text-white/90 font-medium">{beat.notif.title}</div>
                            <div className="text-[11px] text-white/55 mt-0.5">{beat.notif.body}</div>
                        </div>
                    )}
                    {dim}{mono}
                </div>
            );
        }

        if (beat.kind === 'flashback') {
            const f = beat.flashback;
            return (
                <div className="absolute inset-0 flex flex-col items-center justify-center"
                    style={{ background: `radial-gradient(circle at 50% 45%, ${f?.tint || '#3a2a4a'} 0%, #07080c 78%)` }}>
                    <div className="absolute top-4 left-4 right-4 rounded-2xl px-4 py-2.5 bg-black/75 border border-white/[0.15] flex items-center gap-2 animate-slide-down">
                        <ImageSquare size={16} className="text-pink-300" />
                        <span className="text-[12px] text-white/85 font-medium">{f?.label || f?.date || '过去的某天'}</span>
                    </div>
                    <div className="w-[68%] aspect-[4/5] rounded-2xl overflow-hidden border border-white/[0.1] shadow-2xl relative grayscale-[35%] animate-fade-in"
                        style={{ background: `linear-gradient(160deg, ${f?.tint || '#5a4a6a'}, #1a1520)`, animationDuration: '1.4s' }}>
                        <div className="absolute inset-0 flex items-center justify-center opacity-40">
                            <ImageSquare size={48} weight="thin" className="text-white" />
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/70 to-transparent">
                            {f?.date && <div className="text-[9px] text-white/50 tabular-nums">{f.date}</div>}
                            {f?.caption && <div className="text-[12px] text-white/85">{f.caption}</div>}
                        </div>
                    </div>
                    {beat.monologue
                        ? <div className="mt-6 px-10 text-center"><Typewriter drafts={[]} sent={beat.monologue} placeholder="" className="text-[14px] text-white/80" /></div>
                        : <p className="mt-6 text-[12px] text-white/30 tracking-[0.3em]">· · ·</p>}
                </div>
            );
        }

        // kind === 'app'
        const a = beat.app;
        if (!a) return <>{dim}{mono}</>;
        return (
            <div className="absolute inset-0 flex flex-col">
                <div className="h-11 flex items-center gap-2 px-5 shrink-0 text-white/70 border-b border-white/[0.06]">
                    {appIcon(a.view)}
                    <span className="text-[12.5px] font-medium">{a.name}</span>
                </div>
                <div className="flex-1 min-h-0 overflow-hidden relative">
                    <AppView app={a} char={char} />
                </div>
                {/* app 场景里独白走「页脚」而非浮层，避免盖住聊天/搜索/输入框 */}
                {showMono && beat.monologue && (
                    <div className="shrink-0 px-8 pb-6 pt-2 text-center">
                        <MonoBubble text={beat.monologue} vibe={beat.vibe} />
                    </div>
                )}
                {dim}
            </div>
        );
    };

// ============================================================
//  OVERLAY — notification (drops) / thought (fades over the live screen)
// ============================================================
const Overlay: React.FC<{ beat: Beat }> = ({ beat }) => {
    if (beat.kind === 'thought') {
        const scrim = beat.vibe === 'happy' ? 'bg-black/55' : beat.vibe === 'chaotic' ? 'bg-black/75' : 'bg-black/70';
        return (
            <div className={`absolute inset-0 ${scrim}`}>
                <MoodThought text={beat.monologue || '……'} vibe={beat.vibe} />
            </div>
        );
    }
    // notification
    const n = beat.notif;
    const toneColor = n?.tone === 'sms' ? '#4ade80' : n?.tone === 'flashback' ? '#ff5fb0' : ACCENT;
    return (
        <div className="absolute inset-0">
            <div className="absolute top-4 left-4 right-4 rounded-2xl px-4 py-3 bg-[#16131f]/95 border border-white/[0.16] animate-notif-pop shadow-2xl">
                <div className="flex items-center gap-2 mb-1">
                    <span className="w-2 h-2 rounded-full" style={{ background: toneColor, boxShadow: `0 0 8px ${toneColor}` }} />
                    <span className="text-[10px] text-white/55 uppercase tracking-wide">{n?.app}</span>
                </div>
                <div className="text-[13px] text-white font-semibold">{n?.title}</div>
                <div className="text-[11.5px] text-white/65 mt-0.5">{n?.body}</div>
            </div>
            {beat.monologue && <MonoLine text={beat.monologue} vibe={beat.vibe} />}
        </div>
    );
};

const appIcon = (v: string) => {
    const p: any = { size: 15, weight: 'fill' as const, style: { color: ACCENT } };
    switch (v) {
        case 'search': return <MagnifyingGlass {...p} />;
        case 'music': return <MusicNotes {...p} />;
        case 'photo': return <ImageSquare {...p} />;
        case 'notes': return <NotePencil {...p} />;
        case 'browser': return <Globe {...p} />;
        case 'weather': return <CloudSun {...p} />;
        case 'chat': return <BellRinging {...p} />;
        default: return <Sparkle {...p} />;
    }
};

// ============================================================
//  APP VIEWS
// ============================================================
const AppView: React.FC<{ app: NonNullable<Beat['app']>; char: CharacterProfile }> = ({ app, char }) => {
    if (app.view === 'chat' && app.chat) {
        return (
            <div className="h-full overflow-y-auto no-scrollbar px-4 py-4 space-y-2.5">
                <div className="text-center text-[10px] text-white/30 mb-2">{app.chat.name}</div>
                {app.chat.lines.map((l, i) => (
                    <div key={i} className={`flex ${l.me ? 'justify-end' : 'justify-start'} animate-fade-in`}
                        style={{ animationDelay: `${i * 320}ms`, animationFillMode: 'backwards' }}>
                        <div className={`px-3.5 py-2 rounded-2xl max-w-[74%] text-[13px] leading-relaxed ${l.me ? 'text-[#1a1530] rounded-br-md' : 'bg-white/[0.08] text-white/90 border border-white/[0.06] rounded-bl-md'}`}
                            style={l.me ? { background: ACCENT } : undefined}>
                            {l.text}
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (app.view === 'compose' && app.compose) {
        const c = app.compose;
        return (
            <div className="h-full flex flex-col justify-end p-4">
                {c.to && <div className="text-[10px] text-white/30 mb-2 px-1">To: {c.to}</div>}
                <div className="rounded-2xl bg-white/[0.05] border border-white/[0.1] px-4 py-3 min-h-[52px] flex items-center">
                    <Typewriter drafts={c.drafts || []} sent={c.sent} placeholder="输入消息…"
                        className="text-[14px] text-white/90 leading-relaxed" />
                </div>
                <div className="text-[10px] text-white/25 mt-2 px-1">
                    {c.sent ? '已发送' : '草稿已清空'}
                </div>
            </div>
        );
    }

    if (app.view === 'search' && app.search) {
        const qs = app.search.queries || [];
        const last = qs[qs.length - 1];
        const sent = last && !last.deleted ? last.q : null;
        const drafts = qs.slice(0, sent != null ? -1 : qs.length).map(x => x.q);
        return (
            <div className="h-full flex flex-col p-4">
                <div className="rounded-full bg-white/[0.06] border border-white/[0.1] px-4 py-2.5 flex items-center gap-2">
                    <MagnifyingGlass size={15} className="text-white/40" />
                    <Typewriter drafts={drafts} sent={sent} placeholder="搜索" className="text-[13.5px] text-white/85" />
                </div>
                <div className="text-[10px] text-white/25 mt-3 px-1">{app.search.engine || '搜索'}</div>
                <div className="flex-1 flex items-center justify-center">
                    {sent
                        ? <span className="text-[11px] text-white/30">为你找到相关结果…</span>
                        : <span className="text-[11px] text-white/25">— 没有搜索 —</span>}
                </div>
            </div>
        );
    }

    if (app.view === 'photo' && app.photo) {
        const f = app.photo;
        return (
            <div className="h-full flex items-center justify-center p-6">
                <div className="w-full aspect-[4/5] rounded-2xl overflow-hidden border border-white/[0.08] relative"
                    style={{ background: `linear-gradient(155deg, ${f.tint || '#3a4a5a'}, #14161c)` }}>
                    <div className="absolute inset-0 flex items-center justify-center opacity-30"><ImageSquare size={44} weight="thin" className="text-white" /></div>
                    <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/65 to-transparent">
                        {f.date && <div className="text-[9px] text-white/45 tabular-nums">{f.date}</div>}
                        {f.caption && <div className="text-[12px] text-white/85">{f.caption}</div>}
                    </div>
                </div>
            </div>
        );
    }

    if (app.view === 'music' && app.music) {
        const m = app.music;
        return (
            <div className="h-full flex flex-col items-center justify-center gap-5 px-10">
                <div className="w-36 h-36 rounded-3xl flex items-center justify-center animate-bounce-slow" style={{ background: `linear-gradient(135deg, ${ACCENT}55, ${ACCENT}10)` }}>
                    <MusicNotes size={46} weight="fill" style={{ color: ACCENT }} />
                </div>
                <div className="text-center">
                    <div className="text-[15px] text-white font-medium">{m.song}</div>
                    <div className="text-[12px] text-white/45 mt-1">{m.artist}</div>
                </div>
                <div className="w-full h-1 rounded-full bg-white/10 overflow-hidden"><div className="h-full w-1/3 rounded-full" style={{ background: ACCENT }} /></div>
                {m.state && <div className="text-[10px] text-white/30">{m.state}</div>}
            </div>
        );
    }

    if (app.view === 'notes' && app.notes) {
        return (
            <div className="h-full overflow-y-auto no-scrollbar p-5">
                {app.notes.title && <div className="text-[15px] text-white font-medium mb-3">{app.notes.title}</div>}
                <div className="space-y-2.5">
                    {app.notes.items.map((it, i) => (
                        <div key={i} className="flex items-start gap-2.5 text-[13px] text-white/75">
                            <span className="w-4 h-4 rounded border border-white/20 mt-0.5 shrink-0" />
                            <span>{it}</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (app.view === 'browser' && app.browser) {
        return (
            <div className="h-full overflow-y-auto no-scrollbar p-4 space-y-2">
                <div className="text-[10px] text-white/30 px-1 mb-1">{app.browser.tabs.length} 个标签页</div>
                {app.browser.tabs.map((t, i) => (
                    <div key={i} className="rounded-xl bg-white/[0.04] border border-white/[0.07] px-3.5 py-3 flex items-center gap-2.5">
                        <Globe size={15} className="text-white/35 shrink-0" />
                        <span className="text-[12.5px] text-white/75 truncate">{t}</span>
                    </div>
                ))}
            </div>
        );
    }

    if (app.view === 'weather' && app.weather) {
        const w = app.weather;
        return (
            <div className="h-full flex flex-col items-center justify-center gap-3">
                <CloudSun size={56} weight="thin" className="text-white/70" />
                <div className="text-[52px] font-extralight text-white leading-none tabular-nums">{w.temp}°</div>
                <div className="text-[13px] text-white/55">{w.city} · {w.desc}</div>
            </div>
        );
    }

    return (
        <div className="h-full flex items-center justify-center px-8 text-center">
            <p className="text-[13.5px] text-white/70 leading-relaxed">{app.text || '…'}</p>
        </div>
    );
};

// ============================================================
//  SHARED CHROME
// ============================================================
const Shell: React.FC<{ children: React.ReactNode; wallpaper?: string }> = ({ children, wallpaper }) => (
    <div className="absolute inset-0 z-[80] flex flex-col overflow-hidden text-white" style={{ background: '#07080c' }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(130% 80% at 50% 0%, #1a1726 0%, #0a0b12 60%, #07080c 100%)' }} />
        {wallpaper && <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ backgroundImage: `url(${wallpaper})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />}
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(to bottom, rgba(7,8,12,0.4), rgba(7,8,12,0.2) 40%, rgba(7,8,12,0.9))' }} />
        <div className="relative z-10 flex flex-col flex-1 min-h-0">{children}</div>
    </div>
);

const TopBar: React.FC<{ onBack: () => void; right?: React.ReactNode; title?: string }> = ({ onBack, right, title }) => (
    // 顶部安全区：iOS 刘海/状态栏会盖住返回键和「生活记录」，给个 safe-area-inset 兜底
    <div className="flex items-center justify-between px-4 shrink-0 pb-2"
        style={{ paddingTop: 'max(0.75rem, calc(env(safe-area-inset-top, 0px) + 0.5rem))' }}>
        <button onClick={onBack} className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white/80 bg-white/[0.05] border border-white/[0.08] active:scale-90 transition">
            <CaretLeft size={18} weight="bold" />
        </button>
        {title && <span className="text-[14px] font-semibold text-white">{title}</span>}
        <div className="flex justify-end min-w-[80px]">{right}</div>
    </div>
);

// ============================================================
//  LIFE LOG (生活记录) — sub-app
// ============================================================
export const LifeLog: React.FC<{
    targetChar: CharacterProfile;
    onBack: () => void;
    onReplay?: (log: PhoneSimLog) => void;
    onRequestDelete?: (log: PhoneSimLog) => void;
}> = ({ targetChar, onBack, onReplay, onRequestDelete }) => {
    const { addToast } = useOS();
    const logs = targetChar.phoneState?.simLogs || [];
    const [sent, setSent] = useState<Record<string, boolean>>({});
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fmt = (t: number) => new Date(t).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    const cancelLongPress = () => {
        if (!longPressTimer.current) return;
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
    };
    const startLongPress = (e: React.PointerEvent, log: PhoneSimLog) => {
        if (!onRequestDelete || (e.target as HTMLElement).closest('button')) return;
        cancelLongPress();
        longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            onRequestDelete(log);
        }, 520);
    };
    useEffect(() => () => cancelLongPress(), []);

    const sendLog = async (log: PhoneSimLog) => {
        if (sent[log.id]) return;
        try {
            const digest = log.memoryText ? `\n${log.memoryText}` : '';
            await DB.saveMessage({
                charId: targetChar.id, role: 'assistant', type: 'sim_card',
                content: `【一段亲身经历 · ${log.title}】${digest}${log.summary ? `\n\n回过头想：${log.summary}` : ''}`,
                metadata: { simCard: { mode: log.mode, theme: log.theme, title: log.title, summary: log.summary, ending: log.ending } },
            } as any);
            setSent(s => ({ ...s, [log.id]: true }));
            addToast('已作为回忆发送给 TA', 'success');
        } catch (e) { console.error(e); addToast('发送失败，请重试', 'error'); }
    };
    return (
        <Shell wallpaper={targetChar.dateBackground}>
            <TopBar onBack={onBack} title="生活记录" />
            <div className="px-6 pb-3 shrink-0">
                <p className="text-[11px] text-white/40 leading-relaxed">那些你以 TA 的身份活过的片段。TA 不会记得，但你会。</p>
                {logs.length > 0 && onRequestDelete && <p className="mt-1.5 text-[10px] text-white/25">长按记录可删除</p>}
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-10 space-y-3">
                {logs.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-64 text-white/30 gap-3">
                        <ClockCounterClockwise size={42} weight="light" />
                        <span className="text-xs">还没有体验记录</span>
                    </div>
                )}
                {logs.map(log => (
                    <div key={log.id}
                        onPointerDown={(e) => startLongPress(e, log)}
                        onPointerUp={cancelLongPress}
                        onPointerLeave={cancelLongPress}
                        onPointerMove={cancelLongPress}
                        onPointerCancel={cancelLongPress}
                        onContextMenu={(e) => {
                            if (!onRequestDelete || (e.target as HTMLElement).closest('button')) return;
                            e.preventDefault();
                            cancelLongPress();
                            onRequestDelete(log);
                        }}
                        className="rounded-2xl p-4 bg-white/[0.035] border border-white/[0.06] animate-slide-up select-none">
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[9px] px-2 py-0.5 rounded-full tracking-wider" style={{ color: ACCENT, background: `${ACCENT}1f` }}>
                                {log.mode === 'daily' ? '日常' : '事件'} · {log.theme}
                            </span>
                            <span className="text-[9px] text-white/30 tabular-nums">{fmt(log.timestamp)}</span>
                        </div>
                        <div className="text-[15px] font-light text-white mb-1.5" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{log.title}</div>
                        {log.ending && <div className="text-[10px] text-white/40 mb-1.5">结局 · {log.ending}</div>}
                        <p className="text-[12.5px] text-white/60 leading-relaxed" style={{ fontFamily: "'Shippori Mincho','Noto Sans SC',serif" }}>{log.summary}</p>
                        <div className="flex items-center justify-between mt-3 gap-2">
                            {log.buff?.label ? (
                                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px]" style={{ borderColor: `${log.buff.color || ACCENT}55`, color: 'rgba(255,255,255,0.8)', background: `${log.buff.color || ACCENT}14` }}>
                                    <span>{log.buff.emoji || '✨'}</span>{log.buff.label}
                                </div>
                            ) : <span />}
                            <div className="flex items-center gap-2 shrink-0">
                                {onReplay && log.script?.beats?.length ? (
                                    <button onClick={() => onReplay(log)}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-semibold active:scale-95 transition border border-white/[0.12] text-white/80 bg-white/[0.05]">
                                        <ArrowClockwise size={12} weight="bold" /> 重播
                                    </button>
                                ) : null}
                                <button onClick={() => sendLog(log)} disabled={!!sent[log.id]}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[10px] font-semibold active:scale-95 transition disabled:opacity-60"
                                    style={sent[log.id] ? { background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.5)' } : { background: ACCENT, color: '#1a1530' }}>
                                    {sent[log.id] ? <><Check size={12} weight="bold" /> 已发送</> : <><PaperPlaneTilt size={12} weight="fill" /> 发送给 TA</>}
                                </button>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </Shell>
    );
};

// ============================================================
//  DIRECTOR PROMPT + PARSER
// ============================================================
// 把「最早一条消息距今多久」翻译成给导演看的认识时长描述（闪回时间口径护栏）
function describeAcquaintance(firstTs: number | undefined, userName: string, charName: string): string {
    if (!firstTs) {
        return `${charName} 与 ${userName} 还没有可考的相处记录（可能是初次接触）。`;
    }
    const days = Math.floor((Date.now() - firstTs) / 86400000);
    let span: string;
    if (days <= 1) span = '不到一天';
    else if (days < 30) span = `约 ${days} 天`;
    else if (days < 365) span = `约 ${Math.floor(days / 30)} 个月`;
    else span = `约 ${(days / 365).toFixed(1)} 年`;
    return `${charName} 与 ${userName} 自首次接触至今${span}（${days} 天）。`;
}

// 把演出脚本压成「可读梗概」——作为回忆发给角色时用这个（让角色真的知道发生了什么，
// 而不是只收到一句留白的收尾）。
function buildMemoryText(s: SimScript): string {
    const lines: string[] = [];
    for (const b of s.beats) {
        if (b.kind === 'end') continue;
        const t = b.time ? b.time + ' ' : '';
        const mono = b.monologue ? `（${b.monologue}）` : '';
        if (b.kind === 'thought') { if (b.monologue) lines.push(`${t}心里：${b.monologue}`); continue; }
        if (b.kind === 'notification' && b.notif) { lines.push(`${t}${b.notif.app}通知：${b.notif.title}${b.notif.body ? ' ' + b.notif.body : ''}${mono}`); continue; }
        if (b.kind === 'flashback') { lines.push(`${t}相册突然翻出${b.flashback?.label || '一张旧照片'}${b.flashback?.caption ? '：' + b.flashback.caption : ''}${mono}`); continue; }
        if (b.kind === 'lock') { lines.push(`${t}${b.notif ? `锁屏，${b.notif.app}：${b.notif.title}` : '看了眼锁屏'}${mono}`); continue; }
        if (b.kind === 'app' && b.app) {
            const a = b.app; let act = `打开${a.name}`;
            if (a.view === 'search' && a.search) act += `，搜：${a.search.queries.map(q => q.q).join(' → ')}`;
            else if (a.view === 'compose' && a.compose) act += a.compose.sent ? `，给${a.compose.to || '对方'}发了「${a.compose.sent}」` : `，打了字又删了（${(a.compose.drafts || []).join('；')}）`;
            else if (a.view === 'chat' && a.chat) act += `，和${a.chat.name}：${a.chat.lines.map(l => (l.me ? '我:' : '对方:') + l.text).join(' ')}`;
            else if (a.view === 'photo' && a.photo) act += `，看一张照片${a.photo.caption ? '：' + a.photo.caption : ''}`;
            else if (a.view === 'music' && a.music) act += `，听《${a.music.song}》${a.music.artist ? ' - ' + a.music.artist : ''}`;
            else if (a.view === 'notes' && a.notes) act += `，备忘录：${(a.notes.items || []).join('；')}`;
            else if (a.view === 'browser' && a.browser) act += `，标签页：${(a.browser.tabs || []).join('；')}`;
            else if (a.view === 'weather' && a.weather) act += `，看天气（${a.weather.temp}° ${a.weather.desc}）`;
            else if (a.text) act += `：${a.text}`;
            lines.push(`${t}${act}${mono}`);
        }
    }
    let text = lines.join('\n');
    if (text.length > 3200) text = text.slice(0, 3200) + '…';
    return text;
}

// 「本场变奏」——每次随机抽几根轴当硬约束，打破固定的起床→刷手机→睡觉流水账
const vPick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
// 各基调对应的「情绪底色」候选池（丧是公共底子，差异在上层笔触）
const MOOD_POOLS: Record<'depressive' | 'darkhumor' | 'cute', string[]> = {
    depressive: [
        '平静钝感，情绪几乎贴着地面', '隐隐的烦躁，说不清为什么',
        '麻木、抽离，像隔着一层玻璃', '怀念某个具体的人或时刻',
        '低度焦虑，反复确认某件小事', '自我欺骗，嘴上一套、行为一套',
    ],
    darkhumor: [
        '把处境吐槽成段子，越离谱越想损两句', '一本正经地做一件很荒诞的事，自己都觉得好笑',
        '用调侃和自嘲消解一切，没什么是不能拿来开玩笑的', '把糟心事说得稀松平常，透着一股冷幽默',
        '神经质的好笑，脑子里全是怪念头', '对自己的烂摊子幸灾乐祸，黑色玩笑停不下来',
    ],
    cute: [
        '行为里冒出一股傻气和俏皮', '小题大做地认真，可爱又好笑',
        '幼稚的小执拗，像个长不大的小孩', '自娱自乐，给自己找些无聊但开心的小乐子',
        '轻飘飘的，对小事莫名上头', '一惊一乍、活泼跳脱，情绪都写在脸上',
    ],
};

function buildVariation(tone: 'mix' | 'depressive' | 'darkhumor' | 'cute' = 'mix'): string {
    const entry = vPick([
        '从一个不起眼的中间时刻切入（绝不要从「起床/醒来/关闹钟」开始）',
        '从午后犯困、注意力涣散的那一刻切入',
        '从黄昏、天快黑了还没开灯的那一刻切入',
        '从深夜睡不着、第无数次点亮屏幕切入',
        '从通勤/在路上、单手划手机切入',
        '从被一条通知突然打断的瞬间切入',
        '从一件正做到一半的事中途切入',
    ]);
    const span = vPick([
        '整场只覆盖十几分钟的一个片段，密度高、范围小',
        '只覆盖某半天里零散的几个空隙',
        '在同一个时刻反复回返（时间几乎没走，心思在原地打转）',
        '跨越深夜到天亮前的一小段',
        '一天里互不相连的三四个碎片，跳着来',
    ]);
    const structure = vPick([
        '整场几乎围绕「一个 App」展开，很少离开它',
        '整场围绕「一件小物 / 一条未读 / 一张旧图」打转',
        '在两件不相干的事之间反复横跳',
        '大量留白，几乎什么都没发生，靠空气感和零碎动作撑',
        '被一个突发（来电/通知/没电）打断后，再也没回到原来的事',
        '线性但克制，靠细节而非情节推进',
    ]);
    const medium = vPick([
        '以「搜了又删、删了又搜」为主要表达',
        '以「翻看相册」为主要表达',
        '以「打字→删除→再打字」的反复为主要表达',
        '以「一首歌单曲循环 + 走神」为主要表达',
        '以「和某一个联系人有一搭没一搭的聊天」为主要表达',
        '以「一堆与主线无关的环境碎片（通知/待办/标签页/购物车）」为主要表达',
    ]);
    const moodPool = tone === 'mix'
        ? [...MOOD_POOLS.depressive, ...MOOD_POOLS.darkhumor, ...MOOD_POOLS.cute]
        : MOOD_POOLS[tone];
    const mood = vPick(moodPool);
    const anchor = vPick([
        '一杯早就凉掉的咖啡/茶', '一条打好了却没发出去的消息', '一张忘了删的截图',
        '一个挂了半年的待办', '一首单曲循环的歌', '一个一直没人回的群',
        '一条快递的物流页', '一个总点开又退出的页面', '一张存了很久没再看的照片',
        '一个删到一半的草稿',
    ]);
    return `### [本场变奏 · 必须严格遵守，让这一场和上一场截然不同]
- 切入：${entry}
- 跨度：${span}
- 结构：${structure}
- 主导表达：${medium}
- 情绪底色：${mood}
- 具体锚点：让这一场反复回到「${anchor}」上（可改写成更贴合人设的同类小物）
※ 严禁套路化：不要从「起床/关闹钟/看天气」开场，也不要默认以「睡觉/锁屏」收尾，更不要走「醒来→刷一圈微信微博→睡觉」的流水账。下方字段示例只演示 JSON 格式，时间和内容一律按本场变奏来。`;
}

// user 存在感三档（这一天里"你"占多少分量）
function buildPresenceRule(presence: 'default' | 'light' | 'none', userName: string): string {
    const u = userName || '用户';
    switch (presence) {
        case 'none':
            return `这一天**完全是 TA 自己的人生**：${u} 不出现、不被想起、不被寻找。即使 TA 记忆里有 ${u}，这一天也绝不浮现。所有消息、念头、痕迹都由 TA 自己的生活与其他人构成，绝对不要出现、暗示、惦记 ${u}。`;
        case 'light':
            return `${u} 只是**极淡的背景**——整场重心是 TA 自己。最多偶尔扫过一条 ${u} 的旧消息、一闪而过的一个念头，点到即止，绝不聚焦、不展开、不围着 ${u} 转。`;
        default:
            return `${u} 是 TA 生活里**自然存在的一条线**——可以有 ${u} 的消息、对 ${u} 的惦记、痕迹里出现 ${u}，关系与平时聊天一致；但此刻 ${u} 不在场，不要替 ${u} 说话或行动。`;
    }
}

// 演出基调：丧始终是底子，差异在上层笔触
function buildToneRule(tone: 'mix' | 'depressive' | 'darkhumor' | 'cute'): string {
    switch (tone) {
        case 'depressive':
            return `【本场基调：致郁】纯粹的低气压——钝感、麻木、克制、贴着地面。不要插科打诨，不要俏皮，让情绪安安静静地泡着。`;
        case 'darkhumor':
            return `【本场基调：黑色幽默】要有**神经质的好笑**——self-aware 的自嘲、把糟心事讲成段子、一本正经地做荒诞的事、越离谱越好笑。参考《安迪和莉莉的棺材》那种味道：可爱的皮、荒诞的里，冷不丁戳你一下。表达可以毒舌、跳脱、停不下来。`;
        case 'cute':
            return `【本场基调：轻盈可爱】笔触**俏皮、轻盈、带点傻气和萌**——小题大做、幼稚的小执拗、自娱自乐、对无聊小事莫名上头。像素小可爱那种活泼可爱感，整场轻松、不压抑。`;
        default:
            return `【本场基调：随心】基调随「情绪底色」自然流动——可平静、可黑色幽默、可俏皮轻盈，允许一场之内有起伏，不必固定在某一种情绪上。`;
    }
}

function buildDirectorPrompt(context: string, recent: string, mode: 'daily' | 'event', theme: string, name: string, acquaintance: string, userName: string, presence: 'default' | 'light' | 'none', tone: 'mix' | 'depressive' | 'darkhumor' | 'cute'): string {
    return `${context}

### [最近的聊天上下文]
${recent || '（暂无最近对话）'}

### [导演任务：手机人生演出 Screenlife]
你现在是一位沉浸式叙事导演。请把「${name}」的一段人生，编排成一场**以手机为载体的第一人称演出**。
体验类型：${mode === 'daily' ? '日常模拟（普通日子，重生活感与陪伴）' : '事件模拟（特殊事件，重情绪张力）'}
体验内容：「${theme}」
关系时间线（重要护栏）：${acquaintance}
你的存在感（${userName || '用户'}在这一天里的位置 · 必须严格遵守）：${buildPresenceRule(presence, userName)}
${buildToneRule(tone)}

观众（用户）将**成为 ${name}**，通过 TA 使用手机的行为，亲身经历这段时间。

${buildVariation(tone)}

【铁律】
1. 不要把故事讲出来，不要解释人物，不要分析情绪，不要总结意义。一切通过**手机行为 / 数字痕迹 / 内心独白 / 环境碎片**自然呈现。
2. 内心独白（monologue）要**大量出现**，但**极其口语、简短、真实**，像真实人脑活动。例如：「不想起床。」「算了。」「她怎么还没回我。」「应该没事吧。」「其实有点在意。」禁止文学腔、禁止解释剧情。
3. **非可靠叙事**：TA 说的/想的不一定是真相，允许自我安慰、自我欺骗、逃避、美化记忆、误解他人。让行为去拆穿独白（例如嘴上说「我根本不在意」，却反复打开同一个聊天窗口）。
4. **数字行为优先**：多用「打字后删除(compose)」「搜索后删除再搜(search)」「翻看旧照片」「反复打开同一页面」「消息撤回」来表达，而不是直接说出情绪。
5. **真实手机感**：可穿插与主线无关的真实手机事件——来电、电量不足、验证码、快递通知、垃圾短信、天气预警、自动续费、各种推送。它们不一定推动剧情，但增强真实。
6. **环境碎片**：可出现与主线无关的痕迹——没做完的待办、半年前的截图、忘记删的照片、一堆浏览器标签、购物车、旧闹钟、收藏夹。这些共同拼出 TA 的人格。
7. **情绪高潮放慢节奏**：关键节点用「打开→关闭→重新打开→停顿→锁屏→再打开→输入→删除→输入→删除→最终发送(或不发)」这种反复的 beat 序列制造张力，并把这些 beat 的 pace 设为 3。
8. 【记忆闪回 · 务必先判断是否合理，宁可不插也不要 OOC】闪回是 ${name} **自己的一段过去突然闯进现在**（相册自动弹出一张旧照片→沉默→什么都不说→继续今天，杀伤力来自“过去闯进现在”）。但是否插入、用什么时间口径，必须严格符合人设与世界观：
   - 时间标签(label)由你决定，必须与上面的「关系时间线」以及角色自身的人生阶段/世界观自洽。例如真的相识一年以上才用「去年今日」；几个月就用「三个月前的今天」「那天」；刚认识或时间线不支持，**绝不要**用「去年」。
   - 照片不一定与用户有关，可以是 ${name} 自己更早的人生片段（地方、人、物）。
   - 如果该角色的设定/世界观里根本没有「拍照片 / 现代时间感 / 可追溯的过去」，或任何闪回都会显得突兀 OOC，就**完全不要**加 flashback beat。
   - ${mode === 'event' ? '事件模拟下，若合理，优先安排一次闪回来强化情绪；若不合理则跳过。' : '日常模拟下，仅在某个安静且合理的时刻择机插入，可有可无。'}

【下猛料 · 密度 / 强度 / 具体度（这一段优先级最高，别给我收着）】
- **要长、要满**：这是一场完整演出，不是预告片。beats 给足 **40~64 个**，疏密有致但总量宁多勿少。
- **每一步都有戏**：绝大多数 beat 都带 monologue；独白可以接连成串——一个动作配 2~3 个跳跃、互相打架的念头，让脑子真的"在转"。
- **往死里具体**：用真实的名字、店名、歌名、金额、时间、对话原话、搜索词。**拒绝**「某人 / 某件事 / 一条消息 / 一首歌」这种含糊占位，每个细节都要像真有其事，能拼出一个活人。
- **数字行为往狠里堆**：compose 的「打了又删」至少 2~3 次且每次草稿不同、search 的「搜了又删」至少一串 3~4 条层层递进（越搜越露底）、再穿插消息撤回 / 反复开同一页 / 已读不回 / 对方"正在输入…"又停了。
- **高潮要够长够窒息**：把关键节点拉成 **8~12 个连续 beat**（开→关→重开→停顿→锁屏→再开→输入→删→输入→删→…→最终发送或最终没发），全程 pace=3，把"手指悬在发送键上"的劲儿磨出来。
- **环境碎片撒厚**：购物车里躺着什么、半年前的待办写了什么、浏览器开着哪些标签、相册某张图是哪天——具体到刺人。
- **敢于不体面**：真实的人会走神、会反复确认、会自欺、会因一件小事突然破防。别替 TA 美化、克制成一张白纸——该狼狈就狼狈，该上头就上头。
- **结尾要"落地"，不要"断电"**：高潮之后**必须**有 3~6 个 beat 的收束——情绪慢慢沉下来、做一个最终的小动作（放下手机 / 关灯 / 最后看一眼那条消息 / 轻轻锁屏），pace 回落到 1~2；倒数第二拍用一句 thought 或一个 lock 给整场一个情绪落点，让观众真切感到"这一段，结束了"。**绝不能停在动作中途或高潮顶点就 end**。end 永远是收束之后的最后一拍，不是急刹车。

【输出格式】严格输出**一个 JSON 对象**（不要任何额外文字、不要 markdown 代码块），结构如下：
{
  "title": "演出标题（如：普通的周二）",
  "ending": "可选，这次的结局版本标签（如：最终没有发送）",
  "summary": "1-2 句收尾，客观留白，不解释",
  "buff": { "name": "英文key", "label": "中文情绪标签(4-8字)", "emoji": "1个emoji", "color": "#hex", "intensity": 1|2|3, "description": "一句给AI看的情绪底色" },
  "beats": [ ... 40~64 个 beat，宁多勿少 ... ]
}

每个 beat 是一个对象，必含 "kind"，按需含 "time"(HH:MM)、"monologue"、"pace"(1普通/2稍慢/3高潮)、"vibe"。
**"vibe" 决定这段文字的视觉演出**，请根据 TA 此刻的情绪状态给 thought / 关键 monologue 标注，取值：
  - "calm" 平静（默认，文字居中缓缓敲出）
  - "chaotic" 混乱崩溃（文字会铺天盖地散落满屏——情绪越乱越适合）
  - "happy" 开心（粉色字 + 飘飘上浮的小装饰）
  - "anxious" 焦虑（文字紧绷、发红、轻微脉动）
  - "numb" 麻木空洞（文字冷淡、缩小、大片留白）
  - "tender" 温柔/眷恋（柔光）
kind 取值与字段：
- {"kind":"lock","time":"07:12","notif":{"app":"闹钟","title":"...","body":"..."},"monologue":"不想起床。"}  // 锁屏/亮屏
- {"kind":"thought","monologue":"算了。","vibe":"numb"}  // 纯内心独白；情绪强烈时务必给 vibe（如崩溃→"chaotic"、雀跃→"happy"）
- {"kind":"notification","notif":{"app":"微信","title":"...","body":"...","tone":"push|sms|system|flashback"},"monologue":"..."}  // 横幅通知
- {"kind":"app","app":{"name":"微信","view":"chat","chat":{"name":"妈","lines":[{"me":false,"text":"吃饭了吗"},{"me":true,"text":"吃了"}]}}}
- {"kind":"app","app":{"name":"微信","view":"compose","compose":{"to":"她","drafts":["在吗","你最近还好吗"],"sent":null}}}  // 打字后删除；sent=null表示最终没发，sent填字符串表示最终发送
- {"kind":"app","app":{"name":"搜索","view":"search","search":{"engine":"百度","queries":[{"q":"失眠怎么办","deleted":true},{"q":"长期睡不好会死吗","deleted":true},{"q":"猫为什么半夜叫"}]}}}
- {"kind":"app","app":{"name":"相册","view":"photo","photo":{"caption":"...","date":"2024-06-19","tint":"#5a6a7a"}}}
- {"kind":"app","app":{"name":"音乐","view":"music","music":{"song":"...","artist":"...","state":"单曲循环"}}}
- {"kind":"app","app":{"name":"备忘录","view":"notes","notes":{"title":"待办","items":["...","..."]}}}
- {"kind":"app","app":{"name":"浏览器","view":"browser","browser":{"tabs":["...","..."]}}}
- {"kind":"app","app":{"name":"天气","view":"weather","weather":{"city":"...","temp":22,"desc":"多云"}}}
- {"kind":"flashback","time":"15:00","flashback":{"label":"三个月前的今天","caption":"...","date":"...","tint":"#4a3a5a"},"monologue":""}  // 记忆闪回(可选)，label=自洽的时间口径，monologue留空=沉默
- {"kind":"end","time":"23:40"}  // 最后一个 beat 必须是 end

请严格贴合上面的【本场变奏】，并把【下猛料】那段吃透：beats 给足 40~64 个、独白密集、细节具体、数字行为反复、高潮拉长、结尾收束落地。**务必保证 JSON 完整闭合、结尾收好**——若篇幅吃紧，宁可砍掉几个中段 beat，也要留足收尾、把括号全部闭合，绝不允许写到一半被截断。直接输出 JSON 对象。`;
}

// 归一化 LLM 输出：模型偶尔会漏掉 app beat 里的嵌套数组（如 view:'chat' 却没有 chat.lines），
// 渲染到 .map 时会整页崩（Safari 报「undefined is not an object」）。这里统一兜底成数组。
function normalizeScript(s: SimScript): SimScript {
    if (!Array.isArray(s.beats)) return s;
    for (const b of s.beats) {
        const a = b?.app;
        if (!a) continue;
        if (a.chat && !Array.isArray(a.chat.lines)) a.chat.lines = [];
        if (a.search && !Array.isArray(a.search.queries)) a.search.queries = [];
        if (a.notes && !Array.isArray(a.notes.items)) a.notes.items = [];
        if (a.browser && !Array.isArray(a.browser.tabs)) a.browser.tabs = [];
        if (a.compose && !Array.isArray(a.compose.drafts)) a.compose.drafts = [];
    }
    return s;
}

function parseScript(raw: string): SimScript | null {
    if (!raw) return null;
    let s = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1) return null;
    s = s.slice(first, last + 1);
    // 状态机修复：① 把字符串内的裸控制字符转义；② 去掉 } / ] 前的尾随逗号（仅在字符串外）。
    // 这两类是 LLM 输出 JSON 最常见的语法破坏。
    const repair = (str: string) => {
        let inStr = false, esc = false, out = '';
        for (let i = 0; i < str.length; i++) {
            const ch = str[i];
            if (esc) { out += ch; esc = false; continue; }
            if (ch === '\\') { out += ch; esc = true; continue; }
            if (ch === '"') { inStr = !inStr; out += ch; continue; }
            if (inStr) {
                if (ch === '\n') { out += '\\n'; continue; }
                if (ch === '\r') { out += '\\r'; continue; }
                if (ch === '\t') { out += '\\t'; continue; }
                out += ch; continue;
            }
            // 字符串外：跳过 } 或 ] 前的尾随逗号
            if (ch === ',') {
                let j = i + 1;
                while (j < str.length && /\s/.test(str[j])) j++;
                if (str[j] === '}' || str[j] === ']') continue;
            }
            out += ch;
        }
        return out;
    };
    try { return normalizeScript(JSON.parse(s)); } catch { }
    try { return normalizeScript(JSON.parse(repair(s))); } catch (e) { console.warn('persona parse failed', e); return null; }
}

export default PersonaSim;
