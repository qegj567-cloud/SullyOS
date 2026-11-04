import type { PhoneSimLog, SimScript } from '../types';

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
