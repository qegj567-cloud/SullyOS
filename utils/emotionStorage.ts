/**
 * 情绪存储 (Emotion Storage)
 *
 * IndexedDB 存取层 — 管理 emotionState、personalityCrystals、
 * crossEventLinks、tensions、innerMonologue、emotionHistory
 *
 * 使用现有 db.ts 的 openDB pattern，但新增独立的 object stores
 */

import type {
    EmotionState,
    EmotionHistorySnapshot,
    CrossEventLink,
    Tension,
    PersonalityCrystal,
    InnerMonologueEntry,
    UserCognitiveModel,
} from '../types';

// ── DB Constants ──

const DB_NAME = 'AetherOS_CogArch';
const DB_VERSION = 1;

const STORE_EMOTION_STATE = 'emotion_state';           // key: charId
const STORE_EMOTION_HISTORY = 'emotion_history';       // key: id, index: charId
const STORE_CROSS_EVENT_LINKS = 'cross_event_links';   // key: id, index: charId
const STORE_TENSIONS = 'tensions';                     // key: id, index: charId
const STORE_CRYSTALS = 'personality_crystals';          // key: id, index: charId
const STORE_MONOLOGUE = 'inner_monologue';              // key: id, index: charId
const STORE_COGNITIVE_MODEL = 'user_cognitive_model';   // key: charId

// ── DB Open ──

let _dbPromise: Promise<IDBDatabase> | null = null;

function openCogDB(): Promise<IDBDatabase> {
    if (_dbPromise) return _dbPromise;

    _dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            _dbPromise = null;
            reject(request.error);
        };

        request.onsuccess = () => resolve(request.result);

        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;

            const createStore = (name: string, opts?: IDBObjectStoreParameters) => {
                if (!db.objectStoreNames.contains(name)) {
                    return db.createObjectStore(name, opts);
                }
                return (event.target as IDBOpenDBRequest).transaction!.objectStore(name);
            };

            // emotion_state: one record per character
            createStore(STORE_EMOTION_STATE, { keyPath: 'charId' });

            // emotion_history: snapshots over time
            const histStore = createStore(STORE_EMOTION_HISTORY, { keyPath: 'id' });
            if (!histStore.indexNames.contains('charId')) {
                histStore.createIndex('charId', 'charId', { unique: false });
            }

            // cross_event_links
            const linkStore = createStore(STORE_CROSS_EVENT_LINKS, { keyPath: 'id' });
            if (!linkStore.indexNames.contains('charId')) {
                linkStore.createIndex('charId', 'charId', { unique: false });
            }

            // tensions
            const tensionStore = createStore(STORE_TENSIONS, { keyPath: 'id' });
            if (!tensionStore.indexNames.contains('charId')) {
                tensionStore.createIndex('charId', 'charId', { unique: false });
            }

            // personality_crystals
            const crystalStore = createStore(STORE_CRYSTALS, { keyPath: 'id' });
            if (!crystalStore.indexNames.contains('charId')) {
                crystalStore.createIndex('charId', 'charId', { unique: false });
            }

            // inner_monologue
            const monoStore = createStore(STORE_MONOLOGUE, { keyPath: 'id' });
            if (!monoStore.indexNames.contains('charId')) {
                monoStore.createIndex('charId', 'charId', { unique: false });
            }

            // user_cognitive_model
            createStore(STORE_COGNITIVE_MODEL, { keyPath: 'charId' });
        };
    });

    return _dbPromise;
}

// ── Generic Helpers ──

async function putRecord<T>(storeName: string, data: T): Promise<void> {
    const db = await openCogDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(data);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function getRecord<T>(storeName: string, key: string): Promise<T | undefined> {
    const db = await openCogDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result ?? undefined);
        req.onerror = () => reject(req.error);
    });
}

