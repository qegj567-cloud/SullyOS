import type { CharacterProfile, PhoneSimLog, SimScript } from '../types';
import { parsePersonaScriptApiResponse } from './personaSimParser';

/**
 * 整份模型响应 → 完整剧本。本机直连和云端代跑落地共用这一道校验，两边报的错一字不差。
 * 不兜底：截断、被安全策略拦下、解析不了、结尾不是模型自己收束的 end，一律抛错让用户重试。
 */
export function validatePersonaScriptResponse(data: any): SimScript {
    const finishReason = data?.choices?.[0]?.finish_reason;
    // 模型输出被 token 上限截断时 finish_reason 为 'length'
    if (finishReason === 'length') throw new Error('演出生成被截断');
    if (finishReason === 'content_filter' || finishReason === 'safety') {
        throw new Error('演出生成被模型安全策略中止');
    }
    const { content, script: parsed } = parsePersonaScriptApiResponse(data);
    if (!content) throw new Error('模型没有返回演出正文');
    if (!parsed) {
        console.warn('[persona] script parse failed', { finishReason, contentLength: content.length });
        throw new Error(`演出格式无法解析（模型返回 ${content.length} 字）`);
    }
    if (parsed.beats[parsed.beats.length - 1].kind !== 'end') throw new Error('演出结尾不完整');
    return parsed;
}

/** 云端代跑的剧本在 React 外落库后发这个事件，OSContext 只把这几条 simLogs 搬回内存。 */
export const PERSONA_SIM_LOG_LANDED = 'persona-sim-log-landed';
export interface PersonaSimLogLandedDetail { charId: string; log: PhoneSimLog }
/** 云端代跑失败（含结果校验不过），全局指示条据此弹出与本机失败相同的提示。 */
export const PERSONA_SIM_CLOUD_FAILED = 'persona-sim-cloud-failed';

/**
 * 只往 phoneState.simLogs 前面补上还没有的记录（按 id 去重），其余字段原样保留。
 * 全都已经在了就原样返回同一个对象，调用方据此判断要不要再存。
 */
export function mergePersonaSimLogs(
    phoneState: CharacterProfile['phoneState'],
    logs: PhoneSimLog[],
): CharacterProfile['phoneState'] {
    const existing = phoneState?.simLogs || [];
    const ids = new Set(existing.map(log => log.id));
    const added = logs.filter(log => !ids.has(log.id));
    if (added.length === 0) return phoneState;
    return { ...phoneState, records: phoneState?.records || [], simLogs: [...added, ...existing] };
}

/** 生成成功即归档；此时只存剧本，不给角色施加情绪效果。 */
export function createPersonaSimLog(script: SimScript, mode: PhoneSimLog['mode'], theme: string): PhoneSimLog {
    return {
        id: `sim-${crypto.randomUUID()}`,
        mode, theme, title: script.title || theme,
        summary: script.summary || '', ending: script.ending,
        beatsCount: script.beats.length, memoryText: buildMemoryText(script),
        timestamp: Date.now(), script,
        playback: { beatIndex: 0, status: 'ready' },
    };
}

export function getPersonaSimBeatIndex(log: PhoneSimLog): number {
    const index = log.playback?.beatIndex;
    const lastIndex = Math.max(0, (log.script?.beats.length || 1) - 1);
    return typeof index === 'number' && Number.isFinite(index)
        ? Math.max(0, Math.min(lastIndex, Math.floor(index))) : 0;
}

export function canResumePersonaSim(log: PhoneSimLog): boolean {
    return !!log.script?.beats.length && !!log.playback && log.playback.status !== 'completed';
}

export function hasCompletedPersonaSim(log: PhoneSimLog): boolean {
    // 旧版只在结尾存记录，不存在「未完成」的旧存档。
    return !log.playback || log.completedAt !== undefined || log.playback.status === 'completed';
}

// 把演出脚本压成可读梗概，作为回忆发送时保留实际经历。
export function buildMemoryText(s: SimScript): string {
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
