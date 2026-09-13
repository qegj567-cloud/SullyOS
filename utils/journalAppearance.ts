import type { JournalAppearance, JournalAppearancePresetId } from '../types';

export type JournalLayoutId = 'classic' | 'postal-archive' | 'celestial-album' | 'field-dossier' | 'memory-editor';

export interface JournalAppearancePreset {
    id: JournalAppearancePresetId;
    name: string;
    description: string;
    colors: [string, string, string];
    layout: JournalLayoutId;
    css: string;
}

export const JOURNAL_CSS_SCOPE_REGEX = /^\.sully-journal(?:\b|-)/;
export const JOURNAL_CSS_SCOPE_HINT = '.sully-journal-root / .sully-journal-*';

/**
 * Public CSS hooks for the exchange-journal skin editor. Keep this list in
 * sync with JournalApp and JournalThemeArtwork: it is copied verbatim into
 * the AI prompt so generated skins do not have to guess DOM class names.
 */
export const JOURNAL_CUSTOM_CSS_SELECTOR_GROUPS = [
    {
        label: 'App 与页面状态',
        selectors: [
            '.sully-journal-root', '.sully-journal-select', '.sully-journal-calendar',
            '.sully-journal-write', '.sully-journal-designed',
            '.sully-journal-theme-letterpress', '.sully-journal-theme-sakura',
            '.sully-journal-theme-forest', '.sully-journal-theme-midnight',
        ],
    },
    {
        label: '顶部与导航',
        selectors: [
            '.sully-journal-header', '.sully-journal-header-title', '.sully-journal-back',
            '.sully-journal-appearance-button', '.sully-journal-group-filter',
        ],
    },
    {
        label: '日记本选择页',
        selectors: [
            '.sully-journal-notebook-grid', '.sully-journal-notebook',
            '.sully-journal-notebook-avatar', '.sully-journal-notebook-name',
            '.sully-journal-notebook-label',
        ],
    },
    {
        label: '日记列表页',
        selectors: [
            '.sully-journal-calendar-hero', '.sully-journal-calendar-heading',
            '.sully-journal-calendar-kicker', '.sully-journal-calendar-title',
            '.sully-journal-calendar-list', '.sully-journal-new-entry',
            '.sully-journal-entry', '.sully-journal-entry-accent',
            '.sully-journal-entry-date', '.sully-journal-entry-text',
            '.sully-journal-entry-year', '.sully-journal-entry-badges',
            '.sully-journal-empty',
        ],
    },
    {
        label: '书写与双页',
        selectors: [
            '.sully-journal-editor-header', '.sully-journal-editor-stage',
            '.sully-journal-spread', '.sully-journal-spread-page',
            '.sully-journal-spread-page.is-inactive', '.sully-journal-spread-user',
            '.sully-journal-spread-char', '.sully-journal-paper',
            '.sully-journal-paper-user', '.sully-journal-paper-char',
            '.sully-journal-page-content', '.sully-journal-page-meta',
            '.sully-journal-page-title', '.sully-journal-page-date',
            '.sully-journal-textarea', '.sully-journal-sticker', '.sully-journal-texture',
        ],
    },
    {
        label: '底部工具',
        selectors: [
            '.sully-journal-bottom-controls', '.sully-journal-tabs', '.sully-journal-tab',
            '.sully-journal-tab-active', '.sully-journal-paper-picker',
            '.sully-journal-paper-swatch', '.sully-journal-sticker-button',
            '.sully-journal-sticker-panel',
        ],
    },
    {
        label: '主题装饰层',
        selectors: [
            '.sully-journal-theme-art', '.sully-journal-theme-art-letterpress',
            '.sully-journal-theme-art-sakura', '.sully-journal-theme-art-forest',
            '.sully-journal-theme-art-midnight', '.sully-journal-theme-art-select',
            '.sully-journal-theme-art-calendar', '.sully-journal-theme-art-write',
            '.sully-journal-post-route', '.sully-journal-post-plane',
            '.sully-journal-postmark', '.sully-journal-envelope-corner',
            '.sully-journal-airmail-stripe', '.sully-journal-celestial-map',
            '.sully-journal-orbits', '.sully-journal-constellation',
            '.sully-journal-star-medallion', '.sully-journal-photo-corners',
            '.sully-journal-satin-ribbon', '.sully-journal-botanical-sheet',
            '.sully-journal-botanical-stem', '.sully-journal-measure-lines',
            '.sully-journal-specimen-arrow', '.sully-journal-field-rings',
            '.sully-journal-field-tabs', '.sully-journal-specimen-seal',
            '.sully-journal-memory-circuit', '.sully-journal-window-chrome',
            '.sully-journal-inspector-ghost', '.sully-journal-cursor-spark',
        ],
    },
] as const;

export const JOURNAL_CUSTOM_CSS_SELECTORS = JOURNAL_CUSTOM_CSS_SELECTOR_GROUPS
    .flatMap(group => [...group.selectors]);

const journalSelectorPrompt = JOURNAL_CUSTOM_CSS_SELECTOR_GROUPS
    .map(group => `${group.label}：\n${group.selectors.join('、')}`)
    .join('\n\n');

export const JOURNAL_AI_CSS_PROMPT = `你是 CSS 设计师，请为 SullyOS·糯米机 的「交换日记」App 写一段完整的自定义 CSS。

要求：
1. 只能使用下列公开选择器；每条普通规则都必须以 .sully-journal-root 或 .sully-journal-* 开头。
2. 可以组合后代、子元素、伪类、伪元素和媒体查询，覆盖原样式时可使用 !important；不要输出 JavaScript、HTML 或全局 body/html 规则。
3. 顶部返回键和美化入口是安全出口，不得用 display:none、visibility:hidden、opacity:0、pointer-events:none 或移出屏幕的方式隐藏。
4. 同时适配手机单页与较宽屏幕；正文、日期、返回键、新建按钮、输入区和底部工具必须清晰可操作。
5. 请做成一套完整的实体手账界面，不只是换颜色。可以设计纸张层次、装订、贴纸、胶带、日期标签、角色照片与轻量动画，但装饰层必须 pointer-events:none，不能遮住正文和按钮。

全部可用选择器：
${journalSelectorPrompt}

请直接输出一整段可粘贴的 CSS，可以带少量注释，不要长篇解释。
我想要的风格是：______`;

/**
 * Written after preset/custom CSS. A broken imported skin may restyle the
 * header, but it must never remove the controls needed to leave the App or
 * reopen this editor and reset the skin.
 */
export const JOURNAL_APPEARANCE_SAFETY_CSS = `
html body .sully-journal-root.sully-journal-root{
  display:flex!important;
  visibility:visible!important;
  opacity:1!important;
  pointer-events:auto!important;
  min-height:100%!important;
}
html body .sully-journal-root.sully-journal-root .sully-journal-header,
html body .sully-journal-root.sully-journal-root .sully-journal-calendar-hero,
html body .sully-journal-root.sully-journal-root .sully-journal-editor-header{
  display:block!important;
  visibility:visible!important;
  opacity:1!important;
  pointer-events:auto!important;
}
html body .sully-journal-root.sully-journal-root::before,
html body .sully-journal-root.sully-journal-root::after,
html body .sully-journal-root.sully-journal-root *::before,
html body .sully-journal-root.sully-journal-root *::after{
  pointer-events:none!important;
}
html body .sully-journal-root.sully-journal-root .sully-journal-header,
html body .sully-journal-root.sully-journal-root .sully-journal-editor-header{
  padding-top:max(var(--chrome-top,0px),env(safe-area-inset-top,0px))!important;
}
html body .sully-journal-root.sully-journal-root .sully-journal-calendar-hero{
  padding-top:max(3rem,var(--safe-top,0px),env(safe-area-inset-top,0px))!important;
}
html body .sully-journal-root.sully-journal-root .sully-journal-back,
html body .sully-journal-root.sully-journal-root .sully-journal-appearance-button{
  display:grid!important;
  visibility:visible!important;
  opacity:1!important;
  pointer-events:auto!important;
  position:relative!important;
  z-index:2147483000!important;
}`;

