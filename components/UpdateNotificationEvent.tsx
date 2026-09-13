import { SARUpdatePopup } from './os/SARUpdatePopup';
import { SAR_UPDATE_KEY, SAR_CHANGELOG, sarLaunch } from '../utils/sarUpdate';
/**
 * 全局版本更新提醒。
 *
 * 每个版本使用独立的 localStorage key；用户明确选择「立刻体验」或「先逛逛」后
 * 才会记为已读，避免仅仅渲染过一次就把通知吞掉。
 */

import React from 'react';
import {
    ArrowRight, BellRinging, Briefcase, ChatTeardropDots, FileText, FolderOpen, PaperPlaneTilt, Sparkle, VideoCamera,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';
import { trackEvent } from '../utils/analytics';
import { requestProxyWorkerSettingsFocus } from '../utils/proxyWorker';

// 历史 key —— 保留给备份兼容与旧版本日志使用。
export const UPDATE_NOTIFICATION_KEY = 'sullyos_update_2026_04_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05 = 'sullyos_update_2026_05_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05_10 = 'sullyos_update_2026_05_10_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05_17 = 'sullyos_update_2026_05_17_seen';
export const UPDATE_NOTIFICATION_KEY_2026_05_25 = 'sullyos_update_2026_05_25_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_05 = 'sullyos_update_2026_06_05_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_14 = 'sullyos_update_2026_06_14_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_21 = 'sullyos_update_2026_06_21_seen';
export const UPDATE_NOTIFICATION_KEY_2026_06_26 = 'sullyos_update_2026_06_26_seen';
export const UPDATE_NOTIFICATION_KEY_2026_07_10 = 'sullyos_update_2026_07_10_seen';
// 本次更新：主动消息 2.0。
export const UPDATE_NOTIFICATION_KEY_2026_08_03 = 'sullyos_update_2026_08_03_amsg2_seen';
// 本次更新：Live2D 视频通话与陪伴桌面。
export const UPDATE_NOTIFICATION_KEY_2026_08_10 = 'sullyos_update_2026_08_10_live2d_seen';
// 本次更新：角色协同工作台。
export const UPDATE_NOTIFICATION_KEY_2026_08_30 = 'sullyos_update_2026_08_30_collaboration_seen';
// 例行维护补充：静态网页环境下部分联网功能的数据流说明。
export const NETWORK_TRANSIT_NOTICE_KEY_2026_08 = 'sullyos_notice_2026_08_network_transit_seen';

export const FAQ_TARGET_SECTION_KEY = 'sullyos_faq_target_section';
export const CHANGELOG_2026_04 = 'changelog-2026-04';
export const CHANGELOG_2026_05 = 'changelog-2026-05';
export const CHANGELOG_2026_05_10 = 'changelog-2026-05-10';
export const CHANGELOG_2026_05_17 = 'changelog-2026-05-17';
export const CHANGELOG_2026_05_27 = 'changelog-2026-05-27';
export const CHANGELOG_2026_06_05 = 'changelog-2026-06-05';
export const CHANGELOG_2026_06_14 = 'changelog-2026-06-14';
export const CHANGELOG_2026_06_21 = 'changelog-2026-06-21';
export const CHANGELOG_2026_06_26 = 'changelog-2026-06-26';
export const CHANGELOG_2026_07_10 = 'changelog-2026-07-10';
export const CHANGELOG_2026_08_03 = 'changelog-2026-08-03';
export const CHANGELOG_2026_08_10 = 'changelog-2026-08-10';
export const CHANGELOG_2026_08_30 = 'changelog-2026-08-30';

/** storage 读不出来时当成看过：宁可少弹一次，也别每次开机都糊用户一脸。 */
const isUpdateSeen = (key: string): boolean => {
    try {
        return !!localStorage.getItem(key);
    } catch {
        return true;
    }
};

const markUpdateSeen = (key: string): void => {
    try {
        localStorage.setItem(key, Date.now().toString());
    } catch { /* storage 不可用时不阻断按钮行为 */ }
};

interface UpdatePopupProps {
    /** 这条用户自己关掉了 —— 接着弹队列里的下一条。 */
    onDone: () => void;
    /**
     * 用户点了「立刻体验」这类按钮、已经被带去别的 App 了 —— 整串提醒收起来。
     * 后面那几条不标已读，下次启动照弹，免得刚跳过去就被新弹窗盖住。
     */
    onExit: () => void;
}

const COLLABORATION_FEATURES = [
    { icon: Briefcase, eyebrow: '两种协同模式', text: '保留完整陪伴上下文，或只带核心关系与少量相关记忆。' },
    { icon: FileText, eyebrow: '真正交付文件', text: '读取 Word / PDF，制作并分享文档，也能把成果交回日常聊天。' },
    { icon: FolderOpen, eyebrow: '制作、预览、安装', text: '气泡、白框、界面、日记本、角色卡与世界书都能边聊边做。' },
] as const;

const CollaborationUpdatePopup: React.FC<UpdatePopupProps> = ({ onDone, onExit }) => {
    const { openApp } = useOS();

    React.useEffect(() => {
        trackEvent('弹出版本更新提醒', { 版本: CHANGELOG_2026_08_30 });
    }, []);

    const markSeen = () => markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_30);
    const handleOpenChat = () => {
        markSeen();
        openApp(AppID.Chat);
        onExit();
        trackEvent('点立刻体验', { 版本: CHANGELOG_2026_08_30 });
    };
    const handleGuide = () => {
        markSeen();
        try { sessionStorage.setItem(FAQ_TARGET_SECTION_KEY, CHANGELOG_2026_08_30); } catch { /* 打开手册首页 */ }
        openApp(AppID.FAQ);
        onExit();
        trackEvent('查看更新说明', { 版本: CHANGELOG_2026_08_30 });
    };
    const handleDismiss = () => {
        markSeen();
        onDone();
        trackEvent('跳过本次更新说明', { 版本: CHANGELOG_2026_08_30 });
    };

    return (
        <div
            className="collaboration-update-overlay fixed inset-0 z-[9998] flex items-start justify-center overflow-y-auto bg-[#10111a]/75 px-4 backdrop-blur-md"
            style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))', paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="collaboration-update-title"
        >
            <style>{`
                @keyframes collaborationUpdateIn { from { opacity:0; transform:translateY(22px) scale(.98); } to { opacity:1; transform:none; } }
                @keyframes collaborationUpdateReveal { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
                .collaboration-update-card{animation:collaborationUpdateIn 440ms cubic-bezier(.2,.8,.2,1) both}
                .collaboration-update-reveal{animation:collaborationUpdateReveal 380ms ease-out both}
                @media (prefers-reduced-motion:reduce){.collaboration-update-card,.collaboration-update-reveal{animation:none!important}}
            `}</style>
            <section className="collaboration-update-card relative my-auto w-full max-w-[23rem] overflow-hidden rounded-[2rem] bg-[#faf9f6] text-[#20212a] shadow-[0_28px_85px_rgba(0,0,0,.48)] ring-1 ring-white/20">
                <div className="relative overflow-hidden bg-[#20212a] px-6 pb-7 pt-6 text-white">
                    <div className="pointer-events-none absolute right-[-4rem] top-[-5rem] h-48 w-48 rounded-full border-[28px] border-[#7772ff]/20" aria-hidden="true" />
                    <div className="collaboration-update-reveal relative flex items-center justify-between">
                        <p className="text-[9px] font-bold tracking-[.3em] text-[#aaa6ff]">COLLABORATION · 2026.08.30</p>
                        <span className="rounded-full border border-[#8e89ff]/40 px-2.5 py-1 text-[9px] font-bold tracking-[.12em] text-[#c5c2ff]">NEW</span>
                    </div>
                    <div className="collaboration-update-reveal relative mt-8 max-w-[17rem]" style={{ animationDelay: '90ms' }}>
                        <p className="mb-2 text-[10px] font-semibold tracking-[.18em] text-[#9f9aff]">陪伴之外，一起把事情做好</p>
                        <h2 id="collaboration-update-title" className="text-[28px] font-black leading-[1.22] tracking-[-.04em]">角色现在有了<br />自己的协同工作台。</h2>
                        <p className="mt-3 text-[12px] leading-6 text-[#c9cad2]">还是同一个人，只是把更多注意力放在制作、检查和交付上。</p>
                    </div>
                </div>

                <div className="px-6 pb-5 pt-5">
                    <div className="divide-y divide-[#e3e0d9]">
                        {COLLABORATION_FEATURES.map(({ icon: Icon, eyebrow, text }, index) => (
                            <div key={eyebrow} className="collaboration-update-reveal flex items-start gap-3 py-3 first:pt-0" style={{ animationDelay: `${170 + index * 65}ms` }}>
                                <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#ebe9ff] text-[#5650c9]"><Icon size={18} weight="duotone" /></div>
                                <div><p className="text-[12px] font-extrabold text-[#32303f]">{eyebrow}</p><p className="mt-1 text-[11px] leading-5 text-[#74737b]">{text}</p></div>
                            </div>
                        ))}
                    </div>

                    <div className="collaboration-update-reveal mt-3 border-l-2 border-[#6d67e8] bg-[#f0efff] px-3 py-2.5 text-[11px] leading-5 text-[#555172]" style={{ animationDelay: '370ms' }}>
                        入口：打开一位角色的 <b>ChatApp</b>，点输入框左侧的 <b>＋</b>，在加号菜单第一页选择 <b>「协同工作」</b>。
                    </div>

                    <div className="collaboration-update-reveal mt-5" style={{ animationDelay: '430ms' }}>
                        <button type="button" onClick={handleOpenChat} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#25242d] px-5 py-3.5 text-[13px] font-extrabold text-white transition-transform active:scale-[.975]">打开 ChatApp <ArrowRight size={16} weight="bold" /></button>
                        <div className="mt-1.5 grid grid-cols-2 gap-2">
                            <button type="button" onClick={handleGuide} className="rounded-xl py-2.5 text-[11px] font-semibold text-[#585465] active:bg-[#efedf0]">查看完整说明</button>
                            <button type="button" onClick={handleDismiss} className="rounded-xl py-2.5 text-[11px] font-semibold text-[#8b8990] active:bg-[#efedf0]">稍后看看</button>
                        </div>
                    </div>
                </div>
            </section>
        </div>
    );
};