async function getAllByIndex<T>(storeName: string, indexName: string, key: string): Promise<T[]> {
    const db = await openCogDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const idx = tx.objectStore(storeName).index(indexName);
        const req = idx.getAll(key);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

async function deleteRecord(storeName: string, key: string): Promise<void> {
    const db = await openCogDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ── Emotion State ──

export async function saveEmotionState(charId: string, state: EmotionState): Promise<void> {
    return putRecord(STORE_EMOTION_STATE, { charId, ...state });
}

export async function loadEmotionState(charId: string): Promise<EmotionState | undefined> {
    const record = await getRecord<{ charId: string } & EmotionState>(STORE_EMOTION_STATE, charId);
    if (!record) return undefined;
    const { charId: _, ...state } = record;
    return state;
}

// ── Emotion History ──

export async function saveEmotionSnapshot(snapshot: EmotionHistorySnapshot): Promise<void> {
    return putRecord(STORE_EMOTION_HISTORY, snapshot);
}

export async function getEmotionHistory(charId: string): Promise<EmotionHistorySnapshot[]> {
    return getAllByIndex(STORE_EMOTION_HISTORY, 'charId', charId);
}

/** 清理 N 天前的历史快照 */
export async function pruneEmotionHistory(charId: string, keepDays: number = 90): Promise<void> {
    const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
    const all = await getEmotionHistory(charId);
    const toDelete = all.filter(s => s.timestamp < cutoff);
    for (const s of toDelete) {
        await deleteRecord(STORE_EMOTION_HISTORY, s.id);
    }
}

// ── Cross Event Links ──

export async function saveCrossEventLink(link: CrossEventLink): Promise<void> {
    return putRecord(STORE_CROSS_EVENT_LINKS, link);
}

export async function getCrossEventLinks(charId: string): Promise<CrossEventLink[]> {
    return getAllByIndex(STORE_CROSS_EVENT_LINKS, 'charId', charId);
}

export async function deleteCrossEventLink(id: string): Promise<void> {
    return deleteRecord(STORE_CROSS_EVENT_LINKS, id);
}

// ── Tensions ──

export async function saveTension(tension: Tension): Promise<void> {
    return putRecord(STORE_TENSIONS, tension);
}

export async function getTensions(charId: string): Promise<Tension[]> {
    return getAllByIndex(STORE_TENSIONS, 'charId', charId);
}

export async function deleteTension(id: string): Promise<void> {
    return deleteRecord(STORE_TENSIONS, id);
}

// ── Personality Crystals ──

export async function saveCrystal(crystal: PersonalityCrystal): Promise<void> {
    return putRecord(STORE_CRYSTALS, crystal);
}

export async function getCrystals(charId: string): Promise<PersonalityCrystal[]> {
    return getAllByIndex(STORE_CRYSTALS, 'charId', charId);
}

export async function deleteCrystal(id: string): Promise<void> {
    return deleteRecord(STORE_CRYSTALS, id);
}

// ── Inner Monologue ──

export async function saveMonologue(entry: InnerMonologueEntry): Promise<void> {
    return putRecord(STORE_MONOLOGUE, entry);
}

export async function getMonologues(charId: string): Promise<InnerMonologueEntry[]> {
    return getAllByIndex(STORE_MONOLOGUE, 'charId', charId);
}

/** 清理 N 天前的独白日志 */
export async function pruneMonologues(charId: string, keepDays: number = 90): Promise<void> {
    const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
    const all = await getMonologues(charId);
    const toDelete = all.filter(e => e.timestamp < cutoff);
    for (const e of toDelete) {
        await deleteRecord(STORE_MONOLOGUE, e.id);
    }
}

// ── User Cognitive Model ──

export async function saveCognitiveModel(model: UserCognitiveModel): Promise<void> {
    return putRecord(STORE_COGNITIVE_MODEL, model);
}

export async function loadCognitiveModel(charId: string): Promise<UserCognitiveModel | undefined> {
    return getRecord(STORE_COGNITIVE_MODEL, charId);
}

// ── Migration from localStorage ──

/**
 * 一次性迁移：检查 localStorage 中是否有旧的情绪数据，有则迁移到 IndexedDB
 */
export async function migrateFromLocalStorage(charId: string): Promise<boolean> {
    const key = `emotion_state_${charId}`;
    const raw = localStorage.getItem(key);
    if (!raw) return false;

    try {
        const parsed = JSON.parse(raw) as EmotionState;
        await saveEmotionState(charId, parsed);
        localStorage.removeItem(key);
        console.log(`[CogArch] Migrated emotion state for ${charId} from localStorage to IndexedDB`);
        return true;
    } catch (e) {
        console.warn('[CogArch] Failed to migrate emotion state from localStorage:', e);
        return false;
    }
}
