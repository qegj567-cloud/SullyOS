import cardPalette from '../art/acid-orbit/lavender-card-palette.css?raw';

// Applying a whitebox stores its CSS on the character or theme, without a preset ID.
// Replace only the old stock rule in place so later personal overrides still win.
const legacyRule = '.sully-chat-card[data-card-kind]:not(:where([data-card-kind="transfer"], [data-card-variant="qixi_event_card"], [data-card-variant="like520_card"])) {--sully-card-background:linear-gradient(125deg,#fbf7ffed,#e5d9f1eb);--sully-card-color:#493958;--sully-card-shadow:inset 0 0 0 1px #fff9,0 3px 12px #9275ac1a;}';

export function resolveLavenderCardPalette(css: string): string {
    if (!css.includes('/* 星轨 · 雾紫：同版式的浅色配色 */')) return css;
    return css.replace(legacyRule, cardPalette.trim().replace(/\r\n/g, '\n'));
}
