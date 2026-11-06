/** Session-pinned storage boundary. A running page never follows another tab's selection. */
export const DEFAULT_SPACE_ID = 'default';
const CATALOG_KEY = 'sully_user_spaces_v1';
const ACTIVE_KEY = 'sully_active_user_space_v1';
const PREFIX = 'sully_space:';
export const SPACE_DELETIONS_KEY = 'sully_space_deletions_v1';
export interface UserSpace { id: string; name: string }
const raw = typeof localStorage !== 'undefined' ? localStorage : undefined;
export const rawSpaceStorage = raw;
export const isUserSpaceDeleting = (id: string) => !!JSON.parse(raw?.getItem(SPACE_DELETIONS_KEY) || '{}')[id];
export function assertUserSpaceAvailable(id: string) {
    if (isUserSpaceDeleting(id)) throw new Error('这个用户正在删除，请在用户空间中继续完成删除');
}
/** An explicitly imported full backup may restore a deleted ID, never a half-finished deletion. */
export function prepareUserSpaceRestore(id: string, apply = false) {
    const journal = JSON.parse(raw?.getItem(SPACE_DELETIONS_KEY) || '{}');
    if (!journal[id]) return;
    if (!journal[id].done) throw new Error('请先完成该用户的删除，再恢复备份');
    if (apply) { delete journal[id]; raw?.setItem(SPACE_DELETIONS_KEY, JSON.stringify(journal)); }
}
export const userSpaceSessionLock = (id: string) => `sully-user-space-session:${id}`;
const changeListeners = new Set<(key: string) => void>();
export function subscribeSpaceStorageChanges(listener: (key: string) => void) {
    changeListeners.add(listener); return () => { changeListeners.delete(listener); };
}
const validId = (id: unknown): id is string => typeof id === 'string' && /^(default|u_[a-zA-Z0-9_-]+)$/.test(id);

export function listUserSpaces(): UserSpace[] {
    const text = raw?.getItem(CATALOG_KEY);
    if (!text) return [{ id: DEFAULT_SPACE_ID, name: '默认用户' }];
    const entries = JSON.parse(text);
    if (!Array.isArray(entries) || !entries.length || entries.some(s => !validId(s?.id) || typeof s.name !== 'string')
        || new Set(entries.map(s => s.id)).size !== entries.length) throw new Error('用户空间目录损坏，请从备份恢复；原数据未改动');
    return entries;
}
export const SESSION_SPACE_ID = (() => {
    const id = raw?.getItem(ACTIVE_KEY) || DEFAULT_SPACE_ID;
    const spaces = listUserSpaces().filter(s => !isUserSpaceDeleting(s.id));
    return spaces.some(s => s.id === id) ? id : spaces[0]?.id || DEFAULT_SPACE_ID;
})();
export function spaceDatabaseName(base: string, id = SESSION_SPACE_ID): string {
    if (!validId(id)) throw new Error('无效的用户空间编号');
    return id === DEFAULT_SPACE_ID ? base : `${base}__${id}`;
}
export function saveUserSpaces(spaces: UserSpace[]) {
    if (!spaces.length || spaces.some(s => !validId(s.id) || !s.name.trim()) || new Set(spaces.map(s => s.id)).size !== spaces.length) throw new Error('无效的用户空间目录');
    raw?.setItem(CATALOG_KEY, JSON.stringify(spaces));
}
export function selectUserSpace(id: string) {
    assertUserSpaceAvailable(id);
    if (!listUserSpaces().some(s => s.id === id)) throw new Error('用户空间不存在');
    raw?.setItem(ACTIVE_KEY, id);
}

// System connection/preferences remain shared. Everything else is private by default.
const sharedKeys = new Set([
    'amsg2_pending_llm_creds', 'amsg2_llm_cred_fingerprints', 'amsg2_pending_tool_config', 'amsg2_pending_tool_config_version', 'amsg2_state_clock_watermark',
    'os_api_config', 'os_api_presets', 'os_available_models', 'os_vision_available_models', 'os_analytics', 'os_memory_palace_config',
    'os_user_location_privacy_v1', 'os_remote_vector_config', 'os_cloud_backup_config', 'os_realtime_config',
    'sully_proxy_worker_url', 'sully_proxy_worker_url_v1', 'push_vapid_v1', 'study_api_config', 'check_phone_api',
    'sully_music_cfg_v1', 'os_first_use_memory_guide_v1', 'os_first_use_skip_vector_v1', 'sullyos_backup_reminder',
    'world_home_api', 'browser_brave_key', 'browser_use_real_search', 'sully_firecrawl_api_key',
    'aetheros.mcp.servers', 'aetheros.mcp.useNativeTools', 'aetheros.luckin.mcpToken',
    'aetheros.luckin.mcpEnabled', 'aetheros.mcd.mcpToken', 'aetheros.mcd.mcpEnabled',
    'sullyos_disclaimer_accepted', 'sullyos_chat_input_preferences_v1',
    'sullyos_deployment_notice_v1_accepted', 'sullyos_user_holidays_intro_v1',
    'sullyos_real_location_intro_v1_seen', 'sullyos_navigation_ball_intro_v1_seen',
    'sullyos_chat_wardrobe_update_v2_seen', 'sullyos_chat_wardrobe_guide_v2_done',
    'sully_navigation_ball_enabled_v1', 'sully_navigation_ball_position_v1',
    'chat_archive_prompts', 'chat_active_archive_prompt_id', 'character_refine_prompts', 'character_active_refine_prompt_id',
    'study_tutor_presets', 'bm25_mode', 'chat_translate_source_lang', 'chat_translate_lang',
]);
export const isSharedSpaceKey = (key: string) => sharedKeys.has(key)
    || /(?:^|_)(?:api_config|api_key|proxy_url)$/.test(key)
    || /^(?:amsg2_(?:fcm|native|unified|cloud_generations:)|sullyos_(?:update_|notice_)|sully-beauty-author)/.test(key);
