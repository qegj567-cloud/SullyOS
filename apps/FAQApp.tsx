import { SAR_CHANGELOG } from '../utils/sarUpdate';

import React, { useEffect, useState } from 'react';
import { useOS } from '../context/OSContext';
import { Sparkle } from '@phosphor-icons/react';
import {
    FAQ_TARGET_SECTION_KEY,
    CHANGELOG_2026_04,
    CHANGELOG_2026_05,
    CHANGELOG_2026_05_10,
    CHANGELOG_2026_05_17,
    CHANGELOG_2026_05_27,
    CHANGELOG_2026_06_05,
    CHANGELOG_2026_06_14,
    CHANGELOG_2026_06_21,
    CHANGELOG_2026_06_26,
    CHANGELOG_2026_07_10,
    CHANGELOG_2026_08_03,
    CHANGELOG_2026_08_10,
    CHANGELOG_2026_08_30,
} from '../components/UpdateNotificationEvent';
import { trackEvent } from '../utils/analytics';

const FAQ_DATA = [
    {
        q: "1. 进不去网页 / 白屏 / 点了没反应",
        reason: "网络有点小脾气，不够通畅。",
        solution: "需要一点点“魔法”才能连上外网。\n如果你不知道什么是“梯子/魔法”，请自行搜索一下~ \n这不是软件坏啦，是网路不通。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1fa84.png",
        color: "bg-blue-50 text-blue-700"
    },
    {
        q: "2. 发了消息，角色不回我？",
        reason: "为了帮大家省额度，角色不会自动秒回，他在等你戳他。",
        solution: "发完消息后，请注意观察顶部标题栏右边的 **闪电按钮**。\n点一下它，戳戳他，他就会思考并回复啦！\n也可以在聊天设置里开启“发送按钮代替生成按钮”或“自动回复”，所有私聊统一生效。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4a4.png",
        color: "bg-yellow-50 text-yellow-700"
    },
    {
        q: "3. 为什么拉取不到模型列表？",
        reason: "很多时候是填写的地址（URL）差了一点点。",
        solution: "请仔细检查你的链接：\n1. 后面是不是漏掉了 `/v1` 这个小尾巴？\n2. 复制时是否多带了空格？\n3. 地址不对是敲不开门的哦。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f50d.png",
        color: "bg-red-50 text-red-700"
    },
    {
        q: "4. 出现红色弹窗 (API 报错)",
        reason: "情况A：如果你最近发了很多高清图，或者聊得太久了。\n情况B：没发图也报错？可能是提供接口的那边欠费或波动。",
        solution: "**情况A**：进【设置】，把“上下文条数”调低一点（例如 20-50）。\n**情况B**：请直接联系你购买/获取 API 的那个渠道哦，模拟器本身是无辜哒。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/26a0.png",
        color: "bg-orange-50 text-orange-700"
    },
    {
        q: "5. 气泡主题 / 导入角色",
        reason: "想要个性化？想换角色？",
        solution: "**换气泡**：\n点顶部的名字 → 下滑找“气泡样式”。\n\n**导角色**：\n支持本模拟器导出的原格式文件与 PNG 分享卡原图。PNG 请传原文件，截图或压缩图不能恢复其中的数据；不兼容其他小手机角色卡。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3a8.png",
        color: "bg-purple-50 text-purple-700"
    },
    {
        q: "6. 碎碎念：关于 API（接口）",
        reason: "用公益/白嫖的不稳定？花钱买的报错？",
        solution: "公益的不稳定是常态。\n花钱买的请找卖家售后。\n作者和群友也是为爱发电，但是大家并不是专业的。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4ac.png",
        color: "bg-slate-50 text-slate-700"
    },
    {
        q: "7. 遇到奇怪的 Bug 怎么办？",
        reason: "可以在群里问，但严肃报修需要“病历本”。",
        solution: "请去桌面【设置】→【数据备份】导出 JSON 文件发给我。\n只有复现了问题，才能修好它。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f691.png",
        color: "bg-rose-50 text-rose-700"
    },
    {
        q: "8. 关于提问礼仪",
        reason: "拒绝低气压。",
        solution: "遇到问题深呼吸，直接发截图 + 描述发生了什么。\n欢迎大家积极讨论，但是避免通篇抱怨，散发负面情绪解决不了问题，还会劝退想帮你的人。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2764.png",
        color: "bg-pink-50 text-pink-700"
    },
    {
        q: "9. 小屋里角色立绘怎么更换？",
        reason: "想给角色换个造型/衣服。",
        solution: "1. 进入小屋，点击顶部的「装修」按钮进入编辑模式。\n2. **直接点击**画面中央的角色小人。\n3. 选择一张透明背景的图片上传即可。\n(注意：这里更换的是小屋专属的 Q 版/Chibi 立绘，不是聊天头像哦)",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f3e0.png",
        color: "bg-indigo-50 text-indigo-700"
    },
    {
        q: "10. 导入的表情包不显示 / 导入没反应？",
        reason: "通常是格式不对，或者链接无效。",
        solution: "1. **严格检查格式**：必须是 `名字--URL`，中间是**两个减号**！\n   错误：`滑稽 http://...`\n   正确：`滑稽--http://...`\n2. **检查链接**：必须是图片直链（.jpg/.png/.gif 结尾）。\n3. **一行一个**：不要把所有内容写在一行里。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f5bc.png",
        color: "bg-cyan-50 text-cyan-700"
    },
    {
        q: "11. 点聊天输入框没反应 / 键盘唤不起来？",
        reason: "多半是随备份一起导入的美化在捣乱：白框自定义 CSS、气泡主题或聊天背景把输入框盖住/禁用了。这类数据跟着备份走，所以重启、重新导入备份都没用，而全新页面（没导数据）反而正常。",
        solution: "按顺序排查：\n1. 【外观】→【聊天界面】→ **还原白框美化**（一键清掉全局和所有角色的白框 CSS）。\n2. 点顶部角色名 → 把「气泡样式」换回默认。\n3. 关掉该角色的聊天背景图。\n4. 还不行：换个浏览器（如 Safari）打开同一链接导入备份试试；仍复现请把备份 JSON 按第 7 条发给作者。",
        icon: "https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2328.png",
        color: "bg-teal-50 text-teal-700"
    }
];