const LIVE2D_FEATURES = [
    {
        icon: VideoCamera,
        eyebrow: '视频通话',
        text: '电话里切到「视频」，VRM / Live2D 会跟着台词做表情与动作。',
    },
    {
        icon: Sparkle,
        eyebrow: 'L2D 陪伴桌面',
        text: '在外观里启用「触感陪伴」，让角色常驻桌面、回应触摸并切换专属框架。',
    },
] as const;

const Live2DUpdatePopup: React.FC<UpdatePopupProps> = ({ onDone, onExit }) => {
    const { openApp } = useOS();

    React.useEffect(() => {
        trackEvent('弹出版本更新提醒', { 版本: CHANGELOG_2026_08_10 });
    }, []);

    const handleGuide = () => {
        markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_10);
        try {
            sessionStorage.setItem(FAQ_TARGET_SECTION_KEY, CHANGELOG_2026_08_10);
        } catch { /* storage 不可用时仍可打开使用手册首页 */ }
        openApp(AppID.FAQ);
        onExit();
        trackEvent('点立刻体验', { 版本: CHANGELOG_2026_08_10 });
    };

    const handleDismiss = () => {
        markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_10);
        onDone();
        trackEvent('跳过本次更新说明', { 版本: CHANGELOG_2026_08_10 });
    };

    return (
        <div
            className="live2d-update-overlay fixed inset-0 z-[9998] flex items-start justify-center overflow-y-auto bg-[#070b14]/80 px-4 backdrop-blur-md"
            style={{
                paddingTop: 'max(1rem, env(safe-area-inset-top))',
                paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="live2d-update-title"
        >
            <style>{`
                @keyframes live2dUpdateOverlayIn { from { opacity: 0; } to { opacity: 1; } }
                @keyframes live2dUpdateCardIn {
                    from { opacity: 0; transform: translateY(22px) scale(.975); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes live2dUpdateReveal {
                    from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes live2dSignal { 0%, 100% { opacity: .35; } 50% { opacity: .9; } }
                .live2d-update-overlay { animation: live2dUpdateOverlayIn 220ms ease-out both; }
                .live2d-update-card { animation: live2dUpdateCardIn 460ms cubic-bezier(.2,.8,.2,1) both; }
                .live2d-update-reveal { animation: live2dUpdateReveal 420ms ease-out both; }
                .live2d-update-signal { animation: live2dSignal 2.4s ease-in-out infinite; }
                @media (prefers-reduced-motion: reduce) {
                    .live2d-update-overlay,
                    .live2d-update-card,
                    .live2d-update-reveal,
                    .live2d-update-signal { animation: none !important; }
                    .live2d-update-action { transition: none !important; }
                }
            `}</style>

            <section className="live2d-update-card relative my-auto w-full max-w-[23rem] overflow-hidden rounded-[2rem] bg-[#f5f7fb] text-[#17202b] shadow-[0_28px_90px_rgba(0,0,0,0.58)] ring-1 ring-white/20">
                <div className="relative min-h-[15.5rem] overflow-hidden bg-[linear-gradient(150deg,#111a2c_0%,#18283b_52%,#253a43_100%)] px-6 pb-7 pt-6 text-white">
                    <div className="pointer-events-none absolute -right-12 -top-10 h-44 w-44 rounded-full bg-[#6fffe1]/15 blur-3xl" aria-hidden="true" />
                    <div className="pointer-events-none absolute bottom-0 right-3 h-[12.5rem] w-[10rem]" aria-hidden="true">
                        <div className="absolute left-1/2 top-0 h-16 w-16 -translate-x-1/2 rounded-full border border-[#9effec]/25 bg-[#82dec8]/10 shadow-[0_0_32px_rgba(111,255,225,.12)]" />
                        <div className="absolute bottom-0 left-1/2 h-36 w-28 -translate-x-1/2 rounded-t-[50%] border-x border-t border-[#9effec]/20 bg-[linear-gradient(180deg,rgba(111,255,225,.08),rgba(58,91,104,.25))]" />
                        <div className="absolute inset-y-4 left-1/2 w-px bg-[#9effec]/20" />
                    </div>
                    <div className="live2d-update-signal pointer-events-none absolute inset-x-5 bottom-5 h-px bg-[linear-gradient(90deg,transparent,#76f7dc,transparent)]" aria-hidden="true" />

                    <div className="live2d-update-reveal relative flex items-center justify-between" style={{ animationDelay: '80ms' }}>
                        <p className="text-[9px] font-bold tracking-[0.3em] text-[#8be9d5]">LIVE2D · NOW IN FRAME</p>
                        <span className="rounded-full border border-[#8be9d5]/40 bg-[#8be9d5]/10 px-2.5 py-1 text-[9px] font-bold tracking-[0.14em] text-[#b8f8ea]">NEW · L2D</span>
                    </div>

                    <div className="live2d-update-reveal relative mt-8 max-w-[14.5rem]" style={{ animationDelay: '145ms' }}>
                        <p className="mb-2 text-[10px] font-semibold tracking-[0.22em] text-[#74d8c4]">从一张头像，到真实在场</p>
                        <h2 id="live2d-update-title" className="text-[27px] font-black leading-[1.22] tracking-[-0.035em]">
                            这一次，ta 真正<br />出现在屏幕里。
                        </h2>
                        <p className="mt-3 text-[12px] leading-6 text-[#c5d4dc]">
                            一套模型，两种新的陪伴方式。
                        </p>
                    </div>
                </div>

                <div className="px-6 pb-5 pt-5">
                    <div className="divide-y divide-[#dce3e8]">
                        {LIVE2D_FEATURES.map(({ icon: Icon, eyebrow, text }, index) => (
                            <div
                                key={eyebrow}
                                className="live2d-update-reveal flex items-start gap-3 py-3 first:pt-0"
                                style={{ animationDelay: `${230 + index * 75}ms` }}
                            >
                                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#dff7f1] text-[#187864]">
                                    <Icon size={18} weight="duotone" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[12px] font-extrabold tracking-[0.07em] text-[#1c4d45]">{eyebrow}</p>
                                    <p className="mt-1 text-[12px] leading-5 text-[#67747d]">{text}</p>
                                </div>
                            </div>
                        ))}
                    </div>

                    <p className="live2d-update-reveal mt-2 border-l-2 border-[#62cbb5] pl-3 text-[10px] leading-[1.7] text-[#7a878f]" style={{ animationDelay: '410ms' }}>
                        模型入口在「电话」的视频模式；桌面入口在「外观 → 触感陪伴」。
                    </p>

                    <div className="live2d-update-reveal mt-5" style={{ animationDelay: '480ms' }}>
                        <button
                            type="button"
                            onClick={handleGuide}
                            className="live2d-update-action flex w-full items-center justify-center gap-2 rounded-2xl bg-[#176f60] px-5 py-3.5 text-[13px] font-extrabold tracking-[0.04em] text-white shadow-[0_10px_24px_rgba(23,111,96,0.25)] transition-transform duration-200 active:scale-[0.975]"
                        >
                            查看本次更新
                            <ArrowRight size={16} weight="bold" />
                        </button>
                        <button
                            type="button"
                            onClick={handleDismiss}
                            className="live2d-update-action mt-1.5 w-full py-2.5 text-[11px] font-semibold text-[#89949a] transition-colors active:text-[#4d585d]"
                        >
                            稍后看看
                        </button>
                    </div>
                </div>
            </section>
        </div>
    );
};

const AMSG2_FEATURES = [
    {
        icon: BellRinging,
        eyebrow: '到点就响',
        text: 'App 关着、手机锁着，消息一样送得到。',
    },
    {
        icon: ChatTeardropDots,
        eyebrow: '说一声就行',
        text: '「明早八点叫我」，ta 自己把任务排上。',
    },
    {
        icon: PaperPlaneTilt,
        eyebrow: '话没说完',
        text: '后台顺手排下一条，事办完了回来报备。',
    },
] as const;

const Amsg2UpdatePopup: React.FC<UpdatePopupProps> = ({ onDone, onExit }) => {
    const { openApp } = useOS();

    React.useEffect(() => {
        trackEvent('弹出版本更新提醒', { 版本: CHANGELOG_2026_08_03 });
    }, []);

    const handleGuide = () => {
        markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_03);
        // 直接展开这一版的更新说明：怎么部署、有哪些边界都写在那页里。
        try {
            sessionStorage.setItem(FAQ_TARGET_SECTION_KEY, CHANGELOG_2026_08_03);
        } catch { /* storage 不可用就退回 FAQ 首页，别拦着跳转 */ }
        openApp(AppID.FAQ);
        onExit();
        trackEvent('点立刻体验', { 版本: CHANGELOG_2026_08_03 });
    };

    const handleDismiss = () => {
        markUpdateSeen(UPDATE_NOTIFICATION_KEY_2026_08_03);
        onDone();
        trackEvent('跳过本次更新说明', { 版本: CHANGELOG_2026_08_03 });
    };

    return (
        <div
            className="amsg-brief-overlay fixed inset-0 z-[9998] flex items-start justify-center overflow-y-auto bg-[#0c1020]/78 px-4 backdrop-blur-sm"
            style={{
                paddingTop: 'max(1rem, env(safe-area-inset-top))',
                paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="amsg-brief-title"
        >
            <style>{`
                @keyframes amsgBriefOverlayIn {
                    from { opacity: 0; }
                    to { opacity: 1; }
                }
                @keyframes amsgBriefCardIn {
                    from { opacity: 0; transform: translateY(24px) scale(.975); }
                    to { opacity: 1; transform: translateY(0) scale(1); }
                }
                @keyframes amsgBriefReveal {
                    from { opacity: 0; transform: translateY(9px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .amsg-brief-overlay { animation: amsgBriefOverlayIn 220ms ease-out both; }
                .amsg-brief-card { animation: amsgBriefCardIn 460ms cubic-bezier(.2,.8,.2,1) both; }
                .amsg-brief-reveal { animation: amsgBriefReveal 420ms ease-out both; }
                @media (prefers-reduced-motion: reduce) {
                    .amsg-brief-overlay,
                    .amsg-brief-card,
                    .amsg-brief-reveal { animation: none !important; }
                    .amsg-brief-action { transition: none !important; }
                }
            `}</style>

            <section className="amsg-brief-card relative my-auto w-full max-w-[23rem] overflow-hidden rounded-[2rem] bg-[#f7f8fd] text-[#232838] shadow-[0_28px_80px_rgba(8,11,26,0.5)] ring-1 ring-white/20">
                {/* 上半截是一块深夜里的锁屏：功能本身长什么样，比讲一遍更省事 */}
                <div className="relative overflow-hidden bg-[#171d33] px-6 pb-7 pt-6 text-[#f3f5ff]">
                    <div className="pointer-events-none absolute -right-12 -top-14 h-44 w-44 rounded-full bg-[#5b7cfa]/25 blur-2xl" aria-hidden="true" />

                    <div className="amsg-brief-reveal relative flex items-center justify-between" style={{ animationDelay: '90ms' }}>
                        <p className="text-[9px] font-bold tracking-[0.32em] text-[#93a9ff]">LOCK SCREEN · 02:47</p>
                        <span className="rounded-full border border-[#93a9ff]/45 px-2.5 py-1 text-[9px] font-bold tracking-[0.16em] text-[#b9c6ff]">NEW · 主动消息</span>
                    </div>

                    <div className="amsg-brief-reveal relative mt-7" style={{ animationDelay: '150ms' }}>
                        <p className="mb-2 text-[10px] font-semibold tracking-[0.24em] text-[#8fa4f5]">主动消息 2.0</p>
                        <h2 id="amsg-brief-title" className="max-w-[18rem] text-[27px] font-black leading-[1.25] tracking-[-0.035em]">
                            这回换 ta<br />自己挑时间找你。
                        </h2>
                        <p className="mt-3 text-[12px] leading-6 text-[#c6cce6]">
                            消息在后台生成、直接推到手机，你不用一直开着 App。
                        </p>
                    </div>

                    <div
                        className="amsg-brief-reveal relative mt-5 flex items-start gap-3 rounded-2xl bg-white/[0.12] px-3.5 py-3 ring-1 ring-white/15"
                        style={{ animationDelay: '210ms' }}
                    >
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#5b7cfa]/85 text-white">
                            <BellRinging size={15} weight="fill" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                                <p className="truncate text-[11px] font-bold text-white">Sully</p>
                                <span className="shrink-0 text-[9px] text-[#aab4d8]">02:47</span>
                            </div>
                            <p className="mt-0.5 text-[11px] leading-4 text-[#dfe4f7]">汤炖好了，说好要叫你的——起来喝一口再睡。</p>
                        </div>
                    </div>

                    <div className="absolute -bottom-3 -left-3 h-6 w-6 rounded-full bg-[#f7f8fd]" aria-hidden="true" />
                    <div className="absolute -bottom-3 -right-3 h-6 w-6 rounded-full bg-[#f7f8fd]" aria-hidden="true" />
                </div>

                <div className="px-6 pb-5 pt-5">
                    <div className="divide-y divide-[#dde1ef]">
                        {AMSG2_FEATURES.map(({ icon: Icon, eyebrow, text }, index) => (
                            <div
                                key={eyebrow}
                                className="amsg-brief-reveal flex items-start gap-3 py-3 first:pt-0"
                                style={{ animationDelay: `${260 + index * 70}ms` }}
                            >
                                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#e6ebff] text-[#3f5fd4]">
                                    <Icon size={18} weight="duotone" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[12px] font-extrabold tracking-[0.08em] text-[#39456e]">{eyebrow}</p>
                                    <p className="mt-1 text-[12px] leading-5 text-[#6c7186]">{text}</p>
                                </div>
                            </div>
                        ))}
                    </div>

                    <p className="amsg-brief-reveal mt-2 border-l-2 border-[#8fa4f5] pl-3 text-[10px] leading-[1.7] text-[#848a9d]" style={{ animationDelay: '500ms' }}>
                        要用得先自己搭一个小后端，全程在网页上点，大约 15 分钟；步骤和边界都写在说明里。
                    </p>

                    <div className="amsg-brief-reveal mt-5" style={{ animationDelay: '560ms' }}>
                        <button
                            type="button"
                            onClick={handleGuide}
                            className="amsg-brief-action flex w-full items-center justify-center gap-2 rounded-2xl bg-[#3f5fd4] px-5 py-3.5 text-[13px] font-extrabold tracking-[0.05em] text-white shadow-[0_10px_24px_rgba(63,95,212,0.28)] transition-transform duration-200 active:scale-[0.975]"
                        >
                            看看怎么开
                            <ArrowRight size={16} weight="bold" />
                        </button>
                        <button
                            type="button"
                            onClick={handleDismiss}
                            className="amsg-brief-action mt-1.5 w-full py-2.5 text-[11px] font-semibold text-[#8b90a2] transition-colors active:text-[#4a4f60]"
                        >
                            先不折腾
                        </button>
                    </div>
                </div>
            </section>
        </div>
    );
};

const NetworkTransitNoticePopup: React.FC<UpdatePopupProps> = ({ onDone, onExit }) => {
    const { openApp } = useOS();

    React.useEffect(() => {
        trackEvent('弹出联网方式说明', { 版本: 'network-transit-2026-08' });
    }, []);

    const handleDismiss = () => {
        markUpdateSeen(NETWORK_TRANSIT_NOTICE_KEY_2026_08);
        onDone();
        trackEvent('知悉联网方式说明', { 去向: '关闭' });
    };

    const handleSettings = () => {
        markUpdateSeen(NETWORK_TRANSIT_NOTICE_KEY_2026_08);
        requestProxyWorkerSettingsFocus();
        openApp(AppID.Settings);
        onExit();
        trackEvent('知悉联网方式说明', { 去向: '设置' });
    };

    return (
        <div
            className="fixed inset-0 z-[9998] flex items-center justify-center overflow-hidden bg-[#111827]/65 px-4 backdrop-blur-sm"
            style={{
                paddingTop: 'max(1rem, env(safe-area-inset-top))',
                paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="network-transit-notice-title"
        >
            <section className="relative flex max-h-full w-full max-w-[23rem] flex-col overflow-hidden rounded-[2rem] bg-[#f8fafc] text-slate-700 shadow-[0_24px_80px_rgba(15,23,42,0.4)] ring-1 ring-white/30">
                <header className="shrink-0 bg-[linear-gradient(145deg,#334155,#475569)] px-6 pb-5 pt-6 text-white">
                    <div className="mb-3 inline-flex rounded-full bg-white/10 px-2.5 py-1 text-[9px] font-bold tracking-[0.16em] text-slate-200 ring-1 ring-white/15">
                        例行维护 · 说明补充
                    </div>
                    <h2 id="network-transit-notice-title" className="text-[21px] font-black tracking-[-0.02em]">
                        关于部分联网功能
                    </h2>
                    <p className="mt-2 text-[11px] leading-5 text-slate-300">
                        这次只补充此前写得不够清楚的联网路径，功能和使用方式没有变化。
                    </p>
                </header>

                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-6 py-5 text-[12px] leading-[1.75]">
                    <p>
                        例行排查中，我们发现部分功能对“请求会怎么走”的说明不够清楚。静态网页下，以下入口会在你实际启用或使用时经过网络 Worker：
                    </p>
                    <ul className="space-y-1.5 rounded-2xl bg-white px-3.5 py-3 text-[11px] leading-[1.65] ring-1 ring-slate-200/70">
                        <li><b>聊天 / 实时感知：</b>Brave 联网搜索与新闻、Notion / 飞书日记、网页链接读取</li>
                        <li><b>音乐 App：</b>网易云登录状态、搜索、歌单与播放相关请求</li>
                        <li><b>小红书 Lite：</b>登录校验、搜索浏览、互动与发布</li>
                        <li><b>语音 / 写歌：</b>Fish Audio 语音合成、Replicate / ACE-Step</li>
                        <li><b>点单：</b>麦当劳与瑞幸 MCP</li>
                        <li><b>云备份：</b>WebDAV；GitHub 的 Worker 中转路径当前默认关闭，仅在你手动开启后使用</li>
                    </ul>
                    <p>
                        这些请求经过 Worker，只是为了替静态网页完成跨域请求并把结果返回。项目代码不会将请求内容写入数据库、对象存储或业务日志；转发完成后，项目侧没有可供回看或恢复的内容副本。Worker 源码公开可查。
                    </p>
                    <div className="rounded-2xl bg-sky-50 px-3.5 py-3 text-[11px] leading-[1.7] text-sky-900 ring-1 ring-sky-100">
                        <p>
                            这和你平时使用<b>联网搜索、第三方登录或在线音乐</b>时的接口请求相近：只有主动使用对应功能时，当次必要数据才会经过服务端，不会把 SullyOS·糯米机 的聊天记录或本地资料整体上传。
                        </p>
                        <p className="mt-1.5">
                            如果你平时能够接受 API 中转站，可以把它作为参照：API 中转站能够接触完整的模型请求与聊天内容；这里的 Worker 只接触对应功能的当次请求，并在转发后不保留请求内容。
                        </p>
                    </div>
                    <p className="text-[11px] text-slate-500">
                        介意中转的话，可以关闭对应功能，或在设置中换成自己部署的 Worker。
                    </p>
                </div>

                <footer className="grid shrink-0 grid-cols-[0.9fr_1.1fr] gap-2.5 border-t border-slate-200/70 bg-[#f8fafc] px-6 pb-6 pt-3">
                    <button
                        type="button"
                        onClick={handleSettings}
                        className="rounded-2xl bg-slate-100 px-3 py-3 text-[11px] font-bold text-slate-600 transition-transform active:scale-[0.98]"
                    >
                        查看代理设置
                    </button>
                    <button
                        type="button"
                        onClick={handleDismiss}
                        className="rounded-2xl bg-slate-700 px-3 py-3 text-[12px] font-extrabold text-white shadow-lg shadow-slate-300 transition-transform active:scale-[0.98]"
                    >
                        我知道了
                    </button>
                </footer>
            </section>
        </div>
    );
};

/**
 * 这一批要弹的更新提醒，新的排前面。
 *
 * 同时上线好几个功能时，各自值得单独说一次，所以排成队列：关掉一条接着弹下一条，
 * 已读各记各的 key——点掉其中一条不影响另一条还会不会露面。
 */
const SARUpdateAnnouncement: React.FC<UpdatePopupProps> = ({ onDone, onExit }) => {
    const { openApp } = useOS();
    return <SARUpdatePopup onDone={onDone} onVisit={() => {
        sarLaunch.request(); openApp(AppID.VRWorld); onExit();
    }} onGuide={() => {
        try { sessionStorage.setItem(FAQ_TARGET_SECTION_KEY, SAR_CHANGELOG); } catch { /* 手册首页仍可打开 */ }
        openApp(AppID.FAQ); onExit();
    }}/>;
};

const UPDATE_QUEUE: { key: string; render: (props: UpdatePopupProps) => React.ReactNode }[] = [
    { key: SAR_UPDATE_KEY, render: (props) => <SARUpdateAnnouncement {...props} /> },
    { key: NETWORK_TRANSIT_NOTICE_KEY_2026_08, render: (props) => <NetworkTransitNoticePopup {...props} /> },
    { key: UPDATE_NOTIFICATION_KEY_2026_08_10, render: (props) => <Live2DUpdatePopup {...props} /> },
];

export const shouldShowUpdateNotification = (): boolean => UPDATE_QUEUE.some((entry) => !isUpdateSeen(entry.key));

interface UpdateNotificationControllerProps {
    onClose: () => void;
}

export const UpdateNotificationController: React.FC<UpdateNotificationControllerProps> = ({ onClose }) => {
    // 进场时把没看过的挑出来定住。每次渲染重算的话，当前这条一被标记已读就会自己从队列里
    // 消失、直接跳到下一条，用户还没来得及点——推进队列的只能是下面 onDone 那一下。
    const [pending, setPending] = React.useState(() => UPDATE_QUEUE.filter((entry) => !isUpdateSeen(entry.key)));
    const current = pending[0];

    React.useEffect(() => {
        if (!current) onClose();
    }, [current, onClose]);

    if (!current) return null;

    return (
        <React.Fragment key={current.key}>
            {current.render({
                onDone: () => setPending((rest) => rest.slice(1)),
                onExit: onClose,
            })}
        </React.Fragment>
    );
};
