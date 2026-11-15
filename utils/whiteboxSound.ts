// 白框「提示音」声明式声音层。
//
// 设计要点（见分支 chatapp-whitebox-js-ympk39）：
// - 白框一直是 CSS-only 的可分享皮肤系统，靠"不执行任何脚本"来保证导入陌生人分享码时的安全。
//   为了不破坏这个护栏，提示音**不给用户 JS**，而是把声音配置声明成 CSS 里的一段特殊注释：
//     /* @sully-sound {"src":"chime","volume":0.6} */
//   播放由本模块（可信代码）执行，用户只是填数据。
// - 这段注释天然跟着白框的所有分享通道走（单角色 chromeCustomCss / 全局 chatChromeCustomCss /
//   SULLYCSS1 预设导出码 / TXT 导出），因为这些通道都把 CSS 当不透明字符串搬运，不解析、不清洗注释。
// - 浏览器忽略 CSS 注释，所以对渲染零影响、对老白框完全向后兼容。
// - 内置音效用 WebAudio 现场合成（无音频文件、分享码里只存一个短 key，体积极小）；也支持自定义音频 URL。

import { isRecalledNotificationSound, isRecalledSoundOwner, notifyRecalledSound } from './recalledNotificationSound';

export interface WhiteboxSound {
    /** 内置音效 key（见 BUILTIN_SOUNDS）、'none'（显式静音，用于角色覆盖全局）、或自定义音频直链 URL。 */
    src: string;
    /** 音量 0~1，默认 0.6。 */
    volume?: number;
}

// 内置音效：每个是一串"音符"，用 WebAudio 现场合成。freq=频率(Hz)，at=相对起点(秒)，dur=时长(秒)，
// type=波形，gain=该音相对音量。刻意做得短、轻、不刺耳（移动端提示音场景）。
type Note = { freq: number; at: number; dur: number; type?: OscillatorType; gain?: number };

interface BuiltinSound {
    label: string;
    notes: Note[];
}

export const BUILTIN_SOUNDS: Record<string, BuiltinSound> = {
    chime: {
        label: '风铃',
        notes: [
            { freq: 1046.5, at: 0, dur: 0.5, type: 'sine', gain: 0.6 },
            { freq: 1568.0, at: 0.09, dur: 0.6, type: 'sine', gain: 0.45 },
        ],
    },
    ding: {
        label: '叮',
        notes: [
            { freq: 880, at: 0, dur: 0.45, type: 'sine', gain: 0.7 },
            { freq: 1760, at: 0, dur: 0.28, type: 'sine', gain: 0.18 },
        ],
    },
    pop: {
        label: '气泡',
        notes: [
            { freq: 420, at: 0, dur: 0.09, type: 'triangle', gain: 0.7 },
            { freq: 780, at: 0.05, dur: 0.12, type: 'sine', gain: 0.6 },
        ],
    },
    crystal: {
        label: '水晶',
        notes: [
            { freq: 1318.5, at: 0, dur: 0.32, type: 'sine', gain: 0.5 },
            { freq: 1760.0, at: 0.08, dur: 0.32, type: 'sine', gain: 0.4 },
            { freq: 2093.0, at: 0.16, dur: 0.4, type: 'sine', gain: 0.32 },
        ],
    },
    heart: {
        label: '心跳',
        notes: [
            { freq: 174, at: 0, dur: 0.18, type: 'sine', gain: 0.9 },
            { freq: 174, at: 0.24, dur: 0.22, type: 'sine', gain: 0.7 },
        ],
    },
    retro: {
        label: '像素',
        notes: [
            { freq: 660, at: 0, dur: 0.07, type: 'square', gain: 0.28 },
            { freq: 990, at: 0.08, dur: 0.1, type: 'square', gain: 0.28 },
        ],
    },
};

export const BUILTIN_SOUND_KEYS = Object.keys(BUILTIN_SOUNDS);

const clampVolume = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return 0.6;
    return Math.min(1, Math.max(0, n));
};

// ---- 注释指令的解析 / 写入 ----

// 匹配 /* @sully-sound ... {json} ... */，宽松容错（大小写、空白、v1 之类版本标记都不挑）。
const DIRECTIVE_RE = /\/\*\s*@sully-sound\b[^{}]*(\{[^{}]*\})\s*\*\//i;

/** 从一段 CSS 字符串里解析出声音配置；没有 / 解析失败 / src 为空 → 返回 null。 */
export const parseWhiteboxSound = (css?: string | null): WhiteboxSound | null => {
    if (!css) return null;
    const m = css.match(DIRECTIVE_RE);
    if (!m) return null;
    try {
        const obj = JSON.parse(m[1]);
        const src = typeof obj?.src === 'string' ? obj.src.trim() : '';
        if (!src) return null;
        return { src, volume: clampVolume(obj?.volume) };
    } catch {
        return null;
    }
};

/** 剥掉 CSS 里已有的 @sully-sound 指令（连同其后紧跟的一个换行），返回纯 CSS。 */
export const stripWhiteboxSoundDirective = (css?: string | null): string => {
    if (!css) return '';
    return css.replace(/\/\*\s*@sully-sound\b[^{}]*\{[^{}]*\}\s*\*\/\n?/i, '');
};

