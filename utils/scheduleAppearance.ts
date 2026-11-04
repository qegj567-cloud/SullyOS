import {validateScopedCss} from './scopedCss';
import type {
    ScheduleCardAppearance,
    ScheduleCardPresetId,
} from '../types';

export interface ScheduleCardPreset {
    id: Exclude<ScheduleCardPresetId, 'custom'>;
    name: string;
    description: string;
    background: string;
    base: string;
    text: string;
    accent: string;
}

export interface ScheduleCardPalette {
    preset: ScheduleCardPresetId;
    background: string;
    base: string;
    text: string;
    accent: string;
    accentSoft: string;
    line: string;
    isOriginal: boolean;
}

export const SCHEDULE_CARD_PRESETS: ScheduleCardPreset[] = [
    {
        id: 'original',
        name: '原版星夜',
        description: '跟随角色主题色',
        background: '',
        base: '',
        text: '#ffffff',
        accent: '',
    },
    {
        id: 'cream',
        name: '奶油信笺',
        description: '暖白与焦糖棕',
        background: 'linear-gradient(145deg, #fffaf0, #f0dfc9)',
        base: '#f0dfc9',
        text: '#584337',
        accent: '#b96f4b',
    },
    {
        id: 'sakura',
        name: '樱桃牛乳',
        description: '浅粉与莓果红',
        background: 'linear-gradient(145deg, #fff3f7, #f5dce8)',
        base: '#f5dce8',
        text: '#623d50',
        accent: '#c85d8b',
    },
    {
        id: 'mint',
        name: '薄荷清晨',
        description: '雾绿与深松石',
        background: 'linear-gradient(145deg, #ecfbf5, #cee9df)',
        base: '#cee9df',
        text: '#284b46',
        accent: '#2c9a83',
    },
    {
        id: 'twilight',
        name: '暮光紫',
        description: '柔紫与月光白',
        background: 'linear-gradient(145deg, #352747, #191321)',
        base: '#191321',
        text: '#f6edff',
        accent: '#d3a7ff',
    },
    {
        id: 'midnight',
        name: '午夜青',
        description: '墨蓝与冷青光',
        background: 'linear-gradient(145deg, #14252d, #071117)',
        base: '#071117',
        text: '#edfafa',
        accent: '#70d9cf',
    },
];