/* 邮局档案：横向信封、打字机索引卡、航空邮路。 */
const LETTERPRESS_CSS = `.sully-journal-theme-letterpress{
  --postal-red:#a34e3d;--postal-blue:#355d65;--postal-ink:#352a24;--postal-paper:#f4e7cb;--postal-desk:#44362e;
  background:#dfcfaf!important;color:var(--postal-ink)!important;font-family:ui-monospace,"SFMono-Regular","Songti SC",serif!important;
  background-image:repeating-linear-gradient(0deg,rgba(76,54,38,.035) 0 1px,transparent 1px 5px)!important;
}
.sully-journal-theme-letterpress .sully-journal-theme-art{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none;color:var(--postal-red);}
.sully-journal-theme-letterpress .sully-journal-post-route{position:absolute;inset:0;width:100%;height:100%;opacity:.2;fill:none;stroke:currentColor;stroke-width:2;stroke-dasharray:8 7;}
.sully-journal-theme-letterpress .sully-journal-post-route circle{fill:var(--postal-paper);stroke-width:3;stroke-dasharray:none;}
.sully-journal-theme-letterpress .sully-journal-post-plane{fill:var(--postal-red);stroke:none;}
.sully-journal-theme-letterpress .sully-journal-postmark{position:absolute;right:6%;top:16%;width:92px;height:92px;border:3px double currentColor;border-radius:50%;display:grid;place-content:center;text-align:center;transform:rotate(11deg);opacity:.26;}
.sully-journal-theme-letterpress .sully-journal-postmark b{font-size:9px;letter-spacing:.12em}.sully-journal-theme-letterpress .sully-journal-postmark span{font-size:7px}.sully-journal-theme-letterpress .sully-journal-postmark i{height:1px;width:120px;background:currentColor;box-shadow:0 5px currentColor,0 -5px currentColor;position:absolute;left:-14px;top:64px;}
.sully-journal-theme-letterpress .sully-journal-envelope-corner{position:absolute;left:-80px;bottom:-100px;width:310px;height:220px;border:2px solid rgba(53,93,101,.22);transform:rotate(8deg);background:linear-gradient(33deg,transparent 49.5%,rgba(53,93,101,.18) 50%,transparent 50.5%);}
.sully-journal-theme-letterpress .sully-journal-airmail-stripe{position:absolute;inset:12px;border:7px solid transparent;border-image:repeating-linear-gradient(135deg,var(--postal-red) 0 10px,var(--postal-paper) 10px 17px,var(--postal-blue) 17px 27px,var(--postal-paper) 27px 34px) 8;opacity:.32;}
.sully-journal-theme-letterpress .sully-journal-header{position:relative;z-index:10;background:rgba(244,231,203,.86)!important;border-color:rgba(53,42,36,.18)!important;color:var(--postal-ink)!important;}
.sully-journal-theme-letterpress .sully-journal-header-title{font-size:13px!important;text-transform:uppercase;letter-spacing:.18em!important;color:var(--postal-ink)!important;}
.sully-journal-theme-letterpress .sully-journal-back{color:var(--postal-ink)!important;opacity:1!important;}
.sully-journal-theme-letterpress .sully-journal-group-filter,.sully-journal-theme-letterpress .sully-journal-notebook-grid{position:relative;z-index:2;}
.sully-journal-theme-letterpress .sully-journal-notebook-grid{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))!important;gap:18px!important;padding:28px 7% 90px!important;align-content:start!important;}
.sully-journal-theme-letterpress .sully-journal-notebook{aspect-ratio:auto!important;min-height:164px!important;display:grid!important;grid-template-columns:82px 1fr!important;grid-template-rows:1fr auto!important;justify-items:start!important;align-items:center!important;padding:24px 26px!important;gap:4px 18px!important;background:var(--postal-paper)!important;border:1px solid rgba(53,42,36,.32)!important;border-radius:3px!important;border-left:1px solid rgba(53,42,36,.32)!important;box-shadow:5px 7px 0 rgba(53,42,36,.1),0 18px 35px rgba(53,42,36,.12)!important;transform:rotate(-.5deg);overflow:visible!important;}
.sully-journal-theme-letterpress .sully-journal-notebook:nth-child(even){transform:rotate(.65deg) translateY(6px)}
.sully-journal-theme-letterpress .sully-journal-notebook::before{content:"";position:absolute;inset:0;background:linear-gradient(31deg,transparent 49.6%,rgba(163,78,61,.15) 50%,transparent 50.4%);clip-path:polygon(0 0,100% 0,100% 56%,50% 100%,0 56%);pointer-events:none;}
.sully-journal-theme-letterpress .sully-journal-notebook::after{content:"AIR MAIL / PRIVATE";position:absolute;right:16px;top:13px;font:700 7px/1 ui-monospace,monospace;letter-spacing:.13em;color:var(--postal-red);}
.sully-journal-theme-letterpress .sully-journal-notebook-avatar{grid-row:1/3;width:74px!important;height:74px!important;border:3px double var(--postal-red)!important;border-radius:50%!important;padding:6px!important;background:transparent!important;filter:sepia(.18);}
.sully-journal-theme-letterpress .sully-journal-notebook-name{align-self:end;padding:0!important;background:none!important;color:var(--postal-ink)!important;font-size:16px!important;letter-spacing:.05em;}
.sully-journal-theme-letterpress .sully-journal-notebook-label{align-self:start;border-radius:0!important;background:var(--postal-blue)!important;color:var(--postal-paper)!important;font-size:8px!important;letter-spacing:.16em!important;}
.sully-journal-theme-letterpress .sully-journal-calendar-hero{position:relative;z-index:2;border-radius:0!important;background:var(--postal-blue)!important;background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.05) 0 8px,transparent 8px 16px)!important;box-shadow:inset 0 -8px 0 var(--postal-red),inset 0 -13px 0 var(--postal-paper)!important;}
.sully-journal-theme-letterpress .sully-journal-calendar-hero .sully-journal-back{color:var(--postal-paper)!important;}
.sully-journal-theme-letterpress .sully-journal-calendar-kicker{display:inline-block;border:1px solid rgba(244,231,203,.5);padding:3px 7px;}
.sully-journal-theme-letterpress .sully-journal-calendar-title{font-family:"Songti SC",serif!important;letter-spacing:.07em;}
.sully-journal-theme-letterpress .sully-journal-calendar-list{position:relative;z-index:2;background:transparent!important;padding:34px 7% 90px!important;}
.sully-journal-theme-letterpress .sully-journal-new-entry{max-width:760px;margin-inline:auto!important;border:2px dashed var(--postal-red)!important;border-radius:2px!important;background:rgba(244,231,203,.92)!important;color:var(--postal-red)!important;box-shadow:4px 5px 0 rgba(53,42,36,.1)!important;}
.sully-journal-theme-letterpress .sully-journal-calendar-list>div{max-width:760px;margin-inline:auto;}
.sully-journal-theme-letterpress .sully-journal-entry{border-radius:2px!important;border:1px solid rgba(53,42,36,.25)!important;background:var(--postal-paper)!important;box-shadow:3px 4px 0 rgba(53,42,36,.09)!important;transform:rotate(-.2deg);}
.sully-journal-theme-letterpress .sully-journal-entry:nth-child(even){transform:rotate(.25deg)}
.sully-journal-theme-letterpress .sully-journal-entry-accent{display:block!important;width:7px!important;background:repeating-linear-gradient(135deg,var(--postal-red) 0 5px,var(--postal-paper) 5px 9px,var(--postal-blue) 9px 14px)!important;}
.sully-journal-theme-letterpress .sully-journal-entry-date{border:2px double var(--postal-red)!important;border-radius:50%!important;background:transparent!important;color:var(--postal-red)!important;transform:rotate(-7deg);}
.sully-journal-theme-letterpress .sully-journal-entry-text{font-family:"Songti SC",serif;color:var(--postal-ink)!important}.sully-journal-theme-letterpress .sully-journal-entry-year{color:#806b59!important;}
.sully-journal-theme-letterpress .sully-journal-write{background:var(--postal-desk)!important;}
.sully-journal-theme-letterpress .sully-journal-editor-header,.sully-journal-theme-letterpress .sully-journal-bottom-controls{position:relative;z-index:20;background:rgba(54,43,37,.94)!important;border-color:rgba(244,231,203,.12)!important;}
.sully-journal-theme-letterpress .sully-journal-editor-header .sully-journal-back{color:var(--postal-paper)!important;}
.sully-journal-theme-letterpress .sully-journal-editor-stage{position:relative;z-index:2;background:transparent!important;}
.sully-journal-theme-letterpress .sully-journal-spread{height:100%;width:min(100%,940px);margin:auto;display:grid;grid-template-columns:1.02fr .98fr;gap:0;padding:22px 22px 28px;filter:drop-shadow(0 25px 34px rgba(0,0,0,.28));}
.sully-journal-theme-letterpress .sully-journal-spread-page{min-width:0;height:100%;}.sully-journal-theme-letterpress .sully-journal-spread-user{transform:rotate(-.55deg) translateX(4px)}.sully-journal-theme-letterpress .sully-journal-spread-char{transform:rotate(.7deg) translateX(-4px) translateY(8px)}
.sully-journal-theme-letterpress .sully-journal-paper{height:100%;border-radius:2px!important;border:1px solid #b7a585!important;background-color:var(--postal-paper)!important;box-shadow:inset 0 0 45px rgba(91,68,45,.08)!important;}
.sully-journal-theme-letterpress .sully-journal-paper::before{content:"";position:absolute;inset:12px;border:1px solid rgba(163,78,61,.2);pointer-events:none;}
.sully-journal-theme-letterpress .sully-journal-page-content{padding:34px 35px!important}.sully-journal-theme-letterpress .sully-journal-page-meta{border-color:rgba(53,93,101,.3)!important}.sully-journal-theme-letterpress .sully-journal-page-title{font:700 10px/1 ui-monospace,monospace!important;letter-spacing:.15em!important;color:var(--postal-red)!important}.sully-journal-theme-letterpress .sully-journal-textarea{font-family:"Songti SC",serif!important;color:var(--postal-ink)!important;line-height:2!important;}
.sully-journal-theme-letterpress .sully-journal-tab-active,.sully-journal-theme-letterpress .sully-journal-sticker-button{background:var(--postal-red)!important;color:white!important;}.sully-journal-theme-letterpress .sully-journal-paper-picker{background:#2e2521!important;}
@media(max-width:719px){.sully-journal-theme-letterpress .sully-journal-notebook-grid{grid-template-columns:1fr!important;padding-inline:18px!important}.sully-journal-theme-letterpress .sully-journal-spread{display:block;padding:12px 10px 20px}.sully-journal-theme-letterpress .sully-journal-spread-page.is-inactive{display:none}.sully-journal-theme-letterpress .sully-journal-spread-user,.sully-journal-theme-letterpress .sully-journal-spread-char{transform:rotate(-.25deg)}.sully-journal-theme-letterpress .sully-journal-page-content{padding:28px 24px!important}}
`;

