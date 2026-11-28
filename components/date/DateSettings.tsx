import {meetingAppearance} from '../../utils/meetingAppearance';
import MeetingAppearanceControl from './MeetingAppearanceControl';

import React, { useState, useRef, useEffect } from 'react';
import { useOS } from '../../context/OSContext';
import { CharacterProfile, SpriteConfig, DateStyleConfig, DateExperienceConfig } from '../../types';
import DateExperiencePicker from './DateExperiencePicker';
import { snapshotDateExperience } from '../../utils/dateExperience';
import { useBlobRefUrl } from '../../utils/blobRef';
import { pickDateFallbackSprite } from '../../utils/dateSprites';
import TokenImg from '../os/TokenImg';
import ObserveSettings from './ObserveSettings';
import DateExtraPresets from './DateExtraPresets';
import DateExtraEditor from './DateExtraEditor';
import DateArtworkSettings from './DateArtworkSettings';
import Section from './DateSettingsSection';
import { DateFeatureHeader, DateSettingSwitch } from './DateSettingsControls';
import { isAwayCloudRoute } from '../../utils/awayMessage';
import {
    DATE_LEAVE_MAX_MINUTES, DATE_LEAVE_MIN_MINUTES, disarmDateLeaveReminder, resolveDateLeaveDelayMinutes,
} from '../../utils/dateLeaveReminder';

// 标准情绪列表
const REQUIRED_EMOTIONS = ['normal', 'happy', 'angry', 'sad', 'shy'];
const DEFAULT_SPRITE_CONFIG: SpriteConfig = { scale: 1, x: 0, y: 0 };

interface DateSettingsProps {
    char: CharacterProfile;
    onBack: () => void;
    experience?: DateExperienceConfig;
    onExperienceChange?: (value: DateExperienceConfig) => void;
}

/** 见面离开提醒：见面对话中途走开多久，角色在私聊里找对方（见 docs/date-leave-reminder.md）。 */
const LeaveReminderSection: React.FC<{ char: CharacterProfile }> = ({ char }) => {
    const { updateCharacter } = useOS();
    const [open, setOpen] = useState(false);
    const enabled = !!char.dateLeaveReminder?.enabled;
    const savedDelay = resolveDateLeaveDelayMinutes(char);
    const [delay, setDelay] = useState(savedDelay);
    useEffect(() => setDelay(savedDelay), [savedDelay]);
    const [cloud, setCloud] = useState<boolean | null>(null);
    useEffect(() => {
        let cancelled = false;
        void isAwayCloudRoute(char).then(v => { if (!cancelled) setCloud(v); });
        return () => { cancelled = true; };
    }, [char]);

    // 关掉或改了时长都撤掉已经备好的那条（它带着旧时长），见面对话里会按新设置重新备好。
    const save = (next: { enabled: boolean; delayMinutes: number }) => {
        void disarmDateLeaveReminder({ char, updateCharacter });
        updateCharacter(char.id, { dateLeaveReminder: next });
    };
    // 拖动时只改显示，松手才保存：每一格都保存会反复撤掉、新建云端任务。
    const commitDelay = () => { if (delay !== savedDelay) save({ enabled, delayMinutes: delay }); };

    return (
        <section className="date-feature">
            <DateFeatureHeader title="离开提醒" description={`走开后没有继续找 ${char.name}，过一会儿 TA 会来私聊。`}
                open={open} onExpand={() => setOpen(value => !value)} checked={enabled} onChange={enabled => save({ enabled, delayMinutes: delay })} switchLabel="切换离开提醒" />
            {open && <div className="date-feature__body space-y-4">
                <p>见面聊到一半走开，如果没有回来或继续在私聊里找 {char.name}，过一会儿 TA 会在私聊里找你。</p>
                {enabled && (
                    <>
                        <div>
                            <div className="flex justify-between text-[10px] text-slate-500 mb-2"><span>走开多久后</span><span>{delay} 分钟</span></div>
                            <input
                                type="range" min={DATE_LEAVE_MIN_MINUTES} max={DATE_LEAVE_MAX_MINUTES} step={1} value={delay}
                                aria-label="走开多久后提醒"
                                onChange={e => setDelay(parseInt(e.target.value, 10))}
                                onPointerUp={commitDelay} onKeyUp={commitDelay} onBlur={commitDelay}
                                className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary"
                            />
                        </div>
                        {cloud !== null && (
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                                {cloud
                                    ? `${char.name} 开着主动消息 2.0：切出 SullyOS 也会推送给你，不受主动频率里的上限拦。`
                                    : `只在 SullyOS 开着时提醒，切出 SullyOS 或锁屏就不发了。开启主动消息 2.0 后切出去也能收到。`}
                            </p>
                        )}
                    </>
                )}
                {!enabled && <p>打开右侧开关后，可调整等待时长。</p>}
            </div>}
        </section>
    );
};

