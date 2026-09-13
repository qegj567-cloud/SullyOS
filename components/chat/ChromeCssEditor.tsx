import React, { useEffect, useRef, useState } from 'react';
import { DB } from '../../utils/db';
import { shareOrDownloadFile } from '../../utils/shareExport';
import { readShareText } from '../../utils/pngShare';

// 聊天「白框」自定义 CSS 编辑器（Appearance 全局默认 与 单角色定制 共用）。
// 选择器钩子覆盖顶栏、输入栏、整屏背景与普通消息布局；完整清单见下方 AI_PROMPT。

const PRESET_STORE_KEY = 'sully_chrome_css_presets_v1';

// 丢给别的 AI 的提示词（让它按想要的风格生成整段 CSS）。
const AI_PROMPT = `你是一个 CSS 设计师。我在用一个叫 SullyOS·糯米机 的「浏览器里的虚拟手机」聊天 App，
它允许我用一段自定义 CSS 来重新设计聊天外壳与消息布局。
这段 CSS 会被注入到聊天界面里，通过下面这些固定类名生效。请帮我写一整段 CSS，
实现我想要的风格——你有很高的自由度，不要只改颜色，可以大胆重构整个顶栏的视觉。

【可用的类名（只能用这些，别用全局选择器）】
- .sully-chat-root      整个聊天屏（最外层背景）
- .sully-chat-header    顶栏整块（已是 position: relative，可在内部绝对定位子元素）
- .sully-chat-back      左侧返回箭头按钮
- .sully-chat-avatar    角色头像（默认圆形 img，可改尺寸/形状/位置/遮罩）
- .sully-chat-name      角色名字
- .sully-chat-status    名字旁/下的在线状态区
- .sully-chat-buffs     情绪状态栏容器；其中每个情绪胶囊是 .sully-chat-buffs button
- .sully-chat-token     右上角 token 用量小标签
- .sully-chat-trigger   右侧「触发 AI」的小闪电按钮
- .sully-chat-inputbar  底部输入栏整块
- .sully-chat-composer 输入栏内的输入行（建议用此类名，不依赖子元素序号）
- .sully-chat-input-wrap / .sully-chat-textarea 输入框外壳 / 文本输入框
- .sully-chat-actions-button / .sully-chat-send-button 功能按钮 / 发送按钮
- .sully-chat-emoji-suggestions 表情联想区（输入栏外的独立同级区域）
- .sully-chat-auto-reply 自动回复倒计时（输入栏外的独立同级区域）
- .sully-chat-panel     点「＋」拉起的功能面板（表情/动作菜单），其中按钮是 .sully-chat-panel button
- .sully-chat-message   普通消息整行；同时带 -ai / -user 和 -group-first / -group-last 状态类
- .sully-chat-message-content 该条消息的气泡列
- .sully-chat-message-avatar  默认贴在组末气泡旁的头像
- .sully-chat-turn-avatar-slot 每组首条的头像槽（默认 display:none，内部已有正确的双方头像）
- .sully-chat-turn-avatar      上述头像槽里的头像容器；图片是 .sully-chat-message-avatar-img
- .sully-bubble-ai / .sully-bubble-user 角色 / 用户气泡
- .sully-schedule-change      角色修改未来日程后浮出的整张回执
- .sully-schedule-change-head / -mark / -kicker  回执标题行 / 勾选标记 / 标题文字
- .sully-schedule-change-list / -row             修改列表 / 单条修改
- .sully-schedule-change-time / -before / -arrow / -after  时段 / 原计划 / 箭头 / 新计划
- .sully-schedule-change-shine                    掠过回执的一次性高光

【必须遵守的规范】
1. 覆盖默认样式必须加 !important（尤其 .sully-chat-buffs button 带内联样式，不加 !important 盖不掉）。
2. 只允许使用上面的 .sully-chat-* / .sully-bubble-* / .sully-schedule-change* 选择器及其后代/伪元素，禁止写 body、*、div、html 这类全局选择器（会污染其它界面）。
3. 这是移动端窄屏（宽约 390px），尺寸请克制、用相对单位或小数值。
4. 顶栏顶部已自动留出状态栏安全区。装饰若要贴最顶部，用 top: calc(var(--safe-top) + 数值)。
5. 不要 display:none 掉 .sully-chat-back（否则用户无法返回），除非我明确要求。
6. 想让装饰溢出到顶栏外（如垂下的挂饰、超出的波浪），需给 .sully-chat-header 加 overflow: visible。
7. 性能：可以用静态 backdrop-filter/blur，但不要对 blur/backdrop 做持续动画。
8. 若要“每轮头像在气泡上方”：显示 .sully-chat-turn-avatar-slot、隐藏 .sully-chat-message-avatar，
   给 .sully-chat-message-group-first 留出顶部空间，并清零 .sully-chat-message-content 的左右 margin。

【可以自由发挥的部分】
- 背景：纯色、渐变、重复图案、图片（background: url(图片直链)）、多层叠加，随意。
- 形状：border-radius、clip-path（不规则切角/波浪）任意；不规则形状不必额外垫白底。
- 质感：box-shadow、inset 阴影、发光、描边。
- 头像：加边框、光环、改大小/形状（甚至异形/横幅）。
- 文字：字色、字重、字间距、文字阴影/发光。
- 情绪胶囊 / token / 面板按钮：背景色、字色、边框、圆角。
- 重新布局：用 position: absolute 把头像/名字/闪电/token 摆到顶栏里的任意位置。
- 装饰元素：用 ::before / ::after 加角标、条纹、图标、挂件、光带等（记得写 content 和 position）。
- 动画：可用 @keyframes + animation（适度、别太晃眼）。

【输出要求】
直接输出一整段可用的 CSS（可以带少量注释说明），不需要长篇解释。
我现在想要的风格是：______（在这里填你的需求，例如「赛博朋克霓虹」「和风温泉」「Y2K 千禧辣妹」「极简性冷淡」等）`;

