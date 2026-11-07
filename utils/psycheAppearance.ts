// 思考链卡片支持的 12 种风格预设 — 同时被 MessageItem 与 ThinkingChainSettingsModal 复用
export type ThinkingChainStyleId = 'echo' | 'whisper' | 'minimal' | 'ink' | 'neon' | 'terminal' | 'stellar' | 'tama' | 'pixel' | 'muji' | 'ins' | 'custom';
export interface ThinkingChainStyleSpec {
    bg: string;            // 卡片背景（可以是 CSS gradient）
    border: string;        // 边框色
    accent: string;        // 标题/装饰点缀
    text: string;          // 正文颜色
    subtext: string;       // 副标题/状态文字
    glow?: string;         // 右上角微光 radial 颜色（可选）
    fadeColor?: string;    // 展开滚动区上下软渐变颜色（可选）
    fontFamily: string;    // 正文字体
    showCorners: boolean;  // 四角装饰括号
    showDivider: boolean;  // 标题下分隔线
    titleZh: string;       // 中文标题
    titleEn: string;       // 英文副标题
    listenLabel: string;   // 折叠态右侧文字
    silenceLabel: string;  // 展开态右侧文字
    quoteLeft: string;     // 折叠态首句左引号
    quoteRight: string;    // 折叠态首句右引号
    italic: boolean;       // 是否斜体
    radius: string;        // 圆角
    /** 边框宽度（默认 1px）——像素框/电子鸡壳等拟态风格用粗框 */
    borderWidth?: string;
    /** 卡片投影完全覆盖（不设则走 glow 默认逻辑）——硬像素影/ins 软影/机壳圈 */
    cardShadow?: string;
    /** 卡片内部整面覆盖层：扫描线（CRT）/ 点阵（液晶屏） */
    overlay?: 'scanlines' | 'dotMatrix';
    /** 破格装饰：溢出卡片边框的风格化元素（印章/霓虹括角/终端红绿灯/星子/机壳按钮…），由 PsycheDecor 渲染 */
    decoKind?: 'inkSeal' | 'neonGlitch' | 'termHud' | 'starScatter' | 'tamaShell' | 'pixelArrow' | 'insHeart';
}

export const SERIF = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "STKaiti", "KaiTi", serif';
const SANS = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';
const MONO = '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, "Courier New", monospace';
const PIXEL = '"Zpix", "Fusion Pixel 12px", "DotGothic16", "Silver", "Courier New", monospace';

