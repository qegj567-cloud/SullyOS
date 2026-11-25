import { DB } from './db';

export const VOICE_FAVORITES_INDEX_ASSET_ID = 'voice_favorites_index_v1';
export const VOICE_FAVORITE_AUDIO_PREFIX = 'voice_favorite_audio_';
export const VOICE_FAVORITES_CHANGED_EVENT = 'sully:voice-favorites-changed';

export type VoiceFavoriteSource = 'chat' | 'call' | 'date' | 'companion';

export interface VoiceFavorite {
    id: string;
    source: VoiceFavoriteSource;
    /** Stable identity inside the source app (message id, call bubble id, etc.). */
    sourceKey: string;
    charId: string;
    charName: string;
    sourceTimestamp: number;
    favoritedAt: number;
    originalText: string;
    spokenText?: string;
    translation?: string;
    language?: string;
}

export interface SaveVoiceFavoriteInput extends Omit<VoiceFavorite, 'id' | 'favoritedAt'> {
    blob: Blob;
    favoritedAt?: number;
}

interface VoiceFavoriteIndex {
    version: 1;
    items: VoiceFavorite[];
}

interface VoiceFavoriteAudioAsset {
    blob: Blob;
    mimeType: string;
    savedAt: number;
}

let writeQueue: Promise<unknown> = Promise.resolve();

const withWriteLock = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = writeQueue.then(work, work);
    writeQueue = next.catch(() => undefined);
    return next;
};

const isSource = (value: unknown): value is VoiceFavoriteSource => (
    value === 'chat' || value === 'call' || value === 'companion' || value === 'date'
);

const normalizeTimestamp = (value: unknown, fallback: number): number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
);

const sanitizeFavorite = (value: unknown): VoiceFavorite | null => {
    if (!value || typeof value !== 'object') return null;
    const item = value as Partial<VoiceFavorite>;
    if (typeof item.id !== 'string' || !item.id) return null;
    if (!isSource(item.source)) return null;
    if (typeof item.sourceKey !== 'string' || !item.sourceKey) return null;
    if (typeof item.charId !== 'string' || typeof item.charName !== 'string') return null;
    const now = Date.now();
    return {
        id: item.id,
        source: item.source,
        sourceKey: item.sourceKey,
        charId: item.charId,
        charName: item.charName || '未知角色',
        sourceTimestamp: normalizeTimestamp(item.sourceTimestamp, now),
        favoritedAt: normalizeTimestamp(item.favoritedAt, now),
        originalText: typeof item.originalText === 'string' ? item.originalText : '',
        spokenText: typeof item.spokenText === 'string' && item.spokenText ? item.spokenText : undefined,
        translation: typeof item.translation === 'string' && item.translation ? item.translation : undefined,
        language: typeof item.language === 'string' && item.language ? item.language : undefined,
    };
};

const loadIndex = async (): Promise<VoiceFavorite[]> => {
    const raw = await DB.getAssetRaw(VOICE_FAVORITES_INDEX_ASSET_ID).catch(() => null) as Partial<VoiceFavoriteIndex> | VoiceFavorite[] | null;
    const items = Array.isArray(raw) ? raw : raw?.items;
    if (!Array.isArray(items)) return [];
    return items.map(sanitizeFavorite).filter((item): item is VoiceFavorite => !!item);
};

const saveIndex = async (items: VoiceFavorite[]): Promise<void> => {
    await DB.saveAssetRaw(VOICE_FAVORITES_INDEX_ASSET_ID, { version: 1, items } satisfies VoiceFavoriteIndex);
};

const notifyChanged = () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(VOICE_FAVORITES_CHANGED_EVENT));
};