/* 星夜角色相册：深蓝硬壳、金属装订、巨幅拍立得与星盘。 */
const SAKURA_CSS = `.sully-journal-theme-sakura{
  --album-night:#11172b;--album-blue:#27345d;--album-violet:#5965cb;--album-gold:#d7b46d;--album-paper:#f5f0e6;
  background:radial-gradient(circle at 60% 20%,#29345d 0,#151b33 45%,#0c1020 100%)!important;color:var(--album-paper)!important;font-family:"Songti SC",serif!important;
}
.sully-journal-theme-sakura .sully-journal-theme-art{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none;color:var(--album-gold);}
.sully-journal-theme-sakura .sully-journal-celestial-map{position:absolute;inset:0;width:100%;height:100%;opacity:.31;fill:none;stroke:currentColor;stroke-width:1.5;}.sully-journal-theme-sakura .sully-journal-orbits{stroke-dasharray:4 8}.sully-journal-theme-sakura .sully-journal-constellation path{stroke:#9fa9ff}.sully-journal-theme-sakura .sully-journal-constellation circle{fill:#fff;stroke:#9fa9ff;}
.sully-journal-theme-sakura .sully-journal-star-medallion{position:absolute;left:5%;bottom:12%;width:94px;height:94px;border:1px solid currentColor;transform:rotate(18deg);display:grid;place-items:center;filter:drop-shadow(0 0 10px rgba(215,180,109,.3));}.sully-journal-theme-sakura .sully-journal-star-medallion::before,.sully-journal-theme-sakura .sully-journal-star-medallion::after{content:"";position:absolute;inset:12px;border:1px solid currentColor;transform:rotate(45deg)}.sully-journal-theme-sakura .sully-journal-star-medallion b{font-size:26px}.sully-journal-theme-sakura .sully-journal-star-medallion i{position:absolute;width:130px;height:1px;background:currentColor}.sully-journal-theme-sakura .sully-journal-star-medallion span{position:absolute;width:1px;height:130px;background:currentColor}
.sully-journal-theme-sakura .sully-journal-photo-corners{position:absolute;right:5%;top:20%;width:230px;height:270px;border:1px solid rgba(215,180,109,.35)}.sully-journal-theme-sakura .sully-journal-photo-corners i{position:absolute;width:35px;height:35px;border-color:currentColor}.sully-journal-theme-sakura .sully-journal-photo-corners i:nth-child(1){left:-6px;top:-6px;border-left:4px solid;border-top:4px solid}.sully-journal-theme-sakura .sully-journal-photo-corners i:nth-child(2){right:-6px;top:-6px;border-right:4px solid;border-top:4px solid}.sully-journal-theme-sakura .sully-journal-photo-corners i:nth-child(3){left:-6px;bottom:-6px;border-left:4px solid;border-bottom:4px solid}.sully-journal-theme-sakura .sully-journal-photo-corners i:nth-child(4){right:-6px;bottom:-6px;border-right:4px solid;border-bottom:4px solid}
.sully-journal-theme-sakura .sully-journal-satin-ribbon{position:absolute;right:-42px;top:42%;padding:7px 58px;background:#4d4caf;color:#eee7d9;font:700 8px/1 ui-monospace,monospace;letter-spacing:.15em;transform:rotate(90deg);}
.sully-journal-theme-sakura .sully-journal-header{position:relative;z-index:10;background:rgba(13,17,34,.74)!important;border-color:rgba(215,180,109,.25)!important;color:var(--album-paper)!important}.sully-journal-theme-sakura .sully-journal-header-title{color:var(--album-paper)!important;font-family:ui-serif,serif;letter-spacing:.16em!important}.sully-journal-theme-sakura .sully-journal-back{color:var(--album-paper)!important;opacity:1!important}.sully-journal-theme-sakura .sully-journal-appearance-button{border-color:rgba(215,180,109,.35)!important;color:var(--album-gold)!important;background:rgba(215,180,109,.08)!important}
.sully-journal-theme-sakura .sully-journal-group-filter,.sully-journal-theme-sakura .sully-journal-notebook-grid{position:relative;z-index:2}.sully-journal-theme-sakura .sully-journal-notebook-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;grid-auto-rows:minmax(235px,auto);gap:28px!important;padding:28px 7% 96px!important;align-content:start!important}.sully-journal-theme-sakura .sully-journal-notebook:first-child{grid-column:1/-1;min-height:290px;}
.sully-journal-theme-sakura .sully-journal-notebook{isolation:isolate;aspect-ratio:auto!important;background:linear-gradient(145deg,#354577,#202b50)!important;border:1px solid var(--album-gold)!important;border-radius:4px!important;padding:28px 22px 22px!important;box-shadow:0 22px 55px rgba(0,0,0,.42),inset 0 0 0 7px #151c35,inset 0 0 0 8px rgba(215,180,109,.45)!important;overflow:visible!important;transform:rotate(-1deg)}.sully-journal-theme-sakura .sully-journal-notebook:nth-child(even){transform:translateY(10px) rotate(1.2deg)}
.sully-journal-theme-sakura .sully-journal-notebook::before{content:"";position:absolute;z-index:-1;inset:16px 14px 45px;background:linear-gradient(135deg,rgba(117,135,217,.4),rgba(18,25,51,.8));border:1px solid rgba(215,180,109,.34);clip-path:polygon(0 0,100% 4%,96% 100%,3% 95%)}.sully-journal-theme-sakura .sully-journal-notebook::after{content:"✦  CELESTIAL MEMORY  ✦";position:absolute;left:22px;bottom:17px;color:var(--album-gold);font:700 7px/1 ui-monospace,monospace;letter-spacing:.2em}
.sully-journal-theme-sakura .sully-journal-notebook-avatar{width:min(72%,210px)!important;height:min(64%,190px)!important;border-radius:2px!important;border:9px solid var(--album-paper)!important;border-bottom-width:27px!important;background:var(--album-paper)!important;box-shadow:0 12px 28px rgba(0,0,0,.42)!important;transform:rotate(2.3deg);}.sully-journal-theme-sakura .sully-journal-notebook-avatar img{border-radius:0!important}.sully-journal-theme-sakura .sully-journal-notebook-name{z-index:2;margin-top:-9px;padding:6px 14px!important;background:#171d37!important;color:var(--album-paper)!important;border:1px solid rgba(215,180,109,.5);font-size:15px!important;transform:rotate(-1.5deg)}.sully-journal-theme-sakura .sully-journal-notebook-label{z-index:2;background:var(--album-violet)!important;color:white!important;border-radius:0!important;letter-spacing:.18em!important}
.sully-journal-theme-sakura .sully-journal-calendar-hero{position:relative;z-index:2;min-height:220px;border-radius:0 0 48% 0!important;background:linear-gradient(142deg,#344779,#171f40)!important;border-bottom:2px solid var(--album-gold);box-shadow:0 20px 50px rgba(0,0,0,.34)!important;overflow:hidden}.sully-journal-theme-sakura .sully-journal-calendar-hero::after{content:"✦";position:absolute;right:9%;bottom:-25px;font-size:130px;color:rgba(215,180,109,.16);transform:rotate(15deg)}.sully-journal-theme-sakura .sully-journal-calendar-heading{position:relative;z-index:1}.sully-journal-theme-sakura .sully-journal-calendar-kicker{color:var(--album-gold);opacity:1!important}.sully-journal-theme-sakura .sully-journal-calendar-title{font-size:40px!important}.sully-journal-theme-sakura .sully-journal-calendar-list{position:relative;z-index:2;background:transparent!important;padding:36px 6% 90px!important}.sully-journal-theme-sakura .sully-journal-new-entry{border:1px solid var(--album-gold)!important;border-radius:0!important;background:rgba(39,52,93,.82)!important;color:var(--album-paper)!important;box-shadow:8px 8px 0 rgba(89,101,203,.28)!important}.sully-journal-theme-sakura .sully-journal-calendar-list>div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px!important}.sully-journal-theme-sakura .sully-journal-entry{min-height:145px;align-items:flex-end!important;border-radius:2px!important;border:9px solid var(--album-paper)!important;border-bottom-width:24px!important;background:linear-gradient(135deg,#6f78bd,#252e58)!important;box-shadow:0 17px 35px rgba(0,0,0,.34)!important;transform:rotate(-1deg)}.sully-journal-theme-sakura .sully-journal-entry:nth-child(even){transform:rotate(1.2deg) translateY(8px)}.sully-journal-theme-sakura .sully-journal-entry-date{position:absolute;right:7px;top:7px;border:1px solid var(--album-gold)!important;border-radius:50%!important;background:#17203f!important;color:var(--album-gold)!important;transform:rotate(7deg)}.sully-journal-theme-sakura .sully-journal-entry-text{color:white!important;text-shadow:0 1px 3px rgba(0,0,0,.5)}.sully-journal-theme-sakura .sully-journal-entry-year{color:#d7ddff!important}.sully-journal-theme-sakura .sully-journal-entry-badges{display:none!important}
.sully-journal-theme-sakura .sully-journal-write{background:#0c1020!important}.sully-journal-theme-sakura .sully-journal-editor-header,.sully-journal-theme-sakura .sully-journal-bottom-controls{position:relative;z-index:20;background:rgba(11,15,31,.95)!important;border-color:rgba(215,180,109,.2)!important}.sully-journal-theme-sakura .sully-journal-editor-stage{position:relative;z-index:2;background:transparent!important}.sully-journal-theme-sakura .sully-journal-spread{position:relative;width:min(100%,1020px);height:100%;margin:auto;padding:25px 34px 34px;display:grid;grid-template-columns:1fr 1fr;gap:28px;background:#161c34;border:2px solid var(--album-gold);box-shadow:0 28px 65px rgba(0,0,0,.48),inset 0 0 0 8px #26345d}.sully-journal-theme-sakura .sully-journal-spread::before{content:"";position:absolute;z-index:6;left:50%;top:32px;bottom:35px;width:24px;transform:translateX(-50%);background:repeating-radial-gradient(ellipse,var(--album-gold) 0 3px,#51452f 4px 5px,transparent 6px 28px);filter:drop-shadow(2px 3px 2px #000);pointer-events:none}.sully-journal-theme-sakura .sully-journal-spread-page{min-width:0;height:100%}.sully-journal-theme-sakura .sully-journal-paper{height:100%;border:0!important;border-radius:2px!important;background-color:var(--album-paper)!important;box-shadow:0 14px 35px rgba(0,0,0,.3)!important}.sully-journal-theme-sakura .sully-journal-paper-user{transform:rotate(-.45deg)}.sully-journal-theme-sakura .sully-journal-paper-char{transform:rotate(.65deg)}.sully-journal-theme-sakura .sully-journal-page-content{padding:34px 33px!important}.sully-journal-theme-sakura .sully-journal-page-title{display:inline-block;background:#202a51!important;color:var(--album-paper)!important;padding:5px 9px;letter-spacing:.17em!important}.sully-journal-theme-sakura .sully-journal-page-date{color:#6e664f!important}.sully-journal-theme-sakura .sully-journal-textarea{color:#303247!important;font-family:"Kaiti SC","STKaiti",serif!important;line-height:2!important}.sully-journal-theme-sakura .sully-journal-tab{border:1px solid rgba(215,180,109,.22)}.sully-journal-theme-sakura .sully-journal-tab-active,.sully-journal-theme-sakura .sully-journal-sticker-button{background:linear-gradient(135deg,#6a66df,#4148ae)!important;color:white!important}.sully-journal-theme-sakura .sully-journal-paper-picker{background:#090d1b!important}
@media(max-width:719px){.sully-journal-theme-sakura .sully-journal-notebook-grid{grid-template-columns:1fr 1fr!important;padding:20px 16px 90px!important;gap:15px!important}.sully-journal-theme-sakura .sully-journal-notebook:first-child{grid-column:1/-1;min-height:245px}.sully-journal-theme-sakura .sully-journal-notebook{min-height:210px;padding-inline:12px!important}.sully-journal-theme-sakura .sully-journal-notebook-avatar{width:88%!important}.sully-journal-theme-sakura .sully-journal-calendar-list>div{grid-template-columns:1fr}.sully-journal-theme-sakura .sully-journal-calendar-hero{min-height:190px}.sully-journal-theme-sakura .sully-journal-spread{display:block;padding:12px 10px 20px;border-width:1px}.sully-journal-theme-sakura .sully-journal-spread::before{display:none}.sully-journal-theme-sakura .sully-journal-spread-page.is-inactive{display:none}.sully-journal-theme-sakura .sully-journal-paper-user,.sully-journal-theme-sakura .sully-journal-paper-char{transform:rotate(-.2deg)}.sully-journal-theme-sakura .sully-journal-page-content{padding:27px 24px!important}}
`;

