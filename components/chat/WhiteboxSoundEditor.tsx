import React, { useRef, useState } from 'react';
import { readShareText } from '../../utils/pngShare';
import { shareOrDownloadFile } from '../../utils/shareExport';
import {
    BUILTIN_SOUNDS,
    WhiteboxSound,
    playWhiteboxSound,
    unlockWhiteboxAudio,
    isCustomAudioSrc,
    encodeSoundShare,
    decodeSoundShare,
} from '../../utils/whiteboxSound';

// 白框「提示音」编辑器（独立于白框 CSS）。
//
// 触发时机（播放逻辑见 apps/Chat.tsx）：仅当"ta 新发的消息"成为会话最后一条时响一次；
// 你自己发消息 / 翻旧记录都不会响。
//
// 存储与分享：
// - 默认「解绑」——提示音独立存在角色字段里，样式分享码保持轻量、纯 CSS。提示音可用下方「分享码」单独传。
// - 打开「绑定到进阶样式」——提示音会写进白框 CSS 的指令注释，跟白框一起分享出去（随时可解绑）。
// 本组件不关心存哪，只吐出 (sound, bound) 的变化，落地位置由 Chat.tsx 决定。

// 上传音频转 data URI 的体积上限：绑定分享时会进分享码，太大会爆；提示音本就该短，200KB 足够。
const MAX_UPLOAD_BYTES = 200 * 1024;

const readFileAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });

const copyText = async (text: string): Promise<boolean> => {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch { return false; }
};

interface Props {
    sound: WhiteboxSound | null;
    onChangeSound: (sound: WhiteboxSound | null) => void;
    /** 「绑定到进阶样式」开关；全局默认提示音不涉及绑定，传 false 隐藏。默认显示。 */
    showBind?: boolean;
    bound?: boolean;
    onChangeBound?: (bound: boolean) => void;
    /** 顶部提示条文案（区分「角色版」与「全局默认版」）。 */
    hint?: React.ReactNode;
}