type Preset = { name: string; code: string; swatch?: string };

// 从一段 CSS 里尽力抠出 .sully-chat-header 的背景值，给「我的预设」生成缩略色块（抠不到则用中性灰）。
const extractSwatch = (code: string): string => {
    const block = code.match(/\.sully-chat-header\s*\{([^}]*)\}/);
    const body = block ? block[1] : code;
    const m = body.match(/background(?:-color)?\s*:\s*([^;!]+)/i);
    const val = m ? m[1].trim() : '';
    return val && !/url\(/i.test(val) ? val : '#e2e8f0';
};

// 内置完整风格（点击=替换文本框、立刻生效）。
const PRESETS: Preset[] = [
    {
        name: '奶油少女',
        swatch: 'linear-gradient(135deg,#ffe3ef,#fff2e2 55%,#f1e7ff)',
        code: `/* 奶油少女 */
.sully-chat-header{
  background:linear-gradient(135deg,#ffe3ef,#fff2e2 55%,#f1e7ff)!important;
  border-bottom:none!important;
  box-shadow:0 6px 18px rgba(214,160,180,.18);
  border-radius:0 0 22px 22px;
}
.sully-chat-name{color:#c2587f!important;}
.sully-chat-avatar{border:2px solid #ffb8d4!important;box-shadow:0 0 0 4px rgba(255,184,212,.25)!important;}
.sully-chat-buffs button{background:#fff0f6!important;color:#d6478b!important;border-color:#ffc6df!important;}
.sully-chat-trigger{color:#e86aa6!important;}
.sully-chat-token{background:#fff0f6!important;color:#c76aa0!important;border-color:#ffd4e6!important;}`,
    },
    {
        name: '霓虹夜',
        swatch: 'radial-gradient(circle at 30% 30%,#3b1d63,#0e0b1e 75%)',
        code: `/* 霓虹夜 */
.sully-chat-header{
  background:#0e0b1e!important;
  border-bottom:1px solid rgba(168,85,247,.45)!important;
  box-shadow:0 0 26px rgba(168,85,247,.3);
}
.sully-chat-name{color:#e9d5ff!important;text-shadow:0 0 10px rgba(192,132,252,.9);}
.sully-chat-status{color:#a78bfa!important;}
.sully-chat-back,.sully-chat-trigger{color:#67e8f9!important;}
.sully-chat-avatar{border:2px solid #67e8f9!important;box-shadow:0 0 12px rgba(103,232,249,.6)!important;}
.sully-chat-buffs button{background:rgba(103,232,249,.12)!important;color:#a5f3fc!important;border-color:rgba(103,232,249,.4)!important;}
.sully-chat-token{background:rgba(168,85,247,.15)!important;color:#d8b4fe!important;border-color:rgba(168,85,247,.4)!important;}`,
    },
    {
        name: '薄荷奶绿',
        swatch: 'linear-gradient(135deg,#e3f9ee,#f0fff4 60%,#e0f5ff)',
        code: `/* 薄荷奶绿 */
.sully-chat-header{
  background:linear-gradient(135deg,#e3f9ee,#f0fff4 60%,#e0f5ff)!important;
  border-bottom:none!important;
  box-shadow:0 6px 16px rgba(120,190,160,.16);
  border-radius:0 0 20px 20px;
}
.sully-chat-name{color:#2f8f6b!important;}
.sully-chat-avatar{border:2px solid #8fe0bf!important;box-shadow:0 0 0 4px rgba(143,224,191,.25)!important;}
.sully-chat-buffs button{background:#e7faf0!important;color:#22936a!important;border-color:#abe6cd!important;}
.sully-chat-trigger{color:#2bb088!important;}
.sully-chat-token{background:#e7faf0!important;color:#3a9b76!important;border-color:#bdebd6!important;}`,
    },
    {
        name: '暮光紫',
        swatch: 'linear-gradient(135deg,#3b2a63,#5a3f86 55%,#7e5aa6)',
        code: `/* 暮光紫 */
.sully-chat-header{
  background:linear-gradient(135deg,#3b2a63,#5a3f86 55%,#7e5aa6)!important;
  border-bottom:none!important;
  box-shadow:0 8px 22px rgba(80,50,130,.3);
  border-radius:0 0 18px 18px;
}
.sully-chat-name{color:#fce7ff!important;}
.sully-chat-status{color:#d6bcfa!important;}
.sully-chat-back,.sully-chat-trigger{color:#f5d0fe!important;}
.sully-chat-avatar{border:2px solid rgba(255,255,255,.7)!important;box-shadow:0 4px 14px rgba(0,0,0,.3)!important;}
.sully-chat-buffs button{background:rgba(255,255,255,.16)!important;color:#fbe8ff!important;border-color:rgba(255,255,255,.3)!important;}
.sully-chat-token{background:rgba(255,255,255,.14)!important;color:#f0e0ff!important;border-color:rgba(255,255,255,.25)!important;}`,
    },
    {
        name: '极简白',
        swatch: 'linear-gradient(135deg,#ffffff,#f3f4f6)',
        code: `/* 极简白 */
.sully-chat-header{background:#ffffff!important;border-bottom:1px solid #eef1f5!important;box-shadow:none!important;}
.sully-chat-name{color:#1f2937!important;}
.sully-chat-avatar{border:1.5px solid #e5e7eb!important;}
.sully-chat-buffs button{background:#f5f6f8!important;color:#6b7280!important;border-color:#e5e7eb!important;}
.sully-chat-trigger{color:#6366f1!important;}
.sully-chat-token{background:#f5f6f8!important;color:#9ca3af!important;border-color:#e5e7eb!important;}`,
    },
    {
        name: '淡紫毛绒',
        swatch: 'radial-gradient(150% 120% at 50% -30%,#ddc9ff,#c9b2f4 45%,#bda0ee)',
        code: `/* ===== 淡紫毛绒 · 温柔风 ===== */
.sully-chat-root{
  background:
    radial-gradient(120% 80% at 18% 0%, #f4ecff 0%, transparent 58%),
    radial-gradient(120% 80% at 92% 8%, #ffe9f7 0%, transparent 52%),
    linear-gradient(180deg, #efe6ff 0%, #f6f1ff 48%, #fcf9ff 100%) !important;
}
.sully-chat-header{
  overflow:visible !important;
  background:radial-gradient(150% 120% at 50% -30%, #ddc9ff 0%, #c9b2f4 45%, #bda0ee 100%) !important;
  border:none !important;
  border-radius:0 0 24px 24px !important;
  box-shadow:inset 0 2px 6px rgba(255,255,255,.6), inset 0 -10px 20px rgba(150,108,222,.35), 0 10px 26px rgba(178,142,236,.4) !important;
}
.sully-chat-header::before{
  content:"" !important;position:absolute !important;
  top:calc(var(--safe-top) + 4px) !important;right:14px !important;
  width:60px !important;height:60px !important;border-radius:50% !important;
  background:radial-gradient(circle, rgba(255,255,255,.55) 0%, transparent 70%) !important;
  filter:blur(2px) !important;pointer-events:none !important;
}
.sully-chat-back{
  color:#8a6bc4 !important;background:rgba(255,255,255,.65) !important;border-radius:50% !important;
  box-shadow:inset 0 1px 2px rgba(255,255,255,.9), 0 2px 6px rgba(160,120,220,.35) !important;
}
.sully-chat-avatar{
  width:46px !important;height:46px !important;border-radius:50% !important;border:3px solid #fff !important;
  box-shadow:0 0 0 3px rgba(220,200,255,.75), 0 0 16px 3px rgba(200,160,245,.6), 0 4px 10px rgba(160,120,220,.45) !important;
  animation:sully-float 4.5s ease-in-out infinite !important;
}
@keyframes sully-float{0%,100%{transform:translateY(0);}50%{transform:translateY(-2.5px);}}
.sully-chat-name{color:#fff !important;font-weight:700 !important;letter-spacing:.5px !important;text-shadow:0 1px 4px rgba(135,95,205,.55), 0 0 10px rgba(255,255,255,.4) !important;}
.sully-chat-name::after{content:" ✦" !important;color:#fff3ff !important;font-size:.8em !important;text-shadow:0 0 6px rgba(255,255,255,.8) !important;}
.sully-chat-status{color:#f3ebff !important;font-size:.72rem !important;text-shadow:0 1px 2px rgba(130,90,200,.4) !important;}
.sully-chat-buffs button{
  background:rgba(255,255,255,.62) !important;color:#7a5bb0 !important;border:1.5px solid rgba(255,255,255,.85) !important;
  border-radius:999px !important;font-weight:600 !important;padding:2px 10px !important;
  box-shadow:0 2px 6px rgba(180,140,230,.3), inset 0 1px 2px rgba(255,255,255,.85) !important;backdrop-filter:blur(4px) !important;
}
.sully-chat-token{color:#8a6bc4 !important;background:rgba(255,255,255,.5) !important;border-radius:999px !important;padding:1px 8px !important;font-size:.66rem !important;box-shadow:inset 0 1px 2px rgba(255,255,255,.8) !important;}
.sully-chat-trigger{
  color:#fff !important;background:radial-gradient(circle at 35% 30%, #d9b8ff, #b98cf0) !important;border-radius:50% !important;
  box-shadow:0 0 0 2px rgba(255,255,255,.6), 0 0 14px 2px rgba(200,150,250,.7), 0 3px 8px rgba(150,100,210,.45) !important;
  animation:sully-breathe 3.2s ease-in-out infinite !important;
}
@keyframes sully-breathe{0%,100%{box-shadow:0 0 0 2px rgba(255,255,255,.6), 0 0 12px 2px rgba(200,150,250,.55), 0 3px 8px rgba(150,100,210,.45);}50%{box-shadow:0 0 0 2px rgba(255,255,255,.7), 0 0 20px 5px rgba(210,165,255,.85), 0 3px 8px rgba(150,100,210,.45);}}
.sully-chat-inputbar{
  background:linear-gradient(180deg, rgba(255,255,255,.85), rgba(245,238,255,.92)) !important;border:1.5px solid rgba(255,255,255,.9) !important;
  border-radius:22px 22px 0 0 !important;box-shadow:inset 0 2px 5px rgba(255,255,255,.9), 0 -6px 18px rgba(180,140,230,.28) !important;backdrop-filter:blur(8px) !important;
}`,
    },
    {
        name: '和风温泉',
        swatch: 'linear-gradient(165deg,#ffe3c4,#ffd0b0 38%,#ffb9ad 62%,#f7a9b0 84%,#ef9bb0)',
        code: `/* ===== 和风温泉・晨光汤屋 ===== */
.sully-chat-root{background:linear-gradient(180deg,#fdf3e7 0%, #fbe9da 45%, #f6e4ea 100%) !important;}
.sully-chat-header{
  overflow:visible !important;border-bottom:none !important;box-shadow:0 .3rem .9rem rgba(180,120,110,.28) !important;
  background:
    radial-gradient(circle at 100% 50%, transparent 62%, rgba(122,74,68,.07) 63% 70%, transparent 71%) 0 0 / 1.1rem 1.9rem,
    radial-gradient(circle at 0 50%,   transparent 62%, rgba(122,74,68,.07) 63% 70%, transparent 71%) .55rem -.95rem / 1.1rem 1.9rem,
    linear-gradient(165deg,#ffe3c4 0%, #ffd0b0 38%, #ffb9ad 62%, #f7a9b0 84%, #ef9bb0 100%) !important;
}
.sully-chat-header::before{
  content:"";position:absolute;left:.6rem;right:.6rem;top:calc(var(--safe-top) + .1rem);height:2.6rem;pointer-events:none;z-index:0;
  background:
    radial-gradient(42% 60% at 22% 80%, rgba(255,255,255,.55), transparent 70%),
    radial-gradient(36% 55% at 52% 85%, rgba(255,255,255,.48), transparent 70%),
    radial-gradient(34% 50% at 80% 82%, rgba(255,255,255,.42), transparent 70%);
  filter:blur(3px);opacity:0;animation:sully-steam 7s ease-in-out infinite;
}
.sully-chat-header::after{
  content:"";position:absolute;left:0;right:0;bottom:-.55rem;height:1rem;pointer-events:none;z-index:2;
  background-image:
    radial-gradient(circle at .5rem .62rem, rgba(246,178,107,.98) 0 .3rem, rgba(212,96,74,.98) .3rem .34rem, transparent .36rem),
    linear-gradient(rgba(160,100,90,.6), rgba(160,100,90,.6));
  background-size:1.5rem 100%, 100% .07rem;background-position:0 0, 0 .18rem;background-repeat:repeat-x, repeat-x;
  filter:drop-shadow(0 .15rem .25rem rgba(212,96,74,.4));
}
.sully-chat-back{color:#7d4a44 !important;background:rgba(255,255,255,.5) !important;border:.08rem solid rgba(122,74,68,.3) !important;border-radius:50% !important;box-shadow:inset 0 0 .35rem rgba(255,255,255,.6), 0 .1rem .25rem rgba(180,120,110,.25) !important;}
.sully-chat-avatar{width:2.6rem !important;height:2.6rem !important;border-radius:50% !important;border:.12rem solid #fff7ee !important;object-fit:cover !important;box-shadow:0 0 0 .16rem rgba(212,96,74,.55), 0 0 .8rem rgba(246,178,107,.7), inset 0 0 .4rem rgba(0,0,0,.18) !important;}
.sully-chat-name{position:relative;z-index:1;color:#5a3243 !important;font-weight:700 !important;letter-spacing:.06em !important;text-shadow:0 .06rem 0 rgba(255,255,255,.5) !important;}
.sully-chat-status{position:relative;z-index:1;color:#3f8f6a !important;font-size:.66rem !important;letter-spacing:.04em !important;}
.sully-chat-status::before{content:"";display:inline-block;width:.42rem;height:.42rem;margin-right:.3rem;border-radius:50%;vertical-align:middle;background:#5cc486;box-shadow:0 0 .35rem rgba(92,196,134,.85);animation:sully-pulse 2.6s ease-in-out infinite;}
.sully-chat-buffs{gap:.3rem !important;position:relative;z-index:1;}
.sully-chat-buffs button{background:linear-gradient(#ffffff, #fdeede) !important;color:#8a4a44 !important;border:.07rem solid rgba(122,74,68,.4) !important;border-radius:.7rem !important;font-size:.66rem !important;font-weight:600 !important;letter-spacing:.02em !important;padding:.16rem .5rem !important;box-shadow:0 .1rem .25rem rgba(180,120,110,.3), inset 0 .05rem 0 rgba(255,255,255,.8) !important;}
.sully-chat-token{color:#6a3d38 !important;background:linear-gradient(#ffffff, #fbeede) !important;border:.06rem solid rgba(122,74,68,.35) !important;border-radius:.5rem !important;font-size:.62rem !important;letter-spacing:.02em !important;box-shadow:0 .1rem .25rem rgba(180,120,110,.28) !important;}
.sully-chat-trigger{color:#fff5e8 !important;background:radial-gradient(circle at 30% 30%, #f6b26b, #e0664a 72%) !important;border:.1rem solid rgba(255,255,255,.7) !important;border-radius:50% !important;animation:sully-ember 3.2s ease-in-out infinite;}
.sully-chat-inputbar{background:linear-gradient(180deg,#fff6ea,#ffece0) !important;border-top:.12rem solid rgba(212,96,74,.4) !important;border-radius:.9rem .9rem 0 0 !important;box-shadow:0 -.3rem .7rem rgba(180,120,110,.22), inset 0 .08rem 0 rgba(255,255,255,.7) !important;}
@keyframes sully-steam{0%{opacity:0;transform:translateY(.4rem) scaleY(.9);}50%{opacity:.5;}100%{opacity:0;transform:translateY(-.5rem) scaleY(1.12);}}
@keyframes sully-pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.5;transform:scale(.82);}}
@keyframes sully-ember{0%,100%{box-shadow:0 0 .5rem rgba(224,102,74,.6), inset 0 .1rem .2rem rgba(255,255,255,.35);}50%{box-shadow:0 0 .9rem rgba(246,178,107,.95), inset 0 .1rem .2rem rgba(255,255,255,.4);}}`,
    },
];