interface ChangelogEntry {
    id: string;
    title: string;
    subtitle: string;
    date: string;
    src: string;
    accent: string;
}

const CHANGELOG_ENTRIES: ChangelogEntry[] = [
    {
        id: SAR_CHANGELOG,
        title: '2026 年 9 月 11 日 · 彼方来信 · SAR',
        subtitle: 'SAR 活动室与星级故事 · 钓鱼和恐龙花园 · 芯片、推演与模块 · 私聊发送习惯 · PNG 图片分享',
        date: '2026-09-11',
        src: 'changelogs/2026-9-11.html',
        accent: 'from-emerald-50 to-amber-50 border-emerald-200',
    },
    {
        id: CHANGELOG_2026_08_30,
        title: '2026 年 8 月 30 日 · 协同工作台',
        subtitle: '角色协同工作双模式 · Word / PDF 与文件交付 · 可安装美化、角色卡和世界书 · 独立文件库与归档记忆 · 协同数据随系统备份导入导出',
        date: '2026-08-30',
        src: 'changelogs/2026-8-30.html',
        accent: 'from-indigo-100 to-stone-100 border-indigo-200',
    },
    {
        id: CHANGELOG_2026_08_10,
        title: '2026 年 8 月 10 日 · Live2D 陪伴升级',
        subtitle: '新增 VRM / Live2D 视频通话 · 新增面向 Live2D 的「触感陪伴」桌面主题',
        date: '2026-08-10',
        src: 'changelogs/2026-8-10.html',
        accent: 'from-emerald-100 to-sky-100 border-emerald-200',
    },
    {
        id: CHANGELOG_2026_08_03,
        title: '2026 年 8 月 3 日 · 主动消息 2.0',
        subtitle: '角色到点自己发消息，App 关着也收得到 · 三种排任务的方式（面板 / 聊天里说一句 / 角色给自己排）· 到点现取时间天气节日热搜与当天作息 · 连发不重样、只做事时不推空消息 · 后台照样能用 MCP 与搜索 · 想找话说的那类会让路，闹钟和承诺照发 · 需自部署 Cloudflare Worker + D1',
        date: '2026-08-03',
        src: 'changelogs/2026-8-3.html',
        accent: 'from-violet-100 to-sky-100 border-violet-200',
    },
    {
        id: CHANGELOG_2026_07_10,
        title: '2026 年 7 月 10 日 · 生活统计',
        subtitle: '档案「生活统计」四模块 + 角色注入代记 · 彼方全服写诗 · 捏人换画风 + PSD 批量导入 + 手办区 · 神经链接角色分组 · 小屋装修大升级 + 家园「凌晨」段 · 记忆宫殿门牌（测试中）· 专属提示铃声 · 壁纸/小屋图改存 Blob · 一大批 iOS 适配与散修',
        date: '2026-07-10',
        src: 'changelogs/2026-7-10.html',
        accent: 'from-rose-100 to-violet-100 border-rose-200',
    },
    {
        id: CHANGELOG_2026_06_26,
        title: '2026 年 6 月 26 日 · 梦境盲盒',
        subtitle: '小屋梦境系统（进屋刷新 · 集齐 13 款梦境盲盒）· 查手机联系人模式 + 智能体（char 的小手机）· 见面状态栏与设置前移 · 日程窥得更细 · 时间感知归位神经链接 · TTS 新增鱼声 API',
        date: '2026-06-26',
        src: 'changelogs/2026-6-26.html',
        accent: 'from-indigo-100 to-violet-100 border-indigo-200',
    },
    {
        id: CHANGELOG_2026_06_21,
        title: '2026 年 6 月 21 日 · 查手机翻新',
        subtitle: '查手机 UI 翻新 + 新增「人格模拟」（可指定一场 Screenlife 演出，设置里可选是否发送给角色）· 外观新增手游风 · 小红书 Lite 可直接分享帖子给角色',
        date: '2026-06-21',
        src: 'changelogs/2026-6-21.html',
        accent: 'from-violet-100 to-fuchsia-100 border-violet-200',
    },
    {
        id: CHANGELOG_2026_06_14,
        title: '2026 年 6 月 14 日 · 家园上线',
        subtitle: '小屋翻新 · 「家园」多角色大世界（真实时间 / 模拟时间二选一）· 瑞幸咖啡点单',
        date: '2026-06-14',
        src: 'changelogs/2026-6-14.html',
        accent: 'from-violet-100 to-purple-100 border-violet-200',
    },
    {
        id: CHANGELOG_2026_06_05,
        title: '2026 年 6 月 5 日 · 彼方上线',
        subtitle: '角色自主登入的 VR 小世界 · 邮局漂流信 · 留言簿原话上墙 · 隐藏小人',
        date: '2026-06-05',
        src: 'changelogs/2026-6-5.html',
        accent: 'from-indigo-100 to-purple-100 border-indigo-200',
    },
    {
        id: CHANGELOG_2026_05_27,
        title: '2026 年 5 月 27 日 · 小更新',
        subtitle: '情绪 buff 也接入 Instant Push · 发完即走，聊天和情绪都不用一直开着 App（附配置视频）',
        date: '2026-05-27',
        src: 'changelogs/2026-5-27.html',
        accent: 'from-rose-100 to-amber-100 border-rose-200',
    },
    {
        id: CHANGELOG_2026_05_17,
        title: '2026 年 5 月 17 日 · 小更新',
        subtitle: 'Instant Push 上线 · 发完文本就能锁屏走人，AI 回复自己回来',
        date: '2026-05-17',
        src: 'changelogs/2026-5-17.html',
        accent: 'from-teal-100 to-sky-100 border-teal-200',
    },
    {
        id: CHANGELOG_2026_05_10,
        title: '2026 年 5 月 10 日 · 小更新',
        subtitle: '「心象」上线 · 模型思考链可视化 + 约会（见面模式）bug 修复',
        date: '2026-05-10',
        src: 'changelogs/2026-5-10.html',
        accent: 'from-purple-100 to-indigo-100 border-purple-200',
    },
    {
        id: CHANGELOG_2026_05,
        title: '2026 年 5 月更新',
        subtitle: 'GitHub 备份 · 音乐 App 网络优化 · 麦当劳 MCP · SULLY 默认皮肤 等',
        date: '2026-05',
        src: 'changelogs/2026-5.html',
        accent: 'from-amber-100 to-orange-100 border-amber-200',
    },
    {
        id: CHANGELOG_2026_04,
        title: '2026 年 4 月更新',
        subtitle: '向量记忆 · 更新说明与配置指南',
        date: '2026-04',
        src: 'changelogs/2026-4.html',
        accent: 'from-indigo-100 to-purple-100 border-indigo-200',
    },
];