export const THINKING_CHAIN_PRESETS: Record<Exclude<ThinkingChainStyleId, 'custom'>, ThinkingChainStyleSpec> = {
    echo: {
        bg: 'linear-gradient(135deg, #2a1f3d 0%, #1d1530 45%, #2a1834 100%)',
        border: 'rgba(201, 169, 106, 0.35)',
        accent: '#c9a96a',
        text: '#e9d9b8',
        subtext: 'rgba(233, 217, 184, 0.62)',
        glow: 'rgba(201, 169, 106, 0.28)',
        fadeColor: '#1d1530',
        fontFamily: SERIF,
        showCorners: true,
        showDivider: true,
        titleZh: '心象',
        titleEn: 'PSYCHE',
        listenLabel: '凝望',
        silenceLabel: '移开视线',
        quoteLeft: '「',
        quoteRight: '」',
        italic: true,
        radius: '4px',
    },
    whisper: {
        bg: 'linear-gradient(135deg, rgba(251, 247, 242, 0.96) 0%, rgba(245, 238, 247, 0.86) 50%, rgba(248, 240, 240, 0.92) 100%)',
        border: 'rgba(216, 196, 200, 0.55)',
        accent: '#9a7d83',
        text: '#5b4b50',
        subtext: 'rgba(154, 125, 131, 0.7)',
        glow: 'rgba(212, 184, 192, 0.35)',
        fadeColor: '#fbf7f2',
        fontFamily: SERIF,
        showCorners: false,
        showDivider: true,
        titleZh: '心象',
        titleEn: 'PSYCHE',
        listenLabel: '凝望',
        silenceLabel: '移开视线',
        quoteLeft: '「',
        quoteRight: '」',
        italic: true,
        radius: '14px',
    },
    minimal: {
        bg: '#ffffff',
        border: 'rgba(15, 23, 42, 0.12)',
        accent: '#475569',
        text: '#1e293b',
        subtext: 'rgba(71, 85, 105, 0.6)',
        fadeColor: '#ffffff',
        fontFamily: SANS,
        showCorners: false,
        showDivider: false,
        titleZh: '心象',
        titleEn: 'PSYCHE',
        listenLabel: '凝望',
        silenceLabel: '移开视线',
        quoteLeft: '"',
        quoteRight: '"',
        italic: false,
        radius: '10px',
    },
    ink: {
        bg: 'linear-gradient(160deg, #f9f6ee 0%, #f2ecdf 60%, #ece4d4 100%)',
        border: 'rgba(70, 60, 48, 0.28)',
        accent: '#4a4238',
        text: '#3d3830',
        subtext: 'rgba(74, 66, 56, 0.55)',
        fadeColor: '#f4efe3',
        fontFamily: SERIF,
        showCorners: false,
        showDivider: true,
        titleZh: '墨迹',
        titleEn: 'INK',
        listenLabel: '展卷',
        silenceLabel: '收卷',
        quoteLeft: '「',
        quoteRight: '」',
        italic: false,
        radius: '2px',
        decoKind: 'inkSeal',
    },
    neon: {
        bg: 'linear-gradient(135deg, #0b1026 0%, #10173a 55%, #1a0f2e 100%)',
        border: 'rgba(94, 234, 212, 0.4)',
        accent: '#5eead4',
        text: '#c8f4ff',
        subtext: 'rgba(94, 234, 212, 0.6)',
        glow: 'rgba(94, 234, 212, 0.32)',
        fadeColor: '#10173a',
        fontFamily: SANS,
        showCorners: true,
        showDivider: false,
        titleZh: '脑域',
        titleEn: 'NEURO-LINK',
        listenLabel: '接入',
        silenceLabel: '断开',
        quoteLeft: '⟨',
        quoteRight: '⟩',
        italic: false,
        radius: '8px',
        overlay: 'scanlines',
        decoKind: 'neonGlitch',
    },
    terminal: {
        bg: '#0b120d',
        border: 'rgba(74, 222, 128, 0.35)',
        accent: '#4ade80',
        text: '#a7e8b4',
        subtext: 'rgba(74, 222, 128, 0.55)',
        glow: 'rgba(74, 222, 128, 0.18)',
        fadeColor: '#0b120d',
        fontFamily: MONO,
        showCorners: false,
        showDivider: true,
        titleZh: '内核',
        titleEn: 'KERNEL.LOG',
        listenLabel: 'tail -f',
        silenceLabel: '^C',
        quoteLeft: '$ ',
        quoteRight: '',
        italic: false,
        radius: '6px',
        decoKind: 'termHud',
    },
    stellar: {
        bg: 'linear-gradient(180deg, #0d1b2a 0%, #16263c 60%, #22344e 100%)',
        border: 'rgba(168, 199, 250, 0.35)',
        accent: '#a8c7fa',
        text: '#dce8ff',
        subtext: 'rgba(168, 199, 250, 0.62)',
        glow: 'rgba(168, 199, 250, 0.3)',
        fadeColor: '#16263c',
        fontFamily: SERIF,
        showCorners: false,
        showDivider: true,
        titleZh: '星语',
        titleEn: 'STELLAR',
        listenLabel: '仰望',
        silenceLabel: '垂眸',
        quoteLeft: '「',
        quoteRight: '」',
        italic: true,
        radius: '12px',
        decoKind: 'starScatter',
    },
    // 拓麻歌子：粉壳 + 液晶点阵屏，框本身拟态成电子宠物机
    tama: {
        bg: 'linear-gradient(180deg, #d6e2c2 0%, #c8d6b0 100%)',
        border: '#f2a5c4',
        accent: '#44562f',
        text: '#3f5230',
        subtext: 'rgba(68, 86, 47, 0.6)',
        fadeColor: '#cfdbb9',
        fontFamily: PIXEL,
        showCorners: false,
        showDivider: true,
        titleZh: '心宠',
        titleEn: 'TMGC-LOG',
        listenLabel: '喂食',
        silenceLabel: '哄睡',
        quoteLeft: '▶',
        quoteRight: '',
        italic: false,
        radius: '16px',
        borderWidth: '3px',
        cardShadow: '0 0 0 3px rgba(242, 165, 196, 0.35), 0 3px 8px rgba(120, 80, 100, 0.18)',
        overlay: 'dotMatrix',
        decoKind: 'tamaShell',
    },
    // 像素：JRPG 对话框，白粗框 + 硬像素投影
    pixel: {
        bg: '#23255e',
        border: '#ffffff',
        accent: '#ffd75e',
        text: '#f2f3ff',
        subtext: 'rgba(242, 243, 255, 0.65)',
        fadeColor: '#23255e',
        fontFamily: PIXEL,
        showCorners: false,
        showDivider: false,
        titleZh: '任务',
        titleEn: 'QUEST.LOG',
        listenLabel: '继续',
        silenceLabel: '合上',
        quoteLeft: '『',
        quoteRight: '』',
        italic: false,
        radius: '2px',
        borderWidth: '3px',
        cardShadow: '4px 4px 0 rgba(0, 0, 0, 0.4)',
        decoKind: 'pixelArrow',
    },
    // 性冷淡：暖灰米白、细线、留白，什么装饰都不要
    muji: {
        bg: '#f7f6f3',
        border: 'rgba(60, 60, 54, 0.14)',
        accent: '#8a8a84',
        text: '#4d4d48',
        subtext: 'rgba(90, 90, 84, 0.5)',
        fadeColor: '#f7f6f3',
        fontFamily: SANS,
        showCorners: false,
        showDivider: true,
        titleZh: '独白',
        titleEn: 'MONOLOGUE',
        listenLabel: '展开',
        silenceLabel: '收起',
        quoteLeft: '',
        quoteRight: '',
        italic: false,
        radius: '6px',
    },
    // ins：白卡软影 feed 风，右上一颗小红心
    ins: {
        bg: '#ffffff',
        border: 'rgba(0, 0, 0, 0.07)',
        accent: '#e1306c',
        text: '#262626',
        subtext: '#8e8e8e',
        fadeColor: '#ffffff',
        fontFamily: SANS,
        showCorners: false,
        showDivider: false,
        titleZh: '碎碎念',
        titleEn: 'STORIES',
        listenLabel: '查看',
        silenceLabel: '收起',
        quoteLeft: '“',
        quoteRight: '”',
        italic: false,
        radius: '16px',
        cardShadow: '0 4px 16px rgba(0, 0, 0, 0.07)',
        decoKind: 'insHeart',
    },
};