// 自定义预设存 IndexedDB（STORE_ASSETS，随 app 备份/导出一起走）；旧 localStorage 自动一次性迁移过来。
const PRESET_ASSET_KEY = 'chrome_css_presets';

const loadCustom = async (): Promise<Preset[]> => {
    try { const fromDb = await DB.getAssetRaw(PRESET_ASSET_KEY); if (Array.isArray(fromDb)) return fromDb; } catch { /* ignore */ }
    // 迁移旧 localStorage → IndexedDB
    try {
        const raw = localStorage.getItem(PRESET_STORE_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        if (Array.isArray(arr) && arr.length) { await DB.saveAssetRaw(PRESET_ASSET_KEY, arr); localStorage.removeItem(PRESET_STORE_KEY); return arr; }
    } catch { /* ignore */ }
    return [];
};
const persistCustom = async (list: Preset[]) => { try { await DB.saveAssetRaw(PRESET_ASSET_KEY, list); } catch { /* ignore */ } };

// 导出码：SULLYCSS1: + base64(utf8(JSON))，方便整段复制分享/换机带走。
const encodePresets = (list: Preset[]): string => 'SULLYCSS1:' + btoa(unescape(encodeURIComponent(JSON.stringify(list))));
const decodePresets = (code: string): Preset[] => {
    const body = code.trim().replace(/^SULLYCSS1:/, '');
    const json = decodeURIComponent(escape(atob(body)));
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((p: any) => p && typeof p.name === 'string' && typeof p.code === 'string') : [];
};

const copyText = async (text: string): Promise<boolean> => {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
    } catch { return false; }
};