/**
 * 把声音配置写进 CSS：先剥掉旧指令，sound 为 null 则等于删除；否则把新指令放到 CSS 顶部。
 * 保持声音配置随 CSS 字符串一起走（存字段 / 预设 / TXT / 分享码）。
 */
export const upsertWhiteboxSound = (css: string, sound: WhiteboxSound | null): string => {
    const base = stripWhiteboxSoundDirective(css);
    if (!sound || !sound.src) return base;
    const payload = JSON.stringify({ src: sound.src, volume: clampVolume(sound.volume) });
    const directive = `/* @sully-sound ${payload} */`;
    return base ? `${directive}\n${base}` : directive;
};

/**
 * 求出实际生效的提示音。优先级（从高到低）：
 *   角色白框指令（角色已绑定）→ 角色独立字段（角色未绑定）→ 全局白框指令 → 全局默认字段。
 * 这样角色设了就用角色的，没设就回落到全局默认；两种存法（绑进注释 / 独立字段）都能播。
 */
export const resolveActiveSound = (
    charCss?: string | null,
    charSound?: WhiteboxSound | null,
    globalCss?: string | null,
    globalSound?: WhiteboxSound | null,
): WhiteboxSound | null => {
    const pick = (s?: WhiteboxSound | null) => (s && s.src ? s : null);
    return parseWhiteboxSound(charCss) ?? pick(charSound) ?? parseWhiteboxSound(globalCss) ?? pick(globalSound);
};

// 提示音的「独立分享码」：SULLYSND1: + base64(utf8(JSON))。让用户不带白框、单独把提示音发给别人。
export const encodeSoundShare = (sound: WhiteboxSound): string =>
    'SULLYSND1:' + btoa(unescape(encodeURIComponent(JSON.stringify({ src: sound.src, volume: clampVolume(sound.volume) }))));

export const decodeSoundShare = (code: string): WhiteboxSound | null => {
    try {
        const body = code.trim().replace(/^SULLYSND1:/, '');
        const obj = JSON.parse(decodeURIComponent(escape(atob(body))));
        const src = typeof obj?.src === 'string' ? obj.src.trim() : '';
        if (!src) return null;
        return { src, volume: clampVolume(obj?.volume) };
    } catch {
        return null;
    }
};

// ---- 播放 ----

let audioCtx: AudioContext | null = null;

const getCtx = (): AudioContext | null => {
    if (typeof window === 'undefined') return null;
    try {
        const Ctor = window.AudioContext || (window as any).webkitAudioContext;
        if (!Ctor) return null;
        if (!audioCtx) audioCtx = new Ctor();
        return audioCtx;
    } catch {
        return null;
    }
};

/**
 * 在用户手势里调用一次，尝试解锁 / 恢复 AudioContext（移动端自动播放策略要求首个音频需用户手势触发）。
 * 幂等、best-effort，失败静默。
 */
export const unlockWhiteboxAudio = (): void => {
    const ctx = getCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
};

const playBuiltin = (sound: BuiltinSound, volume: number): void => {
    const ctx = getCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    const t0 = ctx.currentTime + 0.01;
    for (const n of sound.notes) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = n.type || 'sine';
        osc.frequency.value = n.freq;
        osc.connect(g);
        g.connect(master);
        const start = t0 + n.at;
        const peak = Math.max(0.0001, n.gain ?? 0.6);
        g.gain.setValueAtTime(0.0001, start);
        g.gain.linearRampToValueAtTime(peak, start + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
        osc.start(start);
        osc.stop(start + n.dur + 0.03);
    }
};

/** src 是自定义音频（http(s) 直链或内联 data URI），而非内置合成音。 */
export const isCustomAudioSrc = (s: string): boolean => /^https?:\/\//i.test(s) || /^data:audio\//i.test(s);

/** 播放一个白框提示音配置。best-effort：被自动播放策略挡住 / 无音频能力时静默失败，绝不抛。 */
export const playWhiteboxSound = (sound: WhiteboxSound | null, options: { onBlocked?: (src: string) => void | Promise<void> } = {}): void => {
    if (!sound || !sound.src || sound.src === 'none') return;
    const src = sound.src;
    const volume = clampVolume(sound.volume);
    try {
        const builtin = BUILTIN_SOUNDS[src];
        if (builtin) {
            playBuiltin(builtin, volume);
            return;
        }
        // 自定义音频：http(s) 直链或上传后内联的 data:audio URI，交给 <audio> 播放。
        if (isCustomAudioSrc(src) && typeof Audio !== 'undefined') {
            const play = () => {
                const el = new Audio(src);
                el.volume = volume;
                el.play().catch(() => {});
            };
            if (isRecalledSoundOwner()) { play(); return; }
            void isRecalledNotificationSound(src).then(async blocked => {
                // Identity may have changed while hashing.
                if (!blocked || isRecalledSoundOwner()) { play(); return; }
                try { await options.onBlocked?.(src); }
                finally { notifyRecalledSound(); }
            }).catch(() => { /* Failed verification/reset never plays the suspect audio. */ });
        }
    } catch {
        /* 播放失败静默，提示音不该影响聊天主流程 */
    }
};
