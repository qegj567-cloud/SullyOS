/** Font files live in IndexedDB assets; preferences only keep the stable ID. */
export interface SavedFont { id: string; name: string }
interface FontFile extends SavedFont { mime: string; base64: string }
const INDEX = 'font_library_index_v1';
export const isSavedFontId = (value: unknown): value is string => typeof value === 'string' && /^font_library_[a-f0-9]{64}$/.test(value);
let writeQueue: Promise<unknown> = Promise.resolve();

export async function listSavedFonts(): Promise<SavedFont[]> {
    const { DB } = await import('./db');
    const raw = await DB.getAsset(INDEX);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(row => isSavedFontId(row?.id) && typeof row.name === 'string').map(({ id, name }) => ({ id, name })) : [];
}
export async function readSavedFont(id: string): Promise<FontFile | null> {
    if (!isSavedFontId(id)) return null;
    const { DB } = await import('./db');
    const raw = await DB.getAsset(id);
    if (!raw) return null;
    const font = JSON.parse(raw);
    if (font?.id !== id || typeof font.name !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(font.mime)
        || typeof font.base64 !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(font.base64)) return null;
    return font;
}
const asBytes = (font: FontFile) => Uint8Array.from(atob(font.base64), c => c.charCodeAt(0));

export async function rememberFontDataUrl(dataUrl: string, name: string): Promise<SavedFont> {
    const match = /^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
    if (!match) throw new Error('字体文件格式无法读取，请重新导入');
    if (match[2].length > 40 * 1024 * 1024) throw new Error('请使用小于 30 MB 的字体文件');
    const font: FontFile = { id: '', name: name.trim().slice(0, 100) || '导入字体', mime: match[1], base64: match[2] };
    const bytes = asBytes(font);
    // Validate before saving: a renamed image/invalid font must not replace the working selection.
    if (typeof FontFace !== 'undefined') await new FontFace('SullyFontImportCheck', bytes).load().catch(() => { throw new Error('这份文件无法作为字体加载，请换一个字体文件'); });
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
    font.id = 'font_library_' + hash;
    const save = writeQueue.then(async () => {
        const { DB } = await import('./db');
        const list = await listSavedFonts();
        const existing = list.find(row => row.id === font.id);
        if (existing) return existing;
        const row = { id: font.id, name: font.name };
        await DB.saveAssetBatch([{ id: font.id, data: JSON.stringify(font) }, { id: INDEX, data: JSON.stringify([...list, row]) }]);
        return row;
    });
    writeQueue = save.catch(() => {});
    return save;
}
export async function importFontFile(file: File): Promise<SavedFont> {
    if (!/\.(ttf|otf|woff2?)$/i.test(file.name)) throw new Error('仅支持 TTF、OTF、WOFF 和 WOFF2 字体');
    if (file.size > 30 * 1024 * 1024) throw new Error('请使用小于 30 MB 的字体文件');
    const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('字体读取失败，请重试')); reader.readAsDataURL(file);
    });
    // Some OS file pickers provide an empty MIME type.
    return rememberFontDataUrl(dataUrl.replace(/^data:;base64,/, 'data:application/octet-stream;base64,'), file.name.replace(/\.[^.]+$/, ''));
}

type Loaded = { refs: number; ready: Promise<string>; face?: FontFace };
const loaded = new Map<string, Loaded>();
export function acquireSavedFont(id: string): { ready: Promise<string>; release: () => void } {
    let entry = loaded.get(id);
    if (!entry) {
        const created: Loaded = { refs: 0, ready: Promise.resolve('') };
        entry = created; loaded.set(id, entry);
        created.ready = (async () => {
            const font = await readSavedFont(id);
            if (!font) throw new Error('字体文件未找到，请重新导入');
            const family = 'SullyFont_' + id.slice('font_library_'.length);
            const face = await new FontFace(family, asBytes(font)).load();
            if (created.refs > 0) { document.fonts.add(face); created.face = face; }
            return family;
        })();
    }
    entry.refs++;
    let released = false;
    return { ready: entry.ready, release: () => {
        if (released) return; released = true;
        if (--entry!.refs === 0) { if (entry!.face) document.fonts.delete(entry!.face); if (loaded.get(id) === entry) loaded.delete(id); }
    } };
}