/* 野外观察手册：皮革框、活页环、索引耳与标本图。 */
const FOREST_CSS = `.sully-journal-theme-forest{
  --field-leather:#7b482e;--field-orange:#b85f3d;--field-paper:#f0d3a2;--field-green:#687849;--field-ink:#5a3525;
  background:#ca8c58!important;color:var(--field-ink)!important;font-family:"Kaiti SC","STKaiti",serif!important;box-shadow:inset 0 0 0 9px #73452e,inset 0 0 0 12px #dda66f!important;
  background-image:radial-gradient(circle at 9px 9px,rgba(90,53,37,.14) 0 1px,transparent 1.5px)!important;background-size:18px 18px!important;
}
.sully-journal-theme-forest .sully-journal-theme-art{position:absolute;inset:0;z-index:4;overflow:hidden;pointer-events:none;color:var(--field-green)}.sully-journal-theme-forest .sully-journal-botanical-sheet{position:absolute;inset:0;width:100%;height:100%;fill:rgba(104,120,73,.12);stroke:currentColor;stroke-width:2;opacity:.35}.sully-journal-theme-forest .sully-journal-botanical-stem{fill:none;stroke-width:4}.sully-journal-theme-forest .sully-journal-measure-lines,.sully-journal-theme-forest .sully-journal-specimen-arrow{fill:none;stroke:var(--field-orange);stroke-dasharray:4 5}
.sully-journal-theme-forest .sully-journal-field-rings{position:absolute;left:50%;top:17%;bottom:10%;transform:translateX(-50%);display:flex;flex-direction:column;justify-content:space-around}.sully-journal-theme-forest .sully-journal-field-rings i{width:42px;height:13px;border:4px solid #604536;border-radius:50%;background:transparent;box-shadow:0 2px 0 rgba(255,255,255,.25)}.sully-journal-theme-forest .sully-journal-field-tabs{position:absolute;right:0;top:25%;display:grid;gap:8px}.sully-journal-theme-forest .sully-journal-field-tabs i{width:34px;height:27px;display:grid;place-items:center;background:var(--field-orange);color:var(--field-paper);border-radius:7px 0 0 7px;font:700 8px/1 ui-monospace,monospace}.sully-journal-theme-forest .sully-journal-field-tabs i:nth-child(2){background:#d18d38}.sully-journal-theme-forest .sully-journal-field-tabs i:nth-child(3){background:var(--field-green)}.sully-journal-theme-forest .sully-journal-field-tabs i:nth-child(4){background:#5f7e89}.sully-journal-theme-forest .sully-journal-specimen-seal{position:absolute;right:7%;bottom:9%;width:88px;height:88px;border:3px double var(--field-orange);border-radius:50%;display:grid;place-content:center;text-align:center;transform:rotate(-12deg);opacity:.44}.sully-journal-theme-forest .sully-journal-specimen-seal b{font:800 12px/1 ui-monospace}.sully-journal-theme-forest .sully-journal-specimen-seal span{font:700 7px/1.5 ui-monospace}
.sully-journal-theme-forest .sully-journal-header{position:relative;z-index:10;margin:10px 10px 0;background:var(--field-paper)!important;border:2px solid var(--field-leather)!important;color:var(--field-ink)!important;border-radius:10px 10px 0 0}.sully-journal-theme-forest .sully-journal-header-title{color:var(--field-ink)!important;font-size:15px!important;letter-spacing:.12em!important}.sully-journal-theme-forest .sully-journal-back{color:var(--field-ink)!important;opacity:1!important}.sully-journal-theme-forest .sully-journal-group-filter{position:relative;z-index:6;margin-inline:10px;background:var(--field-paper)}.sully-journal-theme-forest .sully-journal-notebook-grid{position:relative;z-index:5;grid-template-columns:1fr!important;gap:14px!important;padding:24px 8% 96px!important;align-content:start!important;background:rgba(240,211,162,.94)!important;margin:0 10px 10px;border:2px solid var(--field-leather);border-top:0;}
.sully-journal-theme-forest .sully-journal-notebook{aspect-ratio:auto!important;min-height:128px!important;display:grid!important;grid-template-columns:92px 1fr auto!important;grid-template-rows:1fr 1fr!important;justify-items:start!important;align-items:center!important;gap:0 20px!important;padding:18px 28px 18px 20px!important;background:#e8c58d!important;border:1px solid rgba(90,53,37,.35)!important;border-left:7px solid var(--field-green)!important;border-radius:4px 12px 12px 4px!important;box-shadow:3px 4px 0 rgba(90,53,37,.16)!important;overflow:visible!important}.sully-journal-theme-forest .sully-journal-notebook:nth-child(even){border-left-color:var(--field-orange)!important;background:#efd09d!important}.sully-journal-theme-forest .sully-journal-notebook::before{content:"SPECIMEN RECORD";position:absolute;top:11px;right:16px;color:rgba(90,53,37,.42);font:700 7px/1 ui-monospace;letter-spacing:.14em}.sully-journal-theme-forest .sully-journal-notebook::after{content:"";position:absolute;right:-18px;top:35px;width:18px;height:48px;border-radius:0 7px 7px 0;background:var(--field-green)}.sully-journal-theme-forest .sully-journal-notebook:nth-child(even)::after{background:var(--field-orange)}.sully-journal-theme-forest .sully-journal-notebook-avatar{grid-row:1/3;width:84px!important;height:84px!important;border-radius:50% 48% 45% 52%!important;border:1px dashed var(--field-leather)!important;padding:7px!important;background:#f5ddaf!important}.sully-journal-theme-forest .sully-journal-notebook-avatar img{border-radius:48% 52% 46% 54%!important}.sully-journal-theme-forest .sully-journal-notebook-name{align-self:end;color:var(--field-ink)!important;font-size:18px!important}.sully-journal-theme-forest .sully-journal-notebook-label{align-self:start;border-radius:2px!important;background:var(--field-orange)!important;color:var(--field-paper)!important;letter-spacing:.15em!important}.sully-journal-theme-forest .sully-journal-calendar-hero{position:relative;z-index:5;margin:10px 10px 0;border:2px solid var(--field-leather);border-bottom:0;border-radius:10px 10px 0 0!important;background:var(--field-paper)!important;color:var(--field-ink)!important;box-shadow:none!important}.sully-journal-theme-forest .sully-journal-calendar-hero::before{content:"FIELD OBSERVATION / 0822";position:absolute;right:24px;top:54px;color:var(--field-orange);font:700 8px/1 ui-monospace;letter-spacing:.15em}.sully-journal-theme-forest .sully-journal-calendar-hero .sully-journal-back{color:var(--field-ink)!important}.sully-journal-theme-forest .sully-journal-calendar-heading{color:var(--field-ink)!important}.sully-journal-theme-forest .sully-journal-calendar-kicker{color:var(--field-orange);opacity:1!important}.sully-journal-theme-forest .sully-journal-calendar-title{font-size:34px!important}.sully-journal-theme-forest .sully-journal-calendar-list{position:relative;z-index:5;margin:0 10px 10px;padding:26px 8% 90px!important;border:2px solid var(--field-leather);border-top:1px dashed rgba(90,53,37,.3);background-color:var(--field-paper)!important;background-image:linear-gradient(rgba(90,53,37,.09) 1px,transparent 1px),linear-gradient(90deg,rgba(90,53,37,.09) 1px,transparent 1px)!important;background-size:24px 24px!important}.sully-journal-theme-forest .sully-journal-new-entry{border:2px solid var(--field-orange)!important;border-radius:3px!important;background:#f4d8a9!important;color:var(--field-orange)!important;box-shadow:4px 4px 0 rgba(90,53,37,.16)!important}.sully-journal-theme-forest .sully-journal-entry{border:1px solid rgba(90,53,37,.34)!important;border-radius:2px!important;background:#efd09d!important;box-shadow:3px 3px 0 rgba(90,53,37,.13)!important}.sully-journal-theme-forest .sully-journal-entry-accent{display:block!important;width:6px!important;background:var(--field-green)!important}.sully-journal-theme-forest .sully-journal-entry-date{border-radius:2px!important;border:1px solid var(--field-orange)!important;background:transparent!important;color:var(--field-orange)!important}.sully-journal-theme-forest .sully-journal-entry-text{color:var(--field-ink)!important;font-family:"Kaiti SC","STKaiti",serif!important}.sully-journal-theme-forest .sully-journal-entry-year{color:#8d654b!important}.sully-journal-theme-forest .sully-journal-entry-badges span{border-radius:2px!important;background:rgba(104,120,73,.14)!important;color:var(--field-green)!important}
.sully-journal-theme-forest .sully-journal-write{background:var(--field-leather)!important;box-shadow:inset 0 0 0 9px #5f3625!important}.sully-journal-theme-forest .sully-journal-editor-header,.sully-journal-theme-forest .sully-journal-bottom-controls{position:relative;z-index:20;background:#613923!important;border-color:#a97450!important}.sully-journal-theme-forest .sully-journal-editor-header .sully-journal-back{color:var(--field-paper)!important}.sully-journal-theme-forest .sully-journal-editor-stage{position:relative;z-index:2;background:transparent!important}.sully-journal-theme-forest .sully-journal-spread{position:relative;width:min(100%,1010px);height:100%;margin:auto;padding:20px 28px 28px;display:grid;grid-template-columns:1fr 1fr;gap:18px;background:#c88955;border:2px solid #4f2c1e;box-shadow:0 24px 50px rgba(0,0,0,.35),inset 0 0 0 8px #8b5033}.sully-journal-theme-forest .sully-journal-spread::before{content:"";position:absolute;z-index:7;left:50%;top:25px;bottom:30px;width:46px;transform:translateX(-50%);background:repeating-radial-gradient(ellipse at center,transparent 0 4px,#5a4031 5px 8px,transparent 9px 58px);filter:drop-shadow(2px 2px 1px rgba(0,0,0,.4));pointer-events:none}.sully-journal-theme-forest .sully-journal-spread-page{min-width:0;height:100%}.sully-journal-theme-forest .sully-journal-paper{height:100%;border:1px solid #a77d50!important;border-radius:2px!important;background-color:var(--field-paper)!important;box-shadow:inset 0 0 36px rgba(104,120,73,.08),0 10px 25px rgba(0,0,0,.2)!important}.sully-journal-theme-forest .sully-journal-paper-user{transform:rotate(-.3deg)}.sully-journal-theme-forest .sully-journal-paper-char{transform:rotate(.35deg)}.sully-journal-theme-forest .sully-journal-paper::before{content:"";position:absolute;right:13px;bottom:12px;width:45px;height:72px;border-right:2px solid rgba(104,120,73,.24);border-radius:70% 0;transform:rotate(27deg);pointer-events:none}.sully-journal-theme-forest .sully-journal-page-content{padding:31px 32px!important}.sully-journal-theme-forest .sully-journal-page-title{display:inline-block;padding:4px 8px;background:var(--field-green)!important;color:var(--field-paper)!important;letter-spacing:.13em!important}.sully-journal-theme-forest .sully-journal-page-date{color:#8b5d3e!important}.sully-journal-theme-forest .sully-journal-textarea{color:var(--field-ink)!important;font-family:"Kaiti SC","STKaiti",serif!important;line-height:2!important}.sully-journal-theme-forest .sully-journal-tab{border-radius:3px!important}.sully-journal-theme-forest .sully-journal-tab-active,.sully-journal-theme-forest .sully-journal-sticker-button{background:var(--field-green)!important;color:var(--field-paper)!important}.sully-journal-theme-forest .sully-journal-paper-picker{border-radius:4px!important;background:#48291e!important}
@media(max-width:719px){.sully-journal-theme-forest{box-shadow:inset 0 0 0 5px #73452e!important}.sully-journal-theme-forest .sully-journal-header,.sully-journal-theme-forest .sully-journal-notebook-grid,.sully-journal-theme-forest .sully-journal-calendar-hero,.sully-journal-theme-forest .sully-journal-calendar-list{margin-inline:6px}.sully-journal-theme-forest .sully-journal-notebook-grid{padding:18px 16px 90px!important}.sully-journal-theme-forest .sully-journal-notebook{grid-template-columns:76px 1fr auto!important;padding-inline:14px!important;gap-x:12px!important}.sully-journal-theme-forest .sully-journal-notebook-avatar{width:68px!important;height:68px!important}.sully-journal-theme-forest .sully-journal-field-rings{display:none}.sully-journal-theme-forest .sully-journal-spread{display:block;padding:12px 10px 20px}.sully-journal-theme-forest .sully-journal-spread::before{display:none}.sully-journal-theme-forest .sully-journal-spread-page.is-inactive{display:none}.sully-journal-theme-forest .sully-journal-paper-user,.sully-journal-theme-forest .sully-journal-paper-char{transform:rotate(-.15deg)}.sully-journal-theme-forest .sully-journal-page-content{padding:27px 24px!important}}
`;

