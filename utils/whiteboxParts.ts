import { parse, type Rule } from 'postcss';
import { splitCssSelectors } from './cssRuleSelectors';
import { targetAvatarFrameCss } from './avatarFrameTarget';

export type WhiteboxPart = 'bubbles' | 'avatar:user' | 'avatar:ai' | 'background' | 'psyche' | 'profile' | 'layout' | 'schedule' | 'journal' | 'collaboration' | 'date' | 'story';
type Surface = WhiteboxPart | 'avatar' | 'canvas' | 'reader';
const hooks: [RegExp, Surface][] = [
    [/^sully-(?:bubble|voice-bar)(?:-|$)/, 'bubbles'],
    [/^sully-(?:psyche(?:-|$)|chat-psyche-row$)/, 'psyche'],
    [/^sully-chat-(?:avatar-wrap|avatar-frame|message-avatar-img)$/, 'avatar'],
    [/^sully-chat-(?:root|messages)$/, 'canvas'],
    [/^sully-(?:chat-(?:message(?:-|$)|turn-avatar|timestamp|avatar-timestamp|day-divider|time-divider)|emoji-msg$)/, 'layout'],
    [/^chat-profile-/, 'profile'], [/^sully-schedule-/, 'schedule'], [/^sully-journal(?:-|$)/, 'journal'],
    [/^collab-ui-root$/, 'collaboration'], [/^meeting-reading$/, 'reader'],
];