type Tab = 'faq' | 'changelog';

const FAQApp: React.FC = () => {
    const { closeApp } = useOS();
    const [tab, setTab] = useState<Tab>('faq');
    const [activeChangelog, setActiveChangelog] = useState<ChangelogEntry | null>(null);

    useEffect(() => {
        try {
            const target = sessionStorage.getItem(FAQ_TARGET_SECTION_KEY);
            if (target) {
                sessionStorage.removeItem(FAQ_TARGET_SECTION_KEY);
                const entry = CHANGELOG_ENTRIES.find(e => e.id === target);
                if (entry) {
                    setTab('changelog');
                    setActiveChangelog(entry);
                }
            }
        } catch { /* ignore */ }
    }, []);

    const handleBack = () => {
        if (activeChangelog) {
            setActiveChangelog(null);
            return;
        }
        closeApp();
    };

    const headerTitle = activeChangelog
        ? activeChangelog.title
        : tab === 'changelog' ? '更新日志' : '常见问题';

    return (
        <div className="h-full w-full bg-slate-50 flex flex-col font-light">
            {/* Header */}
            <div className="bg-white/70 backdrop-blur-md border-b border-white/40 shrink-0 sticky top-0 z-10" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center px-4 py-3">
                    <div className="flex items-center gap-2 w-full">
                        <button onClick={handleBack} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
                            </svg>
                        </button>
                        <h1 className="text-xl font-medium text-slate-700 tracking-wide">{headerTitle}</h1>
                    </div>
                </div>
            </div>

            {/* Tab switcher (hidden when viewing a specific changelog) */}
            {!activeChangelog && (
                <div className="shrink-0 bg-white/60 backdrop-blur-md border-b border-slate-200/60 px-4 py-2">
                    <div className="inline-flex bg-slate-100 rounded-full p-1 gap-1">
                        <button
                            onClick={() => { setTab('faq'); trackEvent('切换常见问题标签页', { tab: 'faq' }); }}
                            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all ${
                                tab === 'faq'
                                    ? 'bg-white text-indigo-600 shadow-sm'
                                    : 'text-slate-500 active:scale-95'
                            }`}
                        >
                            常见问题
                        </button>
                        <button
                            onClick={() => { setTab('changelog'); trackEvent('切换常见问题标签页', { tab: 'changelog' }); }}
                            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all ${
                                tab === 'changelog'
                                    ? 'bg-white text-indigo-600 shadow-sm'
                                    : 'text-slate-500 active:scale-95'
                            }`}
                        >
                            更新日志
                        </button>
                    </div>
                </div>
            )}

            {/* Content area */}
            {activeChangelog ? (
                <div className="flex-1 bg-[#faf7f2] overflow-hidden">
                    <iframe
                        key={activeChangelog.id}
                        src={activeChangelog.src}
                        title={activeChangelog.title}
                        className="w-full h-full border-0"
                    />
                </div>
            ) : tab === 'faq' ? (
                <div className="flex-1 overflow-y-auto p-5 pb-20 no-scrollbar">
                    {/* Intro Banner */}
                    <div className="bg-gradient-to-r from-pink-100 to-indigo-100 p-5 rounded-3xl mb-6 shadow-sm">
                        <h2 className="text-lg font-bold text-slate-700 mb-2 flex items-center gap-2">
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f338.png" className="w-5 h-5 inline" alt="" /> 新手必读小贴士 <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f338.png" className="w-5 h-5 inline" alt="" />
                        </h2>
                        <p className="text-xs text-slate-600 leading-relaxed opacity-90">
                            欢迎来到这里！为了让你和角色的互动更顺畅，如果遇到问题，请先看看下面有没有答案哦~
                            <br/>
                            (如果不看公告直接提问，大家可能不知道怎么帮你，也会消耗群友的耐心呢)
                        </p>
                    </div>

                    {/* FAQ Cards */}
                    <div className="space-y-4">
                        {FAQ_DATA.map((item, index) => (
                            <div key={index} className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100 animate-slide-up" style={{ animationDelay: `${index * 50}ms` }}>
                                <div className="flex items-start gap-4">
                                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 ${item.color.split(' ')[0]}`}>
                                        <img src={item.icon} className="w-5 h-5 inline" alt="" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <h3 className={`text-sm font-bold mb-2 ${item.color.split(' ')[1]}`}>{item.q}</h3>

                                        <div className="space-y-2">
                                            <div className="flex gap-2 items-start">
                                                <span className="text-xs font-bold text-slate-400 shrink-0 mt-0.5">原因:</span>
                                                <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap">{item.reason}</p>
                                            </div>
                                            <div className="flex gap-2 items-start bg-slate-50 p-2 rounded-lg">
                                                <span className="text-xs font-bold text-green-500 shrink-0 mt-0.5 flex items-center gap-0.5"><Sparkle size={12} weight="fill" /> 解决:</span>
                                                <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap font-medium">{item.solution}</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    <div className="mt-8 text-center text-[10px] text-slate-400">
                        SullyOS·糯米机 Help Center • v1.1
                    </div>
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto p-5 pb-20 no-scrollbar">
                    <div className="bg-gradient-to-r from-indigo-100 to-purple-100 p-5 rounded-3xl mb-6 shadow-sm">
                        <h2 className="text-lg font-bold text-slate-700 mb-2 flex items-center gap-2">
                            <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/2728.png" className="w-5 h-5 inline" alt="" /> 版本更新记录
                        </h2>
                        <p className="text-xs text-slate-600 leading-relaxed opacity-90">
                            这里存放每一次重要更新的详细说明。点击卡片查看完整内容。
                        </p>
                    </div>

                    <div className="space-y-3">
                        {CHANGELOG_ENTRIES.map((entry) => (
                            <button
                                key={entry.id}
                                onClick={() => setActiveChangelog(entry)}
                                className={`w-full text-left bg-gradient-to-br ${entry.accent} border rounded-2xl p-4 shadow-sm active:scale-[0.98] transition-transform`}
                            >
                                <div className="flex items-start gap-3">
                                    <div className="w-12 h-12 rounded-2xl bg-white/70 flex items-center justify-center shrink-0 shadow-sm">
                                        <img src="https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/1f4d6.png" className="w-6 h-6" alt="" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-baseline justify-between gap-2">
                                            <h3 className="text-sm font-bold text-slate-800">{entry.title}</h3>
                                            <span className="text-[10px] text-slate-500 font-mono shrink-0">{entry.date}</span>
                                        </div>
                                        <p className="text-[11px] text-slate-600 mt-1 leading-relaxed">{entry.subtitle}</p>
                                        <div className="mt-2 text-[11px] font-bold text-indigo-600 flex items-center gap-1">
                                            查看完整更新说明
                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-3 h-3"><path d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
                                        </div>
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>

                    <div className="mt-8 text-center text-[10px] text-slate-400">
                        SullyOS·糯米机 Changelog • 更多版本将在这里陆续归档
                    </div>
                </div>
            )}
        </div>
    );
};

export default FAQApp;