/* 午夜记忆编辑器：不是纸本，整套界面变成复古蓝紫桌面程序。 */
const MIDNIGHT_CSS = `.sully-journal-theme-midnight{
  --memory-blue:#718bd4;--memory-line:#a8b9ea;--memory-paper:#fbfcff;--memory-bg:#e3e9fb;--memory-ink:#405487;
  background:var(--memory-bg)!important;color:var(--memory-ink)!important;font-family:ui-monospace,"SFMono-Regular","Microsoft YaHei",sans-serif!important;
  background-image:linear-gradient(rgba(113,139,212,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(113,139,212,.12) 1px,transparent 1px)!important;background-size:22px 22px!important;
}
.sully-journal-theme-midnight .sully-journal-theme-art{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none;color:var(--memory-blue)}.sully-journal-theme-midnight .sully-journal-memory-circuit{position:absolute;inset:0;width:100%;height:100%;fill:var(--memory-paper);stroke:currentColor;stroke-width:2;opacity:.34}.sully-journal-theme-midnight .sully-journal-window-chrome{position:absolute;inset:16px;border:2px solid currentColor;box-shadow:5px 5px 0 rgba(113,139,212,.2)}.sully-journal-theme-midnight .sully-journal-window-chrome::before{content:"";position:absolute;left:0;right:0;top:0;height:25px;background:rgba(113,139,212,.16);border-bottom:2px solid currentColor}.sully-journal-theme-midnight .sully-journal-window-chrome i{position:relative;z-index:1;display:inline-block;width:8px;height:8px;margin:8px 0 0 8px;border:1px solid currentColor;border-radius:50%;background:var(--memory-paper)}.sully-journal-theme-midnight .sully-journal-window-chrome span{position:absolute;z-index:1;left:50%;top:7px;transform:translateX(-50%);font:700 8px/1 ui-monospace;letter-spacing:.12em}.sully-journal-theme-midnight .sully-journal-inspector-ghost{position:absolute;right:26px;top:24%;width:190px;height:245px;border:2px solid currentColor;background:rgba(251,252,255,.38);padding:15px;display:grid;align-content:start;gap:12px}.sully-journal-theme-midnight .sully-journal-inspector-ghost b{font-size:8px;letter-spacing:.16em}.sully-journal-theme-midnight .sully-journal-inspector-ghost i{height:24px;border:1px solid currentColor;background:rgba(113,139,212,.08)}.sully-journal-theme-midnight .sully-journal-inspector-ghost span{font-size:7px;text-align:right}.sully-journal-theme-midnight .sully-journal-cursor-spark{position:absolute;left:12%;bottom:17%;font-size:46px;color:white;text-shadow:0 0 0 var(--memory-blue),0 0 18px #7796f5;transform:rotate(17deg)}
.sully-journal-theme-midnight .sully-journal-header{position:relative;z-index:10;margin:16px 16px 0;background:var(--memory-blue)!important;border:2px solid var(--memory-blue)!important;color:white!important}.sully-journal-theme-midnight .sully-journal-header::after{content:"SELECT A MEMORY FILE";position:absolute;left:52px;bottom:-24px;font:700 8px/1 ui-monospace;letter-spacing:.14em;color:var(--memory-blue)}.sully-journal-theme-midnight .sully-journal-header-title{color:white!important;font-size:13px!important;letter-spacing:.18em!important}.sully-journal-theme-midnight .sully-journal-back{color:white!important;opacity:1!important}.sully-journal-theme-midnight .sully-journal-group-filter{position:relative;z-index:5;margin:24px 16px 0}.sully-journal-theme-midnight .sully-journal-notebook-grid{position:relative;z-index:3;grid-template-columns:repeat(3,minmax(0,1fr))!important;gap:14px!important;padding:22px 5% 90px!important;align-content:start!important}.sully-journal-theme-midnight .sully-journal-notebook{aspect-ratio:1.1!important;min-height:150px;background:rgba(251,252,255,.92)!important;border:2px solid var(--memory-blue)!important;border-radius:0!important;padding:26px 12px 14px!important;box-shadow:4px 4px 0 rgba(113,139,212,.22)!important;overflow:visible!important}.sully-journal-theme-midnight .sully-journal-notebook::before{content:"FILE";position:absolute;left:-2px;right:-2px;top:-2px;height:23px;padding:6px 8px;background:var(--memory-blue);color:white;font:700 8px/1 ui-monospace;letter-spacing:.16em;text-align:left}.sully-journal-theme-midnight .sully-journal-notebook::after{content:"↗";position:absolute;right:6px;top:4px;color:white;font-size:12px}.sully-journal-theme-midnight .sully-journal-notebook-avatar{width:70px!important;height:70px!important;border:2px solid var(--memory-line)!important;border-radius:0!important;padding:4px!important;background:#edf1ff!important}.sully-journal-theme-midnight .sully-journal-notebook-avatar img{border-radius:0!important;filter:saturate(.78) contrast(.94)}.sully-journal-theme-midnight .sully-journal-notebook-name{color:var(--memory-ink)!important;font-size:12px!important;text-transform:uppercase}.sully-journal-theme-midnight .sully-journal-notebook-label{border-radius:0!important;background:#dce5ff!important;border:1px solid var(--memory-line);color:var(--memory-ink)!important;letter-spacing:.15em!important}
.sully-journal-theme-midnight .sully-journal-calendar-hero{position:relative;z-index:5;margin:16px 16px 0;min-height:120px;border:2px solid var(--memory-blue);border-radius:0!important;background:var(--memory-paper)!important;color:var(--memory-ink)!important;box-shadow:5px 5px 0 rgba(113,139,212,.2)!important}.sully-journal-theme-midnight .sully-journal-calendar-hero::before{content:"MEMORY DIRECTORY";position:absolute;left:0;right:0;top:0;height:25px;padding:7px 15px;background:var(--memory-blue);color:white;font:700 8px/1 ui-monospace;letter-spacing:.14em}.sully-journal-theme-midnight .sully-journal-calendar-hero .sully-journal-back{color:var(--memory-blue)!important;margin-top:16px}.sully-journal-theme-midnight .sully-journal-calendar-heading{color:var(--memory-ink)!important;margin-top:4px}.sully-journal-theme-midnight .sully-journal-calendar-kicker{font-size:8px!important;color:var(--memory-blue);opacity:1!important}.sully-journal-theme-midnight .sully-journal-calendar-title{font-family:ui-monospace,monospace!important;font-size:26px!important;text-transform:uppercase}.sully-journal-theme-midnight .sully-journal-calendar-list{position:relative;z-index:4;margin:0 16px 16px;border:2px solid var(--memory-blue);border-top:0;background:rgba(251,252,255,.9)!important;padding:28px 5% 90px!important}.sully-journal-theme-midnight .sully-journal-new-entry{border:2px solid var(--memory-blue)!important;border-radius:0!important;background:#dbe5ff!important;color:var(--memory-ink)!important;box-shadow:4px 4px 0 rgba(113,139,212,.2)!important}.sully-journal-theme-midnight .sully-journal-calendar-list>div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px!important}.sully-journal-theme-midnight .sully-journal-entry{border:2px solid var(--memory-line)!important;border-radius:0!important;background:var(--memory-paper)!important;box-shadow:3px 3px 0 rgba(113,139,212,.14)!important}.sully-journal-theme-midnight .sully-journal-entry::before{content:"LOG";position:absolute;right:7px;top:5px;font:700 7px/1 ui-monospace;color:var(--memory-blue)}.sully-journal-theme-midnight .sully-journal-entry-accent{display:block!important;width:5px!important;background:var(--memory-blue)!important}.sully-journal-theme-midnight .sully-journal-entry-date{border:1px solid var(--memory-blue)!important;border-radius:0!important;background:#edf1ff!important;color:var(--memory-ink)!important}.sully-journal-theme-midnight .sully-journal-entry-text{color:var(--memory-ink)!important;font-family:ui-monospace,monospace!important}.sully-journal-theme-midnight .sully-journal-entry-year{color:#8094c9!important}.sully-journal-theme-midnight .sully-journal-entry-badges span{border-radius:0!important;background:#e0e7fa!important;color:var(--memory-ink)!important}
.sully-journal-theme-midnight .sully-journal-write{background:var(--memory-bg)!important}.sully-journal-theme-midnight .sully-journal-editor-header{position:relative;z-index:20;margin:16px 16px 0;border:2px solid var(--memory-blue);background:var(--memory-blue)!important;color:white!important}.sully-journal-theme-midnight .sully-journal-editor-header .sully-journal-back{color:white!important}.sully-journal-theme-midnight .sully-journal-editor-stage{position:relative;z-index:3;background:transparent!important;margin:0 248px 16px 16px;border:2px solid var(--memory-blue);border-top:0;background-color:rgba(251,252,255,.8)!important}.sully-journal-theme-midnight .sully-journal-spread{width:100%;height:100%;margin:0;padding:18px;display:grid;grid-template-columns:1fr 1fr;gap:14px}.sully-journal-theme-midnight .sully-journal-spread-page{min-width:0;height:100%}.sully-journal-theme-midnight .sully-journal-paper{height:100%;border:2px solid var(--memory-line)!important;border-radius:0!important;background-color:var(--memory-paper)!important;box-shadow:4px 4px 0 rgba(113,139,212,.16)!important}.sully-journal-theme-midnight .sully-journal-paper::before{content:"TEXT_LAYER";position:absolute;right:0;top:0;padding:5px 8px;background:#dbe4fc;color:var(--memory-blue);font:700 7px/1 ui-monospace;letter-spacing:.12em}.sully-journal-theme-midnight .sully-journal-page-content{padding:31px 27px!important}.sully-journal-theme-midnight .sully-journal-page-meta{border-bottom:1px dashed var(--memory-line)!important}.sully-journal-theme-midnight .sully-journal-page-title{color:var(--memory-blue)!important;font:800 9px/1 ui-monospace!important;letter-spacing:.14em!important}.sully-journal-theme-midnight .sully-journal-page-date{color:#8094c9!important}.sully-journal-theme-midnight .sully-journal-textarea{color:var(--memory-ink)!important;font-family:ui-monospace,"Microsoft YaHei",sans-serif!important;line-height:1.9!important}.sully-journal-theme-midnight .sully-journal-bottom-controls{position:absolute!important;z-index:20;right:16px;top:80px;bottom:16px;width:218px;padding:18px 14px!important;border:2px solid var(--memory-blue)!important;background:rgba(251,252,255,.96)!important;color:var(--memory-ink)!important;display:flex;flex-direction:column}.sully-journal-theme-midnight .sully-journal-tabs{display:grid!important;grid-template-columns:1fr!important;margin:0 0 20px!important;padding:0!important}.sully-journal-theme-midnight .sully-journal-tab{border:1px solid var(--memory-line)!important;border-radius:0!important;background:#edf2ff!important;color:var(--memory-ink)!important}.sully-journal-theme-midnight .sully-journal-tab-active{background:var(--memory-blue)!important;color:white!important}.sully-journal-theme-midnight .sully-journal-bottom-controls>div:nth-child(2){display:grid!important;gap:18px!important;padding:0!important}.sully-journal-theme-midnight .sully-journal-paper-picker{display:grid!important;grid-template-columns:repeat(4,1fr);gap:5px!important;border:1px solid var(--memory-line)!important;border-radius:0!important;background:#e5ebfb!important}.sully-journal-theme-midnight .sully-journal-paper-swatch{width:31px!important;height:31px!important;border-radius:0!important}.sully-journal-theme-midnight .sully-journal-sticker-button{border-radius:0!important;background:var(--memory-blue)!important;color:white!important}.sully-journal-theme-midnight .sully-journal-sticker-panel{position:absolute;right:218px;bottom:0;width:min(430px,calc(100vw - 250px));background:var(--memory-paper)!important;border:2px solid var(--memory-blue)!important;color:var(--memory-ink)!important}
@media(max-width:719px){.sully-journal-theme-midnight .sully-journal-header{margin:8px 8px 0}.sully-journal-theme-midnight .sully-journal-group-filter{margin-inline:8px}.sully-journal-theme-midnight .sully-journal-notebook-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important;padding:18px 12px 90px!important}.sully-journal-theme-midnight .sully-journal-calendar-hero{margin:8px 8px 0}.sully-journal-theme-midnight .sully-journal-calendar-list{margin:0 8px 8px;padding-inline:12px!important}.sully-journal-theme-midnight .sully-journal-calendar-list>div{grid-template-columns:1fr}.sully-journal-theme-midnight .sully-journal-editor-header{margin:0;border-inline:0}.sully-journal-theme-midnight .sully-journal-editor-stage{margin:0;border-inline:0}.sully-journal-theme-midnight .sully-journal-spread{display:block;padding:10px}.sully-journal-theme-midnight .sully-journal-spread-page.is-inactive{display:none}.sully-journal-theme-midnight .sully-journal-bottom-controls{position:relative!important;right:auto;top:auto;bottom:auto;width:auto;padding:8px 0 0!important;border:0!important;border-top:2px solid var(--memory-blue)!important;display:block}.sully-journal-theme-midnight .sully-journal-tabs{display:flex!important;margin:0 16px 12px!important}.sully-journal-theme-midnight .sully-journal-bottom-controls>div:nth-child(2){display:flex!important;padding:0 20px 12px!important}.sully-journal-theme-midnight .sully-journal-paper-picker{display:flex!important}.sully-journal-theme-midnight .sully-journal-sticker-panel{position:relative;right:auto;bottom:auto;width:auto}.sully-journal-theme-midnight .sully-journal-page-content{padding:27px 23px!important}.sully-journal-theme-midnight .sully-journal-inspector-ghost{display:none}}
`;

