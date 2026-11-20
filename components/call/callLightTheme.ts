/**
 * 电话 App 浅色主题：作用域 CSS 覆盖层。
 *
 * CallApp 的深色皮肤散落在几百处 Tailwind 工具类里（text-white/xx、
 * bg-black/xx、border-white/xx…），逐处改成条件 class 不现实。这里按
 * 「同一透明度、翻转基色」的规则生成一层 `.sully-call-light` 作用域覆盖：
 *   · 白字 → 墨色（深紫灰），白玻璃面板 → 墨色淡染，黑玻璃胶囊 → 白玻璃；
 *   · `.sully-stage-dark` 子树（视频舞台 / Live2D 设置面板 / 导入遮罩）
 *     成对生成还原规则，保持视频画面的深色质感；
 *   · 实色按钮（accent/绿/红底）标 `.keep-white` 强制白字。
 */

const INK = '38,34,57'; // #262239 深紫灰墨色

const rules: string[] = [];

/** 生成一对规则：浅色覆盖 + 舞台子树（含挂载点自身）还原。 */
const pair = (selector: string, lightDecl: string, darkDecl: string): void => {
  rules.push(`.sully-call-light ${selector}{${lightDecl} !important}`);
  rules.push(`.sully-call-light .sully-stage-dark ${selector},.sully-call-light .sully-stage-dark${selector}{${darkDecl} !important}`);
};

// ── 文字：白 → 墨（低透明度略抬高保证可读） ──
pair('.text-white', 'color:#262239', 'color:#fff');
// 根容器自己就挂着 text-white（后代选择器够不到自身），补一条复合选择器
rules.push('.sully-call-light.text-white{color:#262239 !important}');
for (const alpha of [95, 90, 85, 80, 75, 70, 65, 64, 62, 60, 55, 52, 50, 48, 45, 42, 40, 38, 35, 30, 28, 25]) {
  const lightAlpha = Math.min(1, alpha / 100 + 0.08).toFixed(2);
  pair(`.text-white\\/${alpha}`, `color:rgba(${INK},${lightAlpha})`, `color:rgba(255,255,255,${alpha / 100})`);
}

// ── 边框：白描边 → 墨描边（略加深，浅底上太淡会消失） ──
for (const alpha of [8, 10, 12, 14, 15, 20, 25]) {
  pair(`.border-white\\/${alpha}`, `border-color:rgba(${INK},${((alpha / 100) * 1.5).toFixed(3)})`, `border-color:rgba(255,255,255,${alpha / 100})`);
}
pair('.border-white\\/\\[0\\.07\\]', `border-color:rgba(${INK},0.105)`, 'border-color:rgba(255,255,255,0.07)');

// ── 白玻璃面板（bg-white/[0.0x] 微提亮）→ 墨色微染 ──
for (const [raw, num] of [
  ['0.025', 0.025],
  ['.025', 0.025],
  ['0.03', 0.03],
  ['0.035', 0.035],
  ['0.04', 0.04],
  ['0.05', 0.05],
  ['0.06', 0.06],
  ['.06', 0.06],
  ['0.07', 0.07],
  ['0.08', 0.08],
] as const) {
  const escaped = raw.replace('.', '\\.');
  pair(`.bg-white\\/\\[${escaped}\\]`, `background-color:rgba(${INK},${(num * 1.3).toFixed(3)})`, `background-color:rgba(255,255,255,${num})`);
}
for (const alpha of [8, 10, 12, 14, 15, 25, 40, 65]) {
  pair(`.bg-white\\/${alpha}`, `background-color:rgba(${INK},${(alpha / 100).toFixed(2)})`, `background-color:rgba(255,255,255,${alpha / 100})`);
}

// ── 黑玻璃胶囊/工具条 → 白玻璃；模态遮罩保持暗但减淡 ──
pair('.bg-black\\/15', 'background-color:rgba(255,255,255,0.56)', 'background-color:rgba(0,0,0,0.15)');
pair('.bg-black\\/20', 'background-color:rgba(255,255,255,0.6)', 'background-color:rgba(0,0,0,0.2)');
pair('.bg-black\\/25', 'background-color:rgba(255,255,255,0.61)', 'background-color:rgba(0,0,0,0.25)');
pair('.bg-black\\/30', 'background-color:rgba(255,255,255,0.62)', 'background-color:rgba(0,0,0,0.3)');
pair('.bg-black\\/35', 'background-color:rgba(255,255,255,0.66)', 'background-color:rgba(0,0,0,0.35)');
pair('.bg-black\\/38', 'background-color:rgba(255,255,255,0.68)', 'background-color:rgba(0,0,0,0.38)');
pair('.bg-black\\/40', 'background-color:rgba(255,255,255,0.7)', 'background-color:rgba(0,0,0,0.4)');
pair('.bg-black\\/60', `background-color:rgba(${INK},0.3)`, 'background-color:rgba(0,0,0,0.6)');
pair('.bg-black\\/66', `background-color:rgba(${INK},0.32)`, 'background-color:rgba(0,0,0,0.66)');
pair('.bg-black\\/70', `background-color:rgba(${INK},0.34)`, 'background-color:rgba(0,0,0,0.7)');

// ── 输入框占位符 ──
for (const alpha of [25, 30, 35]) {
  pair(`.placeholder\\:text-white\\/${alpha}::placeholder`, `color:rgba(${INK},0.42)`, `color:rgba(255,255,255,${alpha / 100})`);
}

// ── 玫红 / 紫 / 琥珀提示色浅底加深 ──
pair('.text-rose-200', 'color:#be123c', 'color:#fecdd3');
pair('.text-rose-300', 'color:#e11d48', 'color:#fda4af');
pair('.text-rose-300\\/90', 'color:#e11d48', 'color:rgba(253,164,175,0.9)');
pair('.text-rose-300\\/80', 'color:rgba(225,29,72,0.85)', 'color:rgba(253,164,175,0.8)');
pair('.text-rose-300\\/65', 'color:rgba(225,29,72,0.7)', 'color:rgba(253,164,175,0.65)');
pair('.text-violet-300\\/95', 'color:#6d28d9', 'color:rgba(196,181,253,0.95)');
pair('.text-amber-200\\/70', 'color:#b45309', 'color:rgba(253,230,138,0.7)');
pair('.text-amber-300\\/70', 'color:#b45309', 'color:rgba(252,211,77,0.7)');

// 实色底按钮（accent/绿/红）不论主题都要白字
rules.push('.sully-call-light .keep-white{color:#fff !important}');
rules.push('.sully-call-light{color-scheme:light}');
rules.push('.sully-call-light .sully-stage-dark{color-scheme:dark}');

export const CALL_LIGHT_THEME_CSS = rules.join('\n');