const privateKey = (id: string, key: string) => id === DEFAULT_SPACE_ID ? key : `${PREFIX}${id}:${key}`;
const isInternalKey = (key: string) => key.startsWith(PREFIX) || key === CATALOG_KEY || key === ACTIVE_KEY || key === SPACE_DELETIONS_KEY;

/** undefined = another space; null = origin-wide clear. */
export function spaceStorageEventKey(key: string | null, id = SESSION_SPACE_ID): string | null | undefined {
    if (key === null) return null;
    if (key === CATALOG_KEY || key === ACTIVE_KEY || key === SPACE_DELETIONS_KEY) return undefined;
    if (key.startsWith(PREFIX)) {
        const prefix = `${PREFIX}${id}:`;
        return key.startsWith(prefix) ? key.slice(prefix.length) : undefined;
    }
    return isSharedSpaceKey(key) || id === DEFAULT_SPACE_ID ? key : undefined;
}
/** Embedded creator documents bypass the parent's storage facade. */
export function spaceCreatorDraftKey(draft: string | undefined, mode: string, name?: string, id = SESSION_SPACE_ID): string | undefined {
    return id === DEFAULT_SPACE_ID ? draft : `${id}:${draft || `${mode}:${name || 'default'}`}`;
}

/** Per-space fields inside otherwise global settings. Explicit empty audiences never mean all. */
function splitSettings(key: string, input: any): { shared: any; private: any } | null {
    if (key === 'os_user_location_privacy_v1') {
        const { characterIds, ...shared } = input;
        return { shared, private: { characterIds: characterIds ?? null } };
    }
    if (key === 'os_realtime_config') {
        const { weatherCities, ...shared } = input;
        return { shared, private: { weatherCities: weatherCities || {} } };
    }
    if (key === 'aetheros.mcp.servers' && Array.isArray(input)) {
        return { shared: input.map(({ charIds, ...s }) => s), private: Object.fromEntries(input.map(s => [s.id, s.charIds])) };
    }
    return null;
}
export function createSpaceStorage(storage: Storage, id: string): Storage {
    const changed = (key: string) => { if (id === SESSION_SPACE_ID) for (const listener of changeListeners) listener(key); };
    const keys = () => {
        const result: string[] = [];
        const prefix = `${PREFIX}${id}:`;
        for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i)!;
            if (isSharedSpaceKey(k)) result.push(k);
            else if (id === DEFAULT_SPACE_ID && !isInternalKey(k)) result.push(k);
            else if (id !== DEFAULT_SPACE_ID && k.startsWith(prefix)) result.push(k.slice(prefix.length));
        }
        return [...new Set(result)];
    };
    const view = {
        get length() { return keys().length; },
        key(index: number) { return keys()[index] ?? null; },
        getItem(key: string) {
            key = String(key);
            const value = storage.getItem(isSharedSpaceKey(key) ? key : privateKey(id, key));
            if (!value) return value;
            if (key === 'os_realtime_config' || key === 'aetheros.mcp.servers' || key === 'os_user_location_privacy_v1') {
                const parsed = JSON.parse(value);
                const own = storage.getItem(privateKey(id, `space_selection:${key}`));
                if (key === 'os_user_location_privacy_v1') {
                    const ids = own ? JSON.parse(own).characterIds : id === DEFAULT_SPACE_ID ? parsed.characterIds : [];
                    return JSON.stringify({ ...parsed, characterIds: ids === null ? undefined : ids });
                }
                if (key === 'os_realtime_config') return JSON.stringify({ ...parsed, weatherCities: own ? JSON.parse(own).weatherCities : id === DEFAULT_SPACE_ID ? parsed.weatherCities : {} });
                const selections = own ? JSON.parse(own) : null;
                return JSON.stringify(parsed.map((s: any) => ({ ...s, charIds: selections && Object.prototype.hasOwnProperty.call(selections, s.id) ? selections[s.id] : id === DEFAULT_SPACE_ID ? s.charIds : ['__space_unselected__'] })));
            }
            return value;
        },
        setItem(key: string, value: string) {
            assertUserSpaceAvailable(id);
            key = String(key); value = String(value);
            if (key === 'os_realtime_config' || key === 'aetheros.mcp.servers' || key === 'os_user_location_privacy_v1') {
                const parsed = JSON.parse(value), split = splitSettings(key, parsed);
                if (split) {
                    // Preserve legacy default-space selections before removing them from the global document.
                    if (id !== DEFAULT_SPACE_ID && !storage.getItem(`space_selection:${key}`)) {
                        const old = storage.getItem(key);
                        if (old) { const legacy = splitSettings(key, JSON.parse(old)); if (legacy) storage.setItem(`space_selection:${key}`, JSON.stringify(legacy.private)); }
                    }
                    storage.setItem(privateKey(id, `space_selection:${key}`), JSON.stringify(split.private));
                    storage.setItem(key, JSON.stringify(split.shared)); changed(key); return;
                }
            }
            storage.setItem(isSharedSpaceKey(key) ? key : privateKey(id, key), value);
            changed(key);
        },
        removeItem(key: string) { storage.removeItem(isSharedSpaceKey(key) ? key : privateKey(id, key)); changed(key); },
        clear() { for (const key of keys()) if (!isSharedSpaceKey(key)) storage.removeItem(privateKey(id, key)); changed('*'); },
    };
    return view as Storage;
}
export function installSpaceStorage() {
    if (typeof window === 'undefined' || !raw) return;
    // Hold a cross-tab lease for the page lifetime; deletion never races an open space.
    if (navigator.locks?.request) {
        void navigator.locks.request(userSpaceSessionLock(SESSION_SPACE_ID), { mode: 'shared' }, () =>
            new Promise<void>(() => { /* Released by the browser when this document is destroyed. */ }));
    }
    const view = createSpaceStorage(raw, SESSION_SPACE_ID);
    Object.defineProperty(window, 'localStorage', { configurable: true, value: view });
    const forwarded = new WeakSet<Event>();
    window.addEventListener('storage', event => {
        if (forwarded.has(event) || event.storageArea !== raw) return;
        const key = spaceStorageEventKey(event.key);
        event.stopImmediatePropagation();
        if (key === undefined) return;
        const next = new StorageEvent('storage', { key, oldValue: event.oldValue, newValue: key && isSharedSpaceKey(key) ? view.getItem(key) : event.newValue, storageArea: raw, url: event.url });
        forwarded.add(next); window.dispatchEvent(next);
    }, true);
}
/** Clear only this user's local data, keeping global settings and other users' drafts. */
export function clearUserSpaceLocal(id: string) {
    if (!raw) return;
    const keys = Array.from({ length: raw.length }, (_, i) => raw.key(i)!);
    for (const key of keys) {
        const own = id === DEFAULT_SPACE_ID
            ? !isInternalKey(key) && !isSharedSpaceKey(key) && !/^like520_cc_draft_k_u_[a-zA-Z0-9_-]+:/.test(key)
            : key.startsWith(`${PREFIX}${id}:`) || key.startsWith(`like520_cc_draft_k_${id}:`);
        if (own) raw.removeItem(key);
    }
    if (id === DEFAULT_SPACE_ID) for (const key of ['os_realtime_config', 'os_user_location_privacy_v1', 'aetheros.mcp.servers']) {
        const value = raw.getItem(key);
        if (value) { const split = splitSettings(key, JSON.parse(value)); if (split) raw.setItem(key, JSON.stringify(split.shared)); }
    }
}
export function readSpaceLocal(id: string): Record<string, string> {
    if (!raw) return {};
    const view = createSpaceStorage(raw, id);
    const data = Object.fromEntries(Array.from({ length: view.length }, (_, i) => view.key(i)!).filter(k => !isSharedSpaceKey(k)).map(k => [k, view.getItem(k)!]));
    for (const key of ['os_realtime_config', 'aetheros.mcp.servers']) {
        const value = view.getItem(key);
        if (value) data[`space_selection:${key}`] = JSON.stringify(splitSettings(key, JSON.parse(value))!.private);
    }
    return data;
}
export function sharedSettingForBackup(key: string, value: string): string {
    if (key === 'os_realtime_config' || key === 'aetheros.mcp.servers') return JSON.stringify(splitSettings(key, JSON.parse(value))!.shared);
    return value;
}
export function writeSpaceLocal(id: string, data: Record<string, string>) {
    if (!raw) return;
    const view = createSpaceStorage(raw, id);
    for (const [k, v] of Object.entries(data)) {
        if (isInternalKey(k) || isSharedSpaceKey(k) || typeof v !== 'string') continue;
        view.setItem(k, v);
    }
}