const ChromeCssEditor: React.FC<{ value: string; onChange: (css: string) => void }> = ({ value, onChange }) => {
    const [copied, setCopied] = useState(false);
    const [custom, setCustom] = useState<Preset[]>([]);
    const txtImportRef = useRef<HTMLInputElement>(null);
    const presetImageRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        let alive = true;
        loadCustom().then((list) => { if (alive) setCustom(list); });
        return () => { alive = false; };
    }, []);

    const commitCustom = (next: Preset[]) => { setCustom(next); persistCustom(next); };

    const handleCopyPrompt = async () => {
        if (await copyText(AI_PROMPT)) { setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    };
    const handleSavePreset = () => {
        if (!value.trim() || typeof window === 'undefined') return;
        const name = window.prompt('给这套装扮 CSS 预设起个名字（所有角色通用）：', '我的预设')?.trim();
        if (!name) return;
        commitCustom([...custom.filter((p) => p.name !== name), { name, code: value }]);
    };
    const handleDeletePreset = (name: string) => commitCustom(custom.filter((p) => p.name !== name));

    const handleTxtImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const css = (await readShareText(file, 'chrome-css')).replace(/^\uFEFF/, '');
            if (!css.trim()) {
                window.alert('TXT 文件内容为空。');
                return;
            }
            onChange(css);
        } catch (error: any) {
            window.alert(error?.message || '样式导入失败，请确认文件可以正常读取。');
        } finally {
            event.target.value = '';
        }
    };

    const handleTxtExport = async () => {
        if (!value.trim()) {
            window.alert('当前没有可导出的 CSS。');
            return;
        }
        const date = new Date();
        const dateKey = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
        const fileName = `sullyos-whitebox-${dateKey}.txt`;
        try {
            await shareOrDownloadFile({
                card: { kind: 'chrome-css', title: '白框样式' },
                content: value,
                fileName,
                mimeType: 'text/plain;charset=utf-8',
                shareTitle: 'SullyOS·糯米机 白框样式',
            });
        } catch (error: any) {
            if (error?.name !== 'AbortError') window.alert('TXT 导出失败，请重试。');
        }
    };

    const handleExport = async () => {
        if (!custom.length) { window.alert('还没有「我的预设」可导出。'); return; }
        const ok = await copyText(encodePresets(custom));
        window.alert(ok ? `已复制 ${custom.length} 套预设的导出码到剪贴板，发给别人或换机粘贴导入即可。` : '复制失败，请重试。');
    };
    const handleImport = () => {
        if (typeof window === 'undefined') return;
        const code = window.prompt('粘贴预设导出码（SULLYCSS1:...）：', '')?.trim();
        if (!code) return;
        importPresetCode(code);
    };
    const importPresetCode = (code: string) => {
        let incoming: Preset[] = [];
        try { incoming = decodePresets(code); } catch { window.alert('导出码无法识别，请确认完整粘贴。'); return; }
        if (!incoming.length) { window.alert('没解析到有效预设。'); return; }
        // 同名覆盖，其余追加
        const map = new Map(custom.map((p) => [p.name, p] as const));
        incoming.forEach((p) => map.set(p.name, p));
        commitCustom(Array.from(map.values()));
        window.alert(`已导入 ${incoming.length} 套预设。`);
    };

    const cardCls = 'group relative h-14 w-[78px] shrink-0 overflow-hidden rounded-xl border border-black/5 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md active:scale-95';
    const cardLabelCls = 'absolute inset-x-0 bottom-0 truncate px-1.5 py-1 text-[10px] font-bold text-white';

    return (
        <div className="space-y-4">
            {/* 需要灵感：复制提示词给 AI */}
            <button onClick={handleCopyPrompt}
                className="flex w-full items-center gap-2.5 rounded-2xl border border-indigo-100 bg-gradient-to-r from-indigo-50 to-violet-50 px-3.5 py-3 text-left transition-all hover:from-indigo-100 hover:to-violet-100 active:scale-[0.99]">
                <span className="text-lg leading-none">{copied ? '✓' : '🪄'}</span>
                <span className="min-w-0">
                    <span className="block text-[12px] font-bold text-indigo-700">{copied ? '已复制！丢给任意 AI 即可' : '让 AI 帮你写一套'}</span>
                    <span className="block text-[10px] leading-snug text-indigo-400">复制提示词 → 发给任何 AI，说出你想要的风格，把它给的 CSS 粘回来</span>
                </span>
            </button>

            {/* 内置风格：缩略色块卡片 */}
            <div>
                <div className="mb-2 text-[11px] font-bold text-slate-500">内置风格 <span className="font-normal text-slate-400">· 点一下套用</span></div>
                <div className="flex flex-wrap gap-2">
                    {PRESETS.map((p) => (
                        <button key={p.name} onClick={() => onChange(p.code)} title={p.name} className={cardCls}>
                            <span className="absolute inset-0" style={{ background: p.swatch }} />
                            <span className={cardLabelCls} style={{ background: 'linear-gradient(to top, rgba(0,0,0,.5), transparent)' }}>{p.name}</span>
                        </button>
                    ))}
                </div>
            </div>

            {/* 我的预设：全角色通用，存 IndexedDB（随备份走），可导入导出 */}
            <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-1.5">
                    <span className="text-[11px] font-bold text-slate-500">我的预设 <span className="font-normal text-slate-400">· 全角色通用</span></span>
                    <div className="flex items-center gap-1">
                        <input ref={presetImageRef} type="file" accept=".png,.txt,image/png,text/plain" hidden onChange={async event => {
                            const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
                            try { importPresetCode(await readShareText(file, 'chrome-presets')); }
                            catch (error: any) { window.alert(error?.message || '预设导入失败'); }
                        }} />
                        <button onClick={() => presetImageRef.current?.click()} className="rounded-md px-2 py-1 text-[10px] font-semibold text-indigo-500">图片导入</button>
                        <button disabled={!custom.length} onClick={async () => {
                            try { await shareOrDownloadFile({ content: encodePresets(custom), fileName: '白框预设集.txt', mimeType: 'text/plain', card: { kind: 'chrome-presets', title: '白框预设集' } }); }
                            catch (error: any) { window.alert(error?.message || '预设导出失败'); }
                        }} className="rounded-md px-2 py-1 text-[10px] font-semibold text-indigo-500 disabled:opacity-30">图片分享</button>
                        <button onClick={handleImport} className="rounded-md px-2 py-1 text-[10px] font-semibold text-slate-400 hover:bg-slate-100 hover:text-slate-600">导入</button>
                        <button onClick={handleExport} disabled={!custom.length} className={`rounded-md px-2 py-1 text-[10px] font-semibold ${custom.length ? 'text-slate-400 hover:bg-slate-100 hover:text-slate-600' : 'text-slate-300'}`}>导出</button>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    {custom.map((p) => (
                        <div key={p.name} className={cardCls}>
                            <button onClick={() => onChange(p.code)} title={p.name} className="absolute inset-0">
                                <span className="absolute inset-0" style={{ background: extractSwatch(p.code) }} />
                                <span className={cardLabelCls} style={{ background: 'linear-gradient(to top, rgba(0,0,0,.5), transparent)' }}>{p.name}</span>
                            </button>
                            <button onClick={() => handleDeletePreset(p.name)} title="删除"
                                className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/45 text-[10px] leading-none text-white opacity-80 hover:bg-rose-500">×</button>
                        </div>
                    ))}
                    {/* 保存当前为预设 */}
                    <button onClick={handleSavePreset} disabled={!value.trim()} title={value.trim() ? '把当前 CSS 存为预设' : '先写点 CSS'}
                        className={`flex h-14 w-[78px] shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border border-dashed text-[10px] font-bold transition-all active:scale-95 ${value.trim() ? 'border-emerald-300 text-emerald-600 hover:bg-emerald-50' : 'border-slate-200 text-slate-300'}`}>
                        <span className="text-lg leading-none">＋</span>存当前
                    </button>
                </div>
            </div>

            {/* CSS 代码区 */}
            <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-bold text-slate-500">CSS 代码 <span className="font-normal text-slate-400">· 可手改 / 粘贴</span></span>
                    <div className="flex items-center gap-1">
                        <input ref={txtImportRef} type="file" accept=".png,.css,.txt,image/png,text/css,text/plain" className="hidden" onChange={handleTxtImport} />
                        <button onClick={() => txtImportRef.current?.click()} className="rounded-lg px-2 py-1 text-[10px] font-semibold text-indigo-500 hover:bg-indigo-50">导入 PNG / CSS</button>
                        <button onClick={handleTxtExport} disabled={!value.trim()} className={`rounded-lg px-2 py-1 text-[10px] font-semibold ${value.trim() ? 'text-indigo-500 hover:bg-indigo-50' : 'text-slate-300'}`}>导出分享</button>
                        {value && <button onClick={() => onChange('')} className="rounded-lg px-2 py-1 text-[10px] font-semibold text-rose-400 hover:bg-rose-50 hover:text-rose-500">清空</button>}
                    </div>
                </div>
                <textarea
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={'/* 点上面任一套，或在这里直接写 / 粘贴 CSS */\n.sully-chat-header{\n  background: linear-gradient(135deg,#ffe3ef,#f1e7ff) !important;\n  border-bottom: none !important;\n}'}
                    spellCheck={false}
                    rows={8}
                    className="w-full resize-y rounded-2xl border border-slate-700 bg-slate-900 p-4 font-mono text-xs leading-relaxed text-slate-200 outline-none focus:border-primary/50 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                />
                <div className="mt-1.5 text-[10px] leading-relaxed text-slate-400">
                    可用选择器：<code className="rounded bg-slate-100 px-1 text-slate-500">.sully-chat-header / -avatar / -name / -buffs / -token / -trigger / -back / -status / -inputbar / -panel / -root</code>
                </div>
                <div className="mt-1 text-[10px] leading-relaxed text-slate-400">
                    日程修改动效：<code className="rounded bg-slate-100 px-1 text-slate-500">.sully-schedule-change / -head / -mark / -kicker / -list / -row / -time / -before / -arrow / -after / -shine</code>
                </div>
            </div>
        </div>
    );
};

export default ChromeCssEditor;