function surfaceOf(selector: string): Surface | undefined {
    // Ignore hooks that only constrain an ancestor or exclude another surface.
    const positive = selector.replace(/:(?:where|is)\(\s*\.sully-chat-message-(?:user|ai)\s+\*\s*\)/g,'').replace(/:(?:not|has)\((?:[^()]|\([^()]*\))*\)|\[(?:[^\]"']|"[^"]*"|'[^']*')*\]/g, '');
    const classes = [...positive.matchAll(/\.([\w-]+)/g)];
    for (let i = classes.length - 1; i >= 0; i--) {
        const name = classes[i][1];
        const surface = hooks.find(([pattern]) => pattern.test(name))?.[1];
        if (surface === 'canvas' && /[\s>+~]/.test(positive.slice(classes[i].index! + name.length + 1).trimEnd())) return;
        if (surface) return surface;
        if (/^(sully-|chat-profile-|meeting-|collab-)/.test(name)) return;
    }
}
const isBackground = (prop: string) => /^background(?:-|$)/i.test(prop);
const canvasOverlay = (selector: string) => /::?(?:before|after)\b/.test(selector);

function partsOf(surface: Surface | undefined, selector: string, rule: Rule): WhiteboxPart[] {
    if (surface === 'canvas') return canvasOverlay(selector) || rule.nodes.some(n=>n.type==='decl' && isBackground(n.prop)) ? ['background'] : [];
    if (surface === 'avatar') {
        const user = /\.sully-chat-message-user\b/.test(selector), ai = /\.sully-chat-message-ai\b/.test(selector);
        return user === ai ? ['avatar:user','avatar:ai'] : [user ? 'avatar:user' : 'avatar:ai'];
    }
    if (surface === 'reader') return ['date','story'];
    return surface ? [surface] : [];
}

/** Split selector lists before removing superseded rules. Preserve keyframes, data URLs and unrelated declarations. */
function inspectWhitebox(css: string, withdrawn: ReadonlySet<WhiteboxPart>, found: Set<WhiteboxPart>, retain = false): string {
    if (!css || !css.includes('{')) return css;
    let root;
    try { root = parse(css, {from: undefined}); } catch { return css; } // Preserve unfinished CSS from the free-form editor.
    const rules: Rule[] = [];
    root.walkRules(rule => { rules.push(rule); });
    let changed = false;
    const tokenRules: Rule[] = [];
    for (const rule of rules) {
        if (rule.parent?.type==='atrule' && /keyframes$/i.test(rule.parent.name)) continue;
        const keep: string[] = [], canvas: string[] = [];
        let edited = false;
        const expand = (selector:string):string[] => {
            // Split a positive union if its alternatives belong to different components.
            const group= /:(is|where)\(([^()]*,[^()]*)\)/.exec(selector);
            if (!group) return [selector];
            const variants=splitCssSelectors(group[2]).map(option=>selector.slice(0,group.index)+':'+group[1]+'('+option.trim()+')'+selector.slice(group.index+group[0].length));
            return new Set(variants.map(surfaceOf)).size>1 ? variants : [selector];
        };
        for (const raw of splitCssSelectors(rule.selector).flatMap(expand)) {
            const selector = raw.trim();
            const surface = surfaceOf(selector);
            const parts = partsOf(surface, selector, rule);
            parts.forEach(part=>found.add(part));
            const matches = parts.some(part=>withdrawn.has(part));
            if (retain && surface === 'canvas' && !canvasOverlay(selector) && matches) {
                edited=true; canvas.push(raw); continue;
            }
            if (retain ? matches && (surface!=='avatar' || parts.every(part=>withdrawn.has(part))) : !matches) { keep.push(raw); continue; }
            edited = true;
            if (!retain && surface === 'canvas' && !canvasOverlay(selector)) canvas.push(raw);
            if (surface === 'avatar' && matches && parts.length === 2 && !parts.every(part=>withdrawn.has(part))) {
                const side = withdrawn.has('avatar:user') === retain ? 'user' : 'ai';
                keep.push(targetAvatarFrameCss(selector+'{}',side).replace(/\{\}$/, '').trim());
            }
        }
        if (!edited) continue;
        changed = true;
        if (canvas.length) {
            const copy = rule.cloneBefore({selector: canvas.join(',')});
            copy.walkDecls(decl=>{ if (isBackground(decl.prop) !== retain) decl.remove(); });
            if (!copy.nodes.length) copy.remove();
        }
        if (retain && !keep.length && rule.nodes.some(n=>n.type==='decl'&&n.prop.startsWith('--'))) {
            const tokens=rule.cloneBefore();
            tokens.each(node=>{if(node.type!=='decl'||!node.prop.startsWith('--'))node.remove();});
            tokenRules.push(tokens);
        }
        if (keep.length) rule.selector=keep.join(',');
        else rule.remove();
    }
    if (!retain) return changed ? root.toString() : css;
    // Keep root tokens used by a retained part. Unrelated whitebox variables must not override the incoming palette.
    const used=new Set<string>();
    const collect=(value:string)=>{ for(const match of value.matchAll(/var\(\s*(--[\w-]+)/g)) used.add(match[1]); };
    root.walkDecls(decl=>{ if(!tokenRules.includes(decl.parent as Rule))collect(decl.value); });
    let size;
    do {
        size=used.size;
        for(const rule of tokenRules)rule.walkDecls(decl=>{ if(used.has(decl.prop)) collect(decl.value); });
    } while(used.size!==size);
    for(const rule of tokenRules){
        rule.walkDecls(decl=>{ if(!used.has(decl.prop))decl.remove(); });
        if(!rule.nodes.length)rule.remove();
    }
    const animations: string[]=[];
    root.walkDecls(/^(?:-webkit-)?animation(?:-name)?$/,decl=>{animations.push(decl.value);});
    root.walkAtRules(at=>{
        if(/keyframes$/i.test(at.name) && !animations.some(value=>value.includes(at.params)))at.remove();
        else if(at.nodes?.length===0 || at.name==='import' || at.name==='charset')at.remove();
    });
    root.walkComments(c=>{ if(!/^(?:end-)?sully-composer:/.test(c.text))c.remove(); });
    return root.toString().replace(/\/\* sully-composer:(avatar|background) \*\/\s*\/\* end-sully-composer:\1 \*\//g,'');
}

/** A whitebox replaces chrome, but can omit independently selectable parts from the previous outfit. */
export function mergeWhiteboxSelection(before: string, incoming: string, selected: readonly WhiteboxPart[]): string {
    if (!before || before === incoming) return incoming;
    const taken=new Set([...embeddedWhiteboxParts(incoming),...selected]);
    const retained=[...embeddedWhiteboxParts(before)].filter(part=>!taken.has(part));
    if (!retained.length) return incoming;
    const carry=inspectWhitebox(before,new Set(retained),new Set(),true);
    return [carry.trim(),incoming].filter(Boolean).join('\n');
}

export function followedWhiteboxCss(css: string, parts?: readonly WhiteboxPart[]): string | undefined {
    if (!Array.isArray(parts) || !parts.length || !css) return;
    const embedded=embeddedWhiteboxParts(css);
    const active=parts.filter(part=>embedded.has(part));
    return active.length ? inspectWhitebox(css,new Set(active),new Set(),true) : undefined;
}

export function embeddedWhiteboxParts(css: string): Set<WhiteboxPart> {
    const found = new Set<WhiteboxPart>();
    inspectWhitebox(css, new Set(), found);
    return found;
}

export function withdrawWhiteboxParts(css: string, parts: readonly WhiteboxPart[]): string {
    if (!parts.length || !css) return css;
    if (parts.includes('background')) css=css.replace(/\/\* sully-composer:background \*\/[\s\S]*?\/\* end-sully-composer:background \*\//g,'');
    if (parts.includes('avatar:user') && parts.includes('avatar:ai')) css=css.replace(/\/\* sully-composer:avatar \*\/[\s\S]*?\/\* end-sully-composer:avatar \*\//g,'');
    return inspectWhitebox(css,new Set(parts),new Set());
}