const ActionChoicesSection: React.FC<{ char: CharacterProfile }> = ({ char }) => {
    const { updateCharacter } = useOS();
    const [open, setOpen] = useState(false);
    return <section className="date-feature">
        <DateFeatureHeader title="行动选择" description="提供四种行动建议，选中后可补充再发送。"
            open={open} onExpand={() => setOpen(value => !value)} checked={char.dateActionChoicesEnabled === true}
            onChange={dateActionChoicesEnabled => updateCharacter(char.id, { dateActionChoicesEnabled })} switchLabel="开启行动选择" />
        {open && <div className="date-feature__body">从下一次开场或回复起，提供日常推进、申请变数、插科打诨、排斥反对四种建议。点选填入输入框，可修改、补充后再发送；不会自动代你行动。</div>}
    </section>;
};

const DateSettings: React.FC<DateSettingsProps> = ({ char, onBack, experience, onExperienceChange }) => {
    const { updateCharacter, addToast, userProfile } = useOS();
    const pageRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const [previewOpen, setPreviewOpen] = useState(true);
    useEffect(() => {
        const viewport = window.visualViewport;
        let frame = 0;
        const sync = () => {
            if (viewport && viewport.scale !== 1) return;
            const page = pageRef.current;
            if (!page) return;
            const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
            page.style.maxHeight = `${Math.max(0, bottom - page.getBoundingClientRect().top)}px`;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const focused = document.activeElement;
                const scroll = scrollRef.current;
                if (!(focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || focused instanceof HTMLSelectElement) || !scroll?.contains(focused)) return;
                const field = focused.getBoundingClientRect(), area = scroll.getBoundingClientRect();
                if (field.top < area.top || field.height > area.height) scroll.scrollTop += field.top - area.top - 8;
                else if (field.bottom > area.bottom) scroll.scrollTop += field.bottom - area.bottom + 8;
            });
        };
        sync();
        viewport?.addEventListener('resize', sync);
        viewport?.addEventListener('scroll', sync);
        window.addEventListener('resize', sync);
        pageRef.current?.addEventListener('focusin', sync);
        const page = pageRef.current;
        return () => {
            cancelAnimationFrame(frame);
            viewport?.removeEventListener('resize', sync);
            viewport?.removeEventListener('scroll', sync);
            window.removeEventListener('resize', sync);
            page?.removeEventListener('focusin', sync);
        };
    }, []);
    // 背景字段存的是 blobref 令牌（二进制在 IndexedDB），CSS url() 喂不了令牌，
    // 先在这里解析成能直接用的地址。非令牌值（旧 data: / 外链）原样透传。
    const dateBackgroundUrl = useBlobRefUrl(char.dateBackground);

    // 文风与叙事（即时生效：system prompt 每次请求重建，存上就影响下一条回复）
    const styleConfig = { ...char.dateStyleConfig, ...experience };
    const [extraDraft, setExtraDraft] = useState(styleConfig.extra || '');
    const [extraEditorOpen, setExtraEditorOpen] = useState(false);
    useEffect(() => { setExtraDraft(styleConfig.extra || ''); }, [char.id, styleConfig.extra]);
    const patchStyleConfig = (patch: Partial<DateStyleConfig>) => {
        if (onExperienceChange && !('pov' in patch)) {
            onExperienceChange(snapshotDateExperience({ ...styleConfig, ...patch }));
        } else updateCharacter(char.id, previous => ({ dateStyleConfig: { ...previous.dateStyleConfig, ...patch } }));
    };
    const saveExtraDraft = () => {
        const trimmed = extraDraft.trim();
        if (trimmed === (styleConfig.extra || '')) return;
        patchStyleConfig({ extra: trimmed || undefined });
        addToast(trimmed ? '补充要求已保存' : '补充要求已清空', 'success');
    };
    const readingAppearance = meetingAppearance(char.dateAppearance);
    const userName = userProfile?.name || '用户';
    const POV_OPTIONS: { id: DateStyleConfig['pov']; label: string; example: string }[] = [
        { id: undefined, label: '默认', example: '不额外指定，随模型发挥' },
        { id: 'third-name', label: '第三人称 · 称名字', example: `${char.name}看着${userName}` },
        { id: 'third-you', label: '第三人称 · 称"你"', example: `${char.name}看着你` },
        { id: 'first-you', label: '第一人称', example: '我看着你' },
    ];

    const [tempSpriteConfig, setTempSpriteConfig] = useState<SpriteConfig>(char.spriteConfig || DEFAULT_SPRITE_CONFIG);
    const pendingSpriteConfig = useRef<SpriteConfig | null>(null);
    const updateCharacterRef = useRef(updateCharacter);
    updateCharacterRef.current = updateCharacter;
    const commitSpriteConfig = () => {
        const next = pendingSpriteConfig.current;
        if (!next) return;
        pendingSpriteConfig.current = null;
        updateCharacterRef.current(char.id, { spriteConfig: next });
    };
    const changeSpriteConfig = (patch: Partial<SpriteConfig>) => {
        const next = { ...(pendingSpriteConfig.current || tempSpriteConfig), ...patch };
        pendingSpriteConfig.current = next;
        setTempSpriteConfig(next);
    };
    // 拖动即时预览，松手/键盘调整后落库；退出也写入尚未结束的调整，避免逐帧写库。
    const spriteSliderEvents = { onPointerUp: commitSpriteConfig, onPointerCancel: commitSpriteConfig, onKeyUp: commitSpriteConfig, onBlur: commitSpriteConfig };
    const skinSets = char.dateSkinSets || [];
    const activeSkinId = char.activeSkinSetId || null;

    useEffect(() => {
        setTempSpriteConfig(char.spriteConfig || DEFAULT_SPRITE_CONFIG);
        return () => {
            const next = pendingSpriteConfig.current;
            pendingSpriteConfig.current = null;
            if (next) updateCharacterRef.current(char.id, { spriteConfig: next });
        };
    }, [char.id]);

    const sprites = char.sprites || {};
    // Preview shows active skin set's sprites if one is selected
    const previewSprites = React.useMemo(() => {
        if (activeSkinId) {
            const skin = skinSets.find(s => s.id === activeSkinId);
            if (skin && Object.keys(skin.sprites).length > 0) return skin.sprites;
        }
        return sprites;
    }, [activeSkinId, skinSets, sprites]);
    const currentSpriteImg = pickDateFallbackSprite(
        previewSprites,
        [...REQUIRED_EMOTIONS, ...(char.customDateSprites || [])],
        char.avatar,
    );

    return (
        <div ref={pageRef} className="h-full min-h-0 w-full bg-slate-50 text-slate-800 flex flex-col overflow-hidden">
            <header className="bg-white shrink-0 z-20" style={{ paddingTop: 'var(--chrome-top)' }}>
                <div className="h-16 flex items-center justify-between px-4 border-b border-slate-200">
                    <button aria-label="返回" onClick={onBack} className="min-h-11 min-w-11 p-2 -ml-2 text-slate-600 active:scale-95 transition-transform">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                    </button>
                    <span className="font-bold text-slate-700">场景布置</span>
                    <div className="w-8" />
                </div>
            </header>
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain" data-testid="date-settings-scroll">
            <MeetingAppearanceControl surface="date" characterId={char.id} />
            <button type="button" onClick={() => setPreviewOpen(open => !open)} aria-expanded={previewOpen}
                className="w-full px-5 py-3 text-left text-xs font-bold text-slate-500 bg-white border-b border-slate-100">
                {previewOpen ? '收起场景预览' : '展开场景预览'}
            </button>
            {/* Live Preview Area */}
            {previewOpen && <div className="h-64 bg-black relative overflow-hidden shrink-0 border-b border-slate-200">
                {readingAppearance.id!=='none'&&<div className="absolute inset-0 z-10 px-8 py-6 font-serif leading-8" style={{background:readingAppearance.background,color:readingAppearance.ink}}><small className="text-xs opacity-50">{readingAppearance.name} · 阅读预览</small><p className="mt-4">窗边的灯亮了，书页上留下了一小片暖色。</p><p>“今天读到哪里了？”</p><p>他把书签夹好，慢慢合上书。</p></div>}
                    <div className="absolute inset-0 bg-cover bg-center opacity-60" style={{ backgroundImage: dateBackgroundUrl ? `url("${dateBackgroundUrl}")` : 'none' }}></div>
                    <div className="absolute inset-0 flex items-end justify-center pointer-events-none">
                        <TokenImg
                        value={currentSpriteImg}
                        className="max-h-[90%] object-contain transition-transform"
                        style={{ 
                            transform: `translate(${tempSpriteConfig.x}%, ${tempSpriteConfig.y}%) scale(${tempSpriteConfig.scale})`
                        }}
                        />
                    </div>
                    <div className="absolute top-2 left-2 bg-black/50 text-white text-[10px] px-2 py-1 rounded backdrop-blur-sm">预览</div>
            </div>}

            <div className="p-5 space-y-8">
                <Section title="立绘位置调整">
                    <div className="space-y-6">
                        <div>
                            <div className="flex justify-between text-[10px] text-slate-500 mb-2"><span>大小缩放</span><span>{tempSpriteConfig.scale.toFixed(1)} 倍</span></div>
                            <input aria-label="立绘大小缩放" type="range" min="0.5" max="2.0" step="0.1" value={tempSpriteConfig.scale} onChange={e => changeSpriteConfig({ scale: parseFloat(e.target.value) })} {...spriteSliderEvents} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary" />
                        </div>
                        <div>
                            <div className="flex justify-between text-[10px] text-slate-500 mb-2"><span>左右偏移</span><span>{tempSpriteConfig.x}%</span></div>
                            <input aria-label="立绘左右偏移" type="range" min="-100" max="100" step="5" value={tempSpriteConfig.x} onChange={e => changeSpriteConfig({ x: parseInt(e.target.value) })} {...spriteSliderEvents} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary" />
                        </div>
                            <div>
                            <div className="flex justify-between text-[10px] text-slate-500 mb-2"><span>上下偏移</span><span>{tempSpriteConfig.y}%</span></div>
                            <input aria-label="立绘上下偏移" type="range" min="-50" max="50" step="5" value={tempSpriteConfig.y} onChange={e => changeSpriteConfig({ y: parseInt(e.target.value) })} {...spriteSliderEvents} className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-primary" />
                        </div>
                    </div>
                </Section>

                {readingAppearance.id=== 'none' && <section className="bg-white rounded-2xl border border-slate-100 shadow-sm divide-y divide-slate-100">
                    <div className="flex items-center justify-between gap-4 p-4">
                        <div className="min-w-0">
                            <h3 className="text-xs font-bold text-slate-400 uppercase">浅色阅读模式</h3>
                            <p className="text-[11px] text-slate-400 mt-1">小说视图使用浅色背景，减少眼睛疲劳</p>
                        </div>
                        <DateSettingSwitch label="切换浅色阅读模式" checked={!!char.dateLightReading} onChange={dateLightReading => updateCharacter(char.id, { dateLightReading })} />
                    </div>
                    <div className="flex items-center justify-between gap-4 p-4">
                        <div className="min-w-0">
                            <h3 className="text-xs font-bold text-slate-400 uppercase">阅读模式显示头像</h3>
                            <p className="text-[11px] text-slate-400 mt-1">在双方的见面记录旁显示对应头像</p>
                        </div>
                        <DateSettingSwitch label="切换阅读模式头像" checked={!!char.dateReadingShowAvatars} onChange={dateReadingShowAvatars => updateCharacter(char.id, { dateReadingShowAvatars })} />
                    </div>
                </section>}

                <section className="date-settings-features" aria-label="见面互动设置">
                    <ObserveSettings char={char} />
                    <ActionChoicesSection char={char} />
                    <LeaveReminderSection char={char} />
                </section>

                <Section title="场景与写法" defaultOpen>
                    <p className="text-[11px] text-slate-400 mt-1 mb-4">从下一条回复开始生效。</p>
                        <DateExperiencePicker value={snapshotDateExperience(styleConfig)} presets={char.dateExtraPresets}
                            hidePreset hideExtras onChange={next => { setExtraDraft(next.extra || ''); patchStyleConfig(next); }}
                            onReset={onExperienceChange ? () => onExperienceChange(snapshotDateExperience(char.dateStyleConfig)) : undefined}
                            onSaveDefault={onExperienceChange ? () => updateCharacter(char.id, previous => ({ dateStyleConfig: { ...previous.dateStyleConfig, ...snapshotDateExperience({ ...styleConfig, extra: extraDraft }) } })) : undefined}>
                    <section className="date-writing__group" aria-label="叙事人称">
                        <h4 className="date-writing__heading">叙述视角 · 用谁的口吻</h4>
                        <div className="date-writing__choices">{POV_OPTIONS.map(opt => <button type="button" key={opt.id || 'default'} className="date-writing__choice" aria-pressed={(styleConfig.pov || '') === (opt.id || '')} onClick={() => patchStyleConfig({ pov: opt.id })}><span>{opt.label}</span><small>{opt.example}</small></button>)}</div>
                        <p className="date-writing__hint">人称随角色保存，不随本场文风或预设改变。</p>
                    </section>
                    <section className="date-writing__group">
                    <h4 className="date-writing__heading">补充要求 · 还有什么偏好</h4>
                    <div className="mb-4 flex items-center justify-between">
                        <div className="pr-4">
                            <label className="text-[11px] text-slate-500 font-bold block">细节深挖引导</label>
                            <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">从已有对话和现场细节中寻找可选线索，减少空话；不相关时可以跳过，也允许简短回应。</p>
                        </div>
                        <DateSettingSwitch label="细节深挖引导" checked={styleConfig.digDeeper !== false} onChange={enabled => patchStyleConfig({ digDeeper: enabled ? undefined : false })} />
                    </div>

                    {/* 自定义补充 */}
                    <div>

                        <div className="relative">
                        <textarea
                            aria-label="自定义补充"
                            value={extraDraft}
                            onChange={e => setExtraDraft(e.target.value)}
                            onBlur={saveExtraDraft}
                            placeholder="比如：多写环境互动；不要写心理活动；对话占比多一些……"
                            className="w-full h-28 px-4 pt-3 pb-11 bg-slate-100 text-slate-800 placeholder:text-slate-400 rounded-xl text-sm resize-none focus:ring-1 focus:ring-primary/30 outline-none transition-all leading-relaxed"
                        />
                        <button type="button" aria-label="展开自定义补充" onClick={() => setExtraEditorOpen(true)}
                            className="absolute bottom-2 right-2 px-3 py-1.5 rounded-lg bg-white text-xs font-semibold text-primary shadow-sm">↗ 展开</button>
                        </div>
                        <p className="text-[10px] text-slate-300 mt-1">点别处会自动保存；这段会照原样用上，比上面的风格优先。</p>
                    </div>
                    </section>
                    <details className="py-4"><summary className="cursor-pointer text-xs text-slate-500 mb-3">我的预设 · 保存与管理</summary>
                        <DateExtraPresets key={char.id} presets={char.dateExtraPresets || []} value={extraDraft}
                            experience={snapshotDateExperience({ ...styleConfig, extra: extraDraft })}
                            onApply={(content, savedExperience) => { const next = savedExperience ? snapshotDateExperience(savedExperience) : { extra: content }; setExtraDraft(next.extra || ''); patchStyleConfig(next); }}
                            onChange={dateExtraPresets => updateCharacter(char.id, { dateExtraPresets })} />
                    </details>
                        </DateExperiencePicker>
                </Section>



                <DateArtworkSettings char={char} />
            </div>

            {extraEditorOpen && <DateExtraEditor key={char.id} value={extraDraft} onChange={setExtraDraft}
                onClose={() => { saveExtraDraft(); setExtraEditorOpen(false); }} />}

            </div>
        </div>
    );
};

export default DateSettings;