export function resolveThinkingChainStyle(
    styleId?: ThinkingChainStyleId,
    customColors?: { bg?: string; accent?: string; text?: string },
): ThinkingChainStyleSpec {
    if (styleId === 'custom') {
        const bg = customColors?.bg || '#1f2937';
        const accent = customColors?.accent || '#fbbf24';
        const text = customColors?.text || '#f1f5f9';
        return {
            ...THINKING_CHAIN_PRESETS.echo,
            bg,
            border: accent,
            accent,
            text,
            subtext: text,
            glow: accent,
            fadeColor: bg,
            titleZh: '心象',
            titleEn: 'PSYCHE',
            listenLabel: '凝望',
            silenceLabel: '移开视线',
        };
    }
    return THINKING_CHAIN_PRESETS[styleId || 'echo'] || THINKING_CHAIN_PRESETS.echo;
}


export interface PsycheAppearance { styleId: ThinkingChainStyleId; customColors?: {bg?:string;accent?:string;text?:string}; customCss?:string }
export function resolvePsycheAppearance(theme: {chatPsyche?:PsycheAppearance}, character?: {thinkingChainStyle?:ThinkingChainStyleId;thinkingChainCustomColors?:PsycheAppearance['customColors'];thinkingChainCustomCss?:string}):PsycheAppearance {
 return {styleId:character?.thinkingChainStyle ?? theme.chatPsyche?.styleId ?? 'echo',customColors:character?.thinkingChainCustomColors ?? theme.chatPsyche?.customColors,customCss:character?.thinkingChainCustomCss ?? theme.chatPsyche?.customCss ?? ''};
}
export function validatePsycheAppearance(value:unknown):PsycheAppearance {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('心象样式无效');
 const v=value as Record<string,any>;
 if(v.styleId!=='custom'&&!Object.prototype.hasOwnProperty.call(THINKING_CHAIN_PRESETS,v.styleId))throw Error('未知的心象风格');
 const out:PsycheAppearance={styleId:v.styleId};
 if(v.customColors!==undefined){if(!v.customColors||typeof v.customColors!=='object')throw Error('心象颜色无效');out.customColors={};for(const key of ['bg','accent','text'] as const){const color=v.customColors[key];if(color!==undefined){if(typeof color!=='string'||color.length>500)throw Error('心象颜色无效');out.customColors[key]=color;}}}
 if(v.customCss!==undefined){if(typeof v.customCss!=='string'||v.customCss.length>1000000)throw Error('心象 CSS 无效');out.customCss=v.customCss;}
 return out;
}