export const JOURNAL_APPEARANCE_PRESETS: JournalAppearancePreset[] = [
    {
        id: 'original',
        name: '原本琥珀',
        description: '保留现在的交换日记界面',
        colors: ['#f59e0b', '#fffbeb', '#1a1a1a'],
        layout: 'classic',
        css: '',
    },
    {
        id: 'letterpress',
        name: '邮局档案册',
        description: '横向信封、邮戳与打字机索引卡',
        colors: ['#a34e3d', '#f4e7cb', '#355d65'],
        layout: 'postal-archive',
        css: LETTERPRESS_CSS,
    },
    {
        id: 'sakura',
        name: '星夜角色相册',
        description: '深蓝硬壳、金属星盘与大幅拍立得',
        colors: ['#5965cb', '#11172b', '#d7b46d'],
        layout: 'celestial-album',
        css: SAKURA_CSS,
    },
    {
        id: 'forest',
        name: '野外观察手册',
        description: '皮革包角、活页装订与标本索引',
        colors: ['#687849', '#f0d3a2', '#b85f3d'],
        layout: 'field-dossier',
        css: FOREST_CSS,
    },
    {
        id: 'midnight',
        name: '午夜记忆编辑器',
        description: '蓝紫复古窗口、线路与对象检查器',
        colors: ['#718bd4', '#fbfcff', '#405487'],
        layout: 'memory-editor',
        css: MIDNIGHT_CSS,
    },
];

export const resolveJournalPreset = (preset?: JournalAppearancePresetId) =>
    JOURNAL_APPEARANCE_PRESETS.find(candidate => candidate.id === (preset || 'original'))
    || JOURNAL_APPEARANCE_PRESETS[0];

export const resolveJournalAppearanceCss = (appearance?: JournalAppearance) => {
    const presetCss = resolveJournalPreset(appearance?.preset).css;
    const customCss = appearance?.customCss?.trim() || '';
    return [presetCss, customCss].filter(Boolean).join('\n');
};

/** 将“内置主题 + 用户覆盖”拍平成一份不依赖主题 ID 的独立 CSS。 */
export const flattenJournalAppearance = (appearance?: JournalAppearance): JournalAppearance => ({
    preset: 'original',
    customCss: resolveJournalAppearanceCss(appearance),
});