const WhiteboxSoundEditor: React.FC<Props> = ({ sound, onChangeSound, showBind = true, bound = false, onChangeBound, hint }) => {
    const volume = sound?.volume ?? 0.6;
    const src = sound?.src || '';
    const isBuiltin = !!BUILTIN_SOUNDS[src];
    const isCustom = !!src && isCustomAudioSrc(src);
    const isUpload = isCustom && !/^https?:/i.test(src);

    const [urlDraft, setUrlDraft] = useState(isCustom && /^https?:/i.test(src) ? src : '');
    const [busy, setBusy] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);

    const pickBuiltin = (key: string) => {
        unlockWhiteboxAudio();
        const next = { src: key, volume };
        onChangeSound(next);
        playWhiteboxSound(next); // 点一下即试听
    };

    const setVolume = (v: number) => {
        if (!src) return;
        onChangeSound({ src, volume: v });
    };

    const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        if (!file.type.startsWith('audio/')) { window.alert('请选择音频文件（mp3 / wav / ogg 等）。'); return; }
        if (file.size > MAX_UPLOAD_BYTES) {
            window.alert(`音频太大（${Math.round(file.size / 1024)}KB）。绑定到进阶样式分享时会进分享码，请用 ≤ ${MAX_UPLOAD_BYTES / 1024}KB 的短提示音，或改用「音频 URL」。`);
            return;
        }
        setBusy(true);
        try {
            const dataUrl = await readFileAsDataUrl(file);
            unlockWhiteboxAudio();
            const next = { src: dataUrl, volume };
            onChangeSound(next);
            playWhiteboxSound(next);
        } catch {
            window.alert('读取音频失败，请换个文件重试。');
        } finally {
            setBusy(false);
        }
    };

    const applyUrl = () => {
        const u = urlDraft.trim();
        if (!u) return;
        if (!/^https?:\/\//i.test(u)) { window.alert('请填写 http(s):// 开头的音频直链。'); return; }
        unlockWhiteboxAudio();
        const next = { src: u, volume };
        onChangeSound(next);
        playWhiteboxSound(next);
    };

    const clearSound = () => { onChangeSound(null); setUrlDraft(''); };

    const handleShareExport = async () => {
        if (!sound) return;
        const ok = await copyText(encodeSoundShare(sound));
        window.alert(ok ? '已复制提示音分享码，发给别人粘贴导入即可（不含界面样式）。' : '复制失败，请重试。');
    };
    const handleShareImport = () => {
        const code = window.prompt('粘贴提示音分享码（SULLYSND1:...）：', '')?.trim();
        if (!code) return;
        importSoundCode(code);
    };
    const importSoundCode = (code: string) => {
        const incoming = decodeSoundShare(code);
        if (!incoming) { window.alert('分享码无法识别，请确认完整粘贴。'); return; }
        unlockWhiteboxAudio();
        onChangeSound(incoming);
        playWhiteboxSound(incoming);
    };

    const chipCls = (active: boolean) =>
        `rounded-full px-3 py-1.5 text-[11px] font-semibold transition-all active:scale-95 ${
            active ? 'bg-indigo-500 text-white shadow-sm' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
        }`;

    return (
        <div className="space-y-4">
            <div className="rounded-2xl border border-amber-100 bg-amber-50/70 px-3.5 py-2.5 text-[11px] leading-relaxed text-amber-700">
                {hint ?? <>🔔 提示音只在 <b>ta 新发的消息成为最新一条</b> 时响一次；你自己发消息、翻旧记录都不会响。</>}
            </div>

            {/* 内置音效 */}
            <div>
                <div className="mb-2 text-[11px] font-bold text-slate-500">内置音效 <span className="font-normal text-slate-400">· 点一下试听并选用</span></div>
                <div className="flex flex-wrap gap-1.5">
                    {Object.entries(BUILTIN_SOUNDS).map(([key, s]) => (
                        <button key={key} onClick={() => pickBuiltin(key)} className={chipCls(isBuiltin && src === key)}>
                            {isBuiltin && src === key ? '✓ ' : ''}{s.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* 上传 / URL */}
            <div>
                <div className="mb-2 text-[11px] font-bold text-slate-500">自定义 <span className="font-normal text-slate-400">· 上传音频（≤200KB）或填直链</span></div>
                <div className="flex flex-wrap items-center gap-2">
                    <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={handleUpload} />
                    <button
                        onClick={() => fileRef.current?.click()}
                        disabled={busy}
                        className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-[11px] font-semibold text-indigo-600 hover:bg-indigo-100 disabled:opacity-50"
                    >{busy ? '读取中…' : '⬆ 上传音频文件'}</button>
                    {isUpload && (
                        <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-600">已内嵌上传音频 ✓</span>
                    )}
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                    <input
                        value={urlDraft}
                        onChange={(e) => setUrlDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') applyUrl(); }}
                        placeholder="https://…/ding.mp3"
                        className="min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-[11px] text-slate-600 outline-none focus:border-indigo-300"
                    />
                    <button onClick={applyUrl} className="shrink-0 rounded-xl bg-slate-100 px-3 py-1.5 text-[11px] font-semibold text-slate-500 hover:bg-slate-200">用此链接</button>
                </div>
            </div>

            {/* 音量 + 试听 + 关闭 */}
            <div>
                <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-bold text-slate-500">音量</span>
                    <span className="text-[10px] text-slate-400">{Math.round(volume * 100)}%</span>
                </div>
                <input
                    type="range" min={0} max={1} step={0.05} value={volume}
                    disabled={!src}
                    onChange={(e) => setVolume(Number(e.target.value))}
                    className="w-full accent-indigo-500 disabled:opacity-40"
                />
                <div className="mt-3 flex items-center gap-2">
                    <button
                        onClick={() => { unlockWhiteboxAudio(); playWhiteboxSound(sound); }}
                        disabled={!src}
                        className="rounded-xl bg-indigo-500 px-4 py-1.5 text-[11px] font-bold text-white hover:bg-indigo-600 disabled:opacity-40"
                    >▶ 试听</button>
                    {src && (
                        <button onClick={clearSound} className="rounded-xl px-3 py-1.5 text-[11px] font-semibold text-rose-400 hover:bg-rose-50 hover:text-rose-500">关闭提示音</button>
                    )}
                    <span className="ml-auto text-[10px] text-slate-400">
                        {src ? (isBuiltin ? '当前：内置音效' : '当前：自定义音频') : '当前：无'}
                    </span>
                </div>
            </div>

            {/* 绑定到进阶样式 开关（全局默认版不显示） */}
            {showBind && (
                <div className="rounded-2xl border border-slate-100 bg-slate-50/70 px-3.5 py-3">
                    <label className="flex cursor-pointer items-start gap-3">
                        <input
                            type="checkbox"
                            checked={bound}
                            onChange={(e) => onChangeBound?.(e.target.checked)}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-500"
                        />
                        <span className="min-w-0">
                            <span className="block text-[12px] font-bold text-slate-700">绑定到进阶样式一起分享</span>
                            <span className="block text-[10px] leading-snug text-slate-400">
                                {bound
                                    ? '已绑定：分享这套样式时会带上提示音（上传的音频会进分享码，可能变大）。'
                                    : '未绑定：样式分享码保持轻量、只含皮肤；提示音用下方分享码单独传。'}
                            </span>
                        </span>
                    </label>
                </div>
            )}

            {/* 提示音独立分享码 */}
            <div className="flex flex-wrap gap-2">
                <label className="cursor-pointer rounded-lg px-2.5 py-1 text-[10px] font-semibold text-indigo-500">图片导入
                    <input type="file" accept=".png,.txt,image/png,text/plain" className="sr-only" onChange={async event => {
                        const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
                        try { importSoundCode(await readShareText(file, 'whitebox-sound')); }
                        catch (error: any) { window.alert(error?.message || '提示音导入失败'); }
                    }} />
                </label>
                <button disabled={!sound} className="rounded-lg px-2.5 py-1 text-[10px] font-semibold text-indigo-500 disabled:opacity-30" onClick={async () => {
                    if (!sound) return;
                    try { await shareOrDownloadFile({ content: encodeSoundShare(sound), fileName: '白框提示音.txt', mimeType: 'text/plain', card: { kind: 'whitebox-sound', title: '白框提示音' } }); }
                    catch (error: any) { window.alert(error?.message || '提示音导出失败'); }
                }}>图片分享</button>
            </div>
            <div className="flex items-center gap-2">
                <button onClick={handleShareImport} className="rounded-lg px-2.5 py-1 text-[10px] font-semibold text-slate-400 hover:bg-slate-100 hover:text-slate-600">导入分享码</button>
                <button onClick={handleShareExport} disabled={!sound} className={`rounded-lg px-2.5 py-1 text-[10px] font-semibold ${sound ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-600' : 'text-slate-300'}`}>导出分享码</button>
                <span className="ml-auto text-[10px] text-slate-300">SULLYSND1 · 单独分享提示音</span>
            </div>
        </div>
    );
};

export default WhiteboxSoundEditor;
