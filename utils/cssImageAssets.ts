import {dataUrlToBlob, getBlobForRef, putImageBlobDeduped, resolveRefToDataUrl} from './blobRef';

// Scan once, including large data URLs. Avoid selector/URL regex backtracking on
// multi-megabyte images, and leave comments and CSS string literals untouched.
function urls(css: string): Array<{start: number; end: number; value: string}> {
    const found: Array<{start: number; end: number; value: string}> = [];
    const quotedEnd = (start: number) => {
        const quote = css[start]; let i = start + 1;
        for (; i < css.length; i++) {
            if (css[i] === '\\') i++;
            else if (css[i] === quote) return i;
        }
        return css.length;
    };
    for (let i = 0; i < css.length; i++) {
        // Escaped punctuation in generated selectors (e.g. content-\[\'\'\])
        // is not the start of a string/comment. Losing quote alignment here
        // would skip later image URLs in the combined preview stylesheet.
        if (css[i] === '\\') i++;
        else if (css[i] === '/' && css[i + 1] === '*') {
            const end = css.indexOf('*/', i + 2); i = end < 0 ? css.length : end + 1;
        } else if (css[i] === '"' || css[i] === "'") i = quotedEnd(i);
        else if (css.slice(i, i + 4).toLowerCase() === 'url(' && (i === 0 || !/[\w-]/.test(css[i - 1]))) {
            let start = i + 4; while (/\s/.test(css[start] || '') && start < css.length) start++;
            let end: number; let close: number;
            if (css[start] === '"' || css[start] === "'") {
                end = quotedEnd(start); start++; close = end + 1;
                while (close < css.length && /\s/.test(css[close])) close++;
            } else {
                close = start;
                while (close < css.length && css[close] !== ')') {if (css[close] === '\\') close++; close++;}
                end = close; while (end > start && /\s/.test(css[end - 1])) end--;
            }
            if (css[close] === ')') found.push({start, end, value: css.slice(start, end)});
            i = close;
        }
    }
    return found;
}

function replaceUrls(css: string, values: ReadonlyMap<string, string>, found = urls(css)): string {
    const chunks: string[] = []; let cursor = 0;
    for (const url of found) {
        chunks.push(css.slice(cursor, url.start), values.get(url.value) ?? url.value); cursor = url.end;
    }
    chunks.push(css.slice(cursor)); return chunks.join('');
}

async function mapUrls(css: string, transform: (value: string) => Promise<string>, concurrency = 1): Promise<string> {
    const found = urls(css);
    const unique = [...new Set(found.map(url => url.value))];
    const values = new Map<string, string>(); let next = 0;
    const results = await Promise.allSettled(Array.from({length: Math.min(concurrency, unique.length)}, async () => {
        while (next < unique.length) {
            const value = unique[next++]; values.set(value, await transform(value));
        }
    }));
    // All readers must settle before the caller disposes URLs, including on failure.
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    return replaceUrls(css, values, found);
}

/** Patch image declarations without rebuilding unrelated rules (notably @font-face).
 * Replacing a style's text recreates its CSS-connected FontFace objects. */
export function applyCssImageUrls(sheet: CSSStyleSheet, replacements: ReadonlyMap<string, string>): void {
    const visit = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
            const declaration = (rule as CSSStyleRule).style;
            if (declaration) {
                for (let i = 0; i < declaration.length; i++) {
                    const property = declaration[i]; const value = declaration.getPropertyValue(property);
                    if (!value.includes('blobref:')) continue;
                    const resolved = replaceUrls(value, replacements);
                    if (resolved !== value) declaration.setProperty(property, resolved, declaration.getPropertyPriority(property));
                }
            }
            const nested = (rule as CSSGroupingRule).cssRules;
            if (nested) visit(nested);
        }
    };
    visit(sheet.cssRules);
}

/** Only image URLs in primary decoration CSS are localized. Original bytes survive. */
export function localizeCssImages(css: string): Promise<string> {
    if (!/data:image\//i.test(css)) return Promise.resolve(css);
    return mapUrls(css, async value => /^data:image\/[\w.+-]+[;,]/i.test(value)
        ? (await putImageBlobDeduped(dataUrlToBlob(value))).token : value);
}

/** Portable copies keep the author's URL quoting/formatting (and content identity). */
export function portableCssImages(css: string): Promise<string> {
    if (!css.includes('blobref:')) return Promise.resolve(css);
    return mapUrls(css, async value => {
        if (!value.startsWith('blobref:')) return value;
        const image = await resolveRefToDataUrl(value);
        if (!image || image.startsWith('blobref:')) throw Error('部分图片素材已丢失，请重新上传后导出');
        return image;
    });
}

/** Each mounted consumer owns its URLs; late/cancelled loads must also dispose. */
export async function resolveCssImageUrls(css: string, allowMissing = false): Promise<{css: string; dispose: () => void; replacements: ReadonlyMap<string, string>}> {
    if (!css.includes('blobref:')) return {css, dispose: () => {}, replacements: new Map()};
    const owned: string[] = [];
    const replacements = new Map<string, string>();
    const dispose = () => {for (const url of owned.splice(0)) URL.revokeObjectURL(url);};
    try {
        const resolved = await mapUrls(css, async value => {
            if (!value.startsWith('blobref:')) return value;
            const blob = await getBlobForRef(value);
            if (!blob) {
                if (allowMissing) {replacements.set(value, ''); return '';}
                throw Error('部分图片素材已丢失，请重新上传');
            }
            const url = URL.createObjectURL(blob); owned.push(url); replacements.set(value, url); return url;
        }, 4);
        return {css: resolved, dispose, replacements};
    } catch (error) {dispose(); throw error;}
}