/** A compact deterministic id keeps the audio asset key stable without storing text or names in it. */
export const makeVoiceFavoriteId = (source: VoiceFavoriteSource, sourceKey: string): string => {
    const input = `${source}\u0000${sourceKey}`;
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    for (let i = 0; i < input.length; i++) {
        const code = input.charCodeAt(i);
        a = Math.imul(a ^ code, 0x01000193);
        b = Math.imul(b ^ code, 0x85ebca6b);
    }
    return `${source}_${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
};

export const voiceFavoriteAudioAssetId = (favoriteId: string): string => `${VOICE_FAVORITE_AUDIO_PREFIX}${favoriteId}`;

export const sortVoiceFavorites = (items: VoiceFavorite[]): VoiceFavorite[] => (
    [...items].sort((a, b) => b.sourceTimestamp - a.sourceTimestamp || b.favoritedAt - a.favoritedAt || b.id.localeCompare(a.id))
);

/** Reads metadata only; no audio Blob is pulled into memory. */
export const listVoiceFavorites = async (): Promise<VoiceFavorite[]> => sortVoiceFavorites(await loadIndex());

export const getVoiceFavorite = async (source: VoiceFavoriteSource, sourceKey: string): Promise<VoiceFavorite | null> => {
    const id = makeVoiceFavoriteId(source, sourceKey);
    return (await loadIndex()).find(item => item.id === id) || null;
};

export const getVoiceFavoriteBlob = async (favoriteId: string): Promise<Blob | null> => {
    const raw = await DB.getAssetRaw(voiceFavoriteAudioAssetId(favoriteId)).catch(() => null) as VoiceFavoriteAudioAsset | Blob | null;
    if (raw instanceof Blob) return raw;
    return raw?.blob instanceof Blob ? raw.blob : null;
};

export const saveVoiceFavorite = async (input: SaveVoiceFavoriteInput): Promise<VoiceFavorite> => withWriteLock(async () => {
    if (!(input.blob instanceof Blob) || input.blob.size <= 0) throw new Error('语音文件为空');
    const id = makeVoiceFavoriteId(input.source, input.sourceKey);
    const now = Date.now();
    const current = await loadIndex();
    const existing = current.find(item => item.id === id);
    const favorite: VoiceFavorite = {
        id,
        source: input.source,
        sourceKey: input.sourceKey,
        charId: input.charId,
        charName: input.charName || '未知角色',
        sourceTimestamp: normalizeTimestamp(input.sourceTimestamp, now),
        favoritedAt: normalizeTimestamp(input.favoritedAt, existing?.favoritedAt || now),
        originalText: input.originalText || '',
        spokenText: input.spokenText || undefined,
        translation: input.translation || undefined,
        language: input.language || undefined,
    };

    await DB.saveAssetRaw(voiceFavoriteAudioAssetId(id), {
        blob: input.blob,
        mimeType: input.blob.type || 'audio/mpeg',
        savedAt: now,
    } satisfies VoiceFavoriteAudioAsset);
    try {
        await saveIndex([favorite, ...current.filter(item => item.id !== id)]);
    } catch (error) {
        if (!existing) await DB.deleteAsset(voiceFavoriteAudioAssetId(id)).catch(() => undefined);
        throw error;
    }
    notifyChanged();
    return favorite;
});

export const removeVoiceFavorite = async (source: VoiceFavoriteSource, sourceKey: string): Promise<boolean> => (
    removeVoiceFavoriteById(makeVoiceFavoriteId(source, sourceKey))
);

export const removeVoiceFavoriteById = async (favoriteId: string): Promise<boolean> => withWriteLock(async () => {
    const current = await loadIndex();
    if (!current.some(item => item.id === favoriteId)) return false;
    await saveIndex(current.filter(item => item.id !== favoriteId));
    await DB.deleteAsset(voiceFavoriteAudioAssetId(favoriteId)).catch(() => undefined);
    notifyChanged();
    return true;
});

export const voiceFavoriteSourceLabel = (source: VoiceFavoriteSource): string => ({
    chat: '聊天',
    call: '通话',
    companion: '同行',
    date: '见面',
}[source]);