function hexToRgba(hex: string, alpha: number): string {
    const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!match) return `color-mix(in srgb, ${hex} ${Math.round(alpha * 100)}%, transparent)`;
    const value = Number.parseInt(match[1], 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

export function resolveScheduleCardPalette(
    appearance: ScheduleCardAppearance | undefined,
    hue: number = 260,
    fallbackText: string = '#ffffff',
): ScheduleCardPalette {
    const presetId = appearance?.preset || 'original';
    if (presetId === 'original') {
        const accent = `hsl(${hue}, 70%, 65%)`;
        return {
            preset: 'original',
            background: `linear-gradient(145deg, hsl(${hue}, 40%, 12%), hsl(${hue}, 35%, 8%))`,
            base: `hsl(${hue}, 40%, 12%)`,
            text: fallbackText,
            accent,
            accentSoft: `hsla(${hue}, 70%, 55%, 0.28)`,
            line: 'rgba(255,255,255,0.16)',
            isOriginal: true,
        };
    }

    const preset = presetId === 'custom'
        ? null
        : SCHEDULE_CARD_PRESETS.find(item => item.id === presetId) || SCHEDULE_CARD_PRESETS[0];
    const background = preset?.background || appearance?.background || '#21192b';
    const base = preset?.base || appearance?.background || '#21192b';
    const text = preset?.text || appearance?.textColor || '#f8f3ff';
    const accent = preset?.accent || appearance?.accentColor || '#c9a7ff';
    return {
        preset: presetId,
        background,
        base,
        text,
        accent,
        accentSoft: hexToRgba(accent, 0.18),
        line: hexToRgba(text, 0.16),
        isOriginal: false,
    };
}

/** 桌面小组件用的配色：开了 desktopGlass 时按原版透底显示，只借用所选配色的强调色。 */
export function resolveScheduleDesktopPalette(
    appearance: ScheduleCardAppearance | undefined,
    hue: number = 260,
    fallbackText: string = '#ffffff',
): ScheduleCardPalette {
    const palette = resolveScheduleCardPalette(appearance, hue, fallbackText);
    if (palette.isOriginal || !appearance?.desktopGlass) return palette;
    return {
        ...resolveScheduleCardPalette(undefined, hue, fallbackText),
        accent: palette.accent,
        accentSoft: palette.accentSoft,
    };
}

export const SCHEDULE_CSS_SCOPE_REGEX = /^\.sully-schedule-[\w-]+\b/;

export const SCHEDULE_CSS_SCOPE_HINT = '`.sully-schedule-*`';

/** Stable public hooks shared by the schedule skin editor and collaboration maker. */
export const SCHEDULE_CUSTOM_CSS_SELECTOR_GROUPS = [
    {
        label: '卡片与宿主',
        selectors: [
            '.sully-schedule-root', '.sully-schedule-card', '.sully-schedule-widget',
            '.sully-schedule-cover', '.sully-schedule-settings',
        ],
    },
    {
        label: '日程内容',
        selectors: [
            '.sully-schedule-header', '.sully-schedule-timeline', '.sully-schedule-list',
            '.sully-schedule-item', '.sully-schedule-item-current', '.sully-schedule-time',
            '.sully-schedule-activity', '.sully-schedule-description',
        ],
    },
    {
        label: '聊天内修改回执',
        selectors: [
            '.sully-schedule-change', '.sully-schedule-change-head', '.sully-schedule-change-mark',
            '.sully-schedule-change-kicker', '.sully-schedule-change-count', '.sully-schedule-change-list',
            '.sully-schedule-change-row', '.sully-schedule-change-time', '.sully-schedule-change-before',
            '.sully-schedule-change-arrow', '.sully-schedule-change-after', '.sully-schedule-change-shine',
        ],
    },
] as const;

export const SCHEDULE_CUSTOM_CSS_SELECTORS = SCHEDULE_CUSTOM_CSS_SELECTOR_GROUPS
    .flatMap(group => [...group.selectors]);

/** Share only appearance fields; daily plans and character data never enter a skin. */
export function validateScheduleAppearance(value:unknown):ScheduleCardAppearance {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('日程表样式无效');
 const v=value as Record<string,unknown>;const out:ScheduleCardAppearance={preset:'original'};
 if(v.preset!==undefined){if(typeof v.preset!=='string'||!['custom',...SCHEDULE_CARD_PRESETS.map(p=>p.id)].includes(v.preset))throw Error('日程表配色无效');out.preset=v.preset as ScheduleCardPresetId;}
 for(const key of ['background','textColor','accentColor','customCss'] as const)if(v[key]!==undefined){if(typeof v[key]!=='string'||v[key].length>(key==='customCss'?1024*1024:500)||/<\/?(?:script|style|html|iframe)\b/i.test(v[key]))throw Error('日程表样式内容无效');out[key]=v[key];}
 if(v.desktopGlass!==undefined){if(typeof v.desktopGlass!=='boolean')throw Error('日程表样式内容无效');out.desktopGlass=v.desktopGlass;}
 const check=validateScopedCss(out.customCss||'',SCHEDULE_CSS_SCOPE_REGEX,SCHEDULE_CSS_SCOPE_HINT);if(!check.isValid)throw Error(check.errors.join('\n'));
 return out;
}
export const SCHEDULE_BEAUTY_PROMPT=`为 SullyOS 日程表制作 CSS。仅使用 .sully-schedule-* 作用域，不修改真实日程内容。覆盖内联样式时用 !important。兼顾完整日程表、桌面小组件、当前与普通事项、长描述和聊天修改回执。可用钩子：${SCHEDULE_CUSTOM_CSS_SELECTORS.join('、')}。变量：--schedule-bg、--schedule-text、--schedule-accent、--schedule-accent-soft、--schedule-base、--schedule-line。只输出 CSS。`;
