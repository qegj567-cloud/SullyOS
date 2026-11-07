import type { FullBackupData } from '../types';
import { blobToDataUrl } from './blobRef';
import { readBlobsIndex } from './backupBlobs';
import { restoreVoiceMessageBlobs } from './voiceMessageBackup';
import { restoreSARLocalBackup } from './vrWorld/sarBackup';
import { canMigrateLocalKey } from './independentUserImport';
import { importUserSpaces } from './userSpaceBackup';
import { STORY_THEATER_APPEARANCE_STORAGE_KEY } from './storyTheaterBackup';
import { restoreDecorationMedia } from './decorationMediaBackup';
import { createLocalId } from './localId';

// Legacy v1/v2/v3 names → the same stores used by DB.importFullData.
const tableFields: Partial<Record<keyof FullBackupData, string>> = {
    characters: 'characters', characterGroups: 'character_groups', messages: 'messages', groups: 'groups',
    customThemes: 'themes', savedEmojis: 'emojis', emojiCategories: 'emoji_categories', savedJournalStickers: 'journal_stickers',
    assets: 'assets', galleryImages: 'gallery', diaries: 'diaries', tasks: 'tasks', anniversaries: 'anniversaries',
    roomTodos: 'room_todos', roomNotes: 'room_notes', socialPosts: 'social_posts', courses: 'courses', games: 'games',
    worldbooks: 'worldbooks', storyTheaters: 'story_theaters', storyTheaterPresets: 'story_theater_presets', storyTheaterMasks: 'story_theater_masks',
    novels: 'novels', songs: 'songs', quizSessions: 'quizzes', guidebookSessions: 'guidebook', scheduledMessages: 'scheduled_messages',
    bankTransactions: 'bank_transactions', xhsActivities: 'xhs_activities', xhsOwnedPosts: 'xhs_owned_posts', xhsStockImages: 'xhs_stock',
    memoryNodes: 'memory_nodes', memoryVectors: 'memory_vectors', memoryLinks: 'memory_links', topicBoxes: 'topic_boxes',
    anticipations: 'anticipations', eventBoxes: 'event_boxes', roomPlates: 'room_plates', digestReports: 'digest_reports', memoryBatches: 'memory_batches',
    dailySchedules: 'daily_schedule', handbooks: 'handbook', trackers: 'trackers', trackerEntries: 'tracker_entries',
    lifeRecords: 'life_records', medPlans: 'med_plans', lifeRecordSettings: 'life_record_settings', hotNewsSnapshots: 'hotnews_snapshots',
    vrNovels: 'vr_novels', vrAnnotations: 'vr_annotations', customCreatorParts: 'cc_custom_parts', vrScripts: 'vr_scripts',
    vrStagedPlays: 'vr_plays', vrPresets: 'vr_presets', vrLetters: 'vr_letters', vrSettings: 'vr_settings',
    worlds: 'worlds', worldEpisodes: 'world_episodes', pixelHomeAssets: 'pixel_home_assets', pixelHomeLayouts: 'pixel_home_layouts',
    collaborationSessions: 'collab_sessions', collaborationMessages: 'collab_messages', collaborationCategories: 'collab_categories',
};

/** Read-only adapter: prepare an in-memory archive, then use the shared validated migration path. */
export async function importLegacyAsIndependentUser(data: FullBackupData, zip: any | null) {
    if (data.collaborationBackupMode === 'media_only' || !Array.isArray(data.characters)) {
        throw new Error('独立用户迁入需要整合或文字备份，媒体补图包不包含完整存档');
    }
    const files = new Map<string, string | Uint8Array>();
    let binaryCount = 0;
    const addBinary = (bytes: Uint8Array) => {
        const path = `shared/legacy_${binaryCount++}.bin`; files.set(path, bytes); return path;
    };
    const imageCache = new Map<string, string>();
    const encode = async (value: any): Promise<any> => {
        if (value instanceof Blob) return { __spaceBinary: addBinary(new Uint8Array(await value.arrayBuffer())), type: value.type };
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            return { __spaceBinary: addBinary(bytes), arrayType: value.constructor.name };
        }
        if (typeof value === 'string') {
            if (/^\s*[\[{]/.test(value)) {
                let parsed: any;
                try { parsed = JSON.parse(value); } catch { /* Keep ordinary text. */ }
                if (parsed && typeof parsed === 'object') {
                    const next = await encode(parsed);
                    return JSON.stringify(next) === JSON.stringify(parsed) ? value : JSON.stringify(next);
                }
            }
            if (!value.startsWith('assets/')) return value;
            if (imageCache.has(value)) return imageCache.get(value);
            const file = zip?.file(value);
            // Legacy backups may already contain missing inline files; keep their original reference.
            // A prose string beginning with assets/ is not by itself proof of an image reference.
            if (!file) return value;
            const extension = value.split('.').pop()?.toLowerCase();
            const type = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'gif' ? 'image/gif' : extension === 'webp' ? 'image/webp' : 'image/png';
            const restored = await blobToDataUrl(new Blob([await file.async('uint8array')], { type }));
            imageCache.set(value, restored); return restored;
        }
        if (Array.isArray(value)) { const out = []; for (const item of value) out.push(await encode(item)); return out; }
        if (value && typeof value === 'object') {
            const out: Record<string, any> = Object.create(null);
            for (const [key, item] of Object.entries(value)) out[key] = await encode(item);
            return out;
        }
        return value;
    };
    if (zip && data.assets) await restoreVoiceMessageBlobs(data.assets, async path => zip.file(path)?.async('uint8array') ?? null);
    const tables: Record<string, any[]> = Object.create(null);
    for (const [field, store] of Object.entries(tableFields)) {
        const rows = (data as any)[field];
        if (rows === undefined) continue;
        if (!Array.isArray(rows)) throw new Error(`备份数据表无效：${field}`);
        tables[store] = rows;
    }
    if (data.mediaAssets) tables.characters = tables.characters.map(char => {
        const media = data.mediaAssets!.find(item => item.charId === char.id);
        if (!media) return char;
        return { ...char, ...Object.fromEntries(['avatar', 'companionAvatar', 'companionTouchSettings', 'sprites', 'dateSkinSets', 'activeSkinSetId', 'customDateSprites', 'spriteConfig']
            .filter(key => (media as any)[key] !== undefined).map(key => [key, (media as any)[key]])),
            ...restoreDecorationMedia(media.decoration),
            chatBackground: media.backgrounds?.chat || char.chatBackground, dateBackground: media.backgrounds?.date || char.dateBackground,
            ...(char.roomConfig ? { roomConfig: { ...char.roomConfig, wallImage: media.backgrounds?.roomWall || char.roomConfig.wallImage,
                floorImage: media.backgrounds?.roomFloor || char.roomConfig.floorImage,
                items: char.roomConfig.items?.map((item: any) => ({ ...item, image: media.roomItems?.[item.id] || item.image })),
            } } : {}),
        };
    });
    if (data.userProfile) tables.user_profile = [{ ...data.userProfile, id: 'me' }];
    if (data.lifeSimState) tables.life_sim = [{ ...data.lifeSimState, id: 'main' }];
    if (data.vrMusicRoom) tables.vr_music = [{ ...data.vrMusicRoom, id: 'state' }];
    if (data.vrGuestbook) tables.vr_guestbook = [{ ...data.vrGuestbook, id: 'board' }];
    if (data.collaborationSettings) tables.collab_settings = [data.collaborationSettings];
    if (data.bankState || data.bankDollhouse) tables.bank_data = [
        ...(data.bankState ? [{ ...data.bankState, id: 'main_state' }] : []),
        ...(data.bankDollhouse ? [{ id: 'dollhouse_state', data: data.bankDollhouse }] : []),
    ];
    if (tables.memory_vectors) tables.memory_vectors = tables.memory_vectors.map(row => ({ ...row,
        vector: Array.isArray(row.vector) ? new Uint8Array(new Float32Array(row.vector).buffer) : row.vector,
    }));
    const assets = new Map((tables.assets || []).map(row => [row.id, row]));
    const saveAsset = (id: string, value: any, json = false) => { if (value !== undefined) assets.set(id, { id, data: json ? JSON.stringify(value) : value }); };
    for (const row of data.activityTextAssets || []) assets.set(row.id, row);
    saveAsset('friend_feed_v1', data.friendFeed, true);
    saveAsset('content_favorites_index_v1', data.contentFavoritesIndex);
    saveAsset('spark_social_profile', data.socialAppData?.userProfile, true);
    saveAsset('spark_user_bg', data.socialAppData?.userBg);
    saveAsset('room_custom_assets_list', data.roomCustomAssets?.map(item => ({ ...item, id: item.id || createLocalId(), visibility: item.visibility || 'public' })), true);
    saveAsset('wallpaper', data.theme?.wallpaper);
    saveAsset('lock_wallpaper', data.theme?.lockWallpaper);
    for (const [id, image] of Object.entries(data.customIcons || {})) saveAsset(`icon_${id}`, image);
    for (const preset of data.appearancePresets || []) saveAsset(`appearance_preset_${preset.id}`, preset, true);
    for (const [charId, hwm] of Object.entries(data.memoryPalaceHighWaterMarks || {})) saveAsset(`mp_hwm_v1_${charId}`, { version: 1, charId, msgId: hwm, updatedAt: Date.now() });
    tables.assets = [...assets.values()];

    const local: Record<string, string> = Object.create(null);
    const put = (key: string, value: unknown, json = false) => {
        if (value !== undefined && canMigrateLocalKey(key)) local[key] = json ? JSON.stringify(value) : String(value);
    };
    for (const field of ['vrPostOffice', 'vrSignal', 'worldHomeLocal', 'home3DLocal', 'desktopSkinLocal', 'memoryPalaceFlags', 'eventNotifFlags'] as const) {
        for (const [key, value] of Object.entries(data[field] || {})) if (typeof value === 'string') put(key, value);
    }
    for (const [key, value] of Object.entries(data.beautyPreferences?.values || {})) put(key, value, typeof value !== 'string');
    const localFields: Partial<Record<keyof FullBackupData, string>> = {
        theme: 'os_theme', scheduleAppTheme: 'schedule_app_theme', handbookLifestreamDepth: 'handbook_lifestream_depth',
        groupchatContextLimit: 'groupchat_context_limit', lastActiveCharId: 'os_last_active_char_id',
        dreamCollection: 'os_dream_collection', gotchiAccentHue: 'tama_accent_hue',
        chatTranslateSourceLang: 'chat_translate_source_lang', chatTranslateTargetLang: 'chat_translate_lang',
        chatArchivePrompts: 'chat_archive_prompts', chatActiveArchivePromptId: 'chat_active_archive_prompt_id',
        characterRefinePrompts: 'character_refine_prompts', characterActiveRefinePromptId: 'character_active_refine_prompt_id',
    };
    for (const [field, key] of Object.entries(localFields)) {
        const value = (data as any)[field]; put(key, value, !!value && typeof value === 'object');
    }
    const perCharacterFields: Partial<Record<keyof FullBackupData, string>> = {
        memoryPalaceHighWaterMarks: 'mp_lastMsgId_', chatTranslateEnabledByChar: 'chat_translate_enabled_',
        chatTranslateExpandedByChar: 'chat_translate_expanded_', chatTranslateSourceLangByChar: 'chat_translate_source_lang_',
        chatTranslateTargetLangByChar: 'chat_translate_lang_',
    };
    for (const [field, prefix] of Object.entries(perCharacterFields)) for (const [id, value] of Object.entries((data as any)[field] || {})) put(prefix + id, value);
    put('spark_char_handles', data.socialAppData?.charHandles, true);
    put('spark_user_id', data.socialAppData?.userId);
    put(STORY_THEATER_APPEARANCE_STORAGE_KEY, data.storyTheaterAppearance);
    restoreSARLocalBackup(data.sarLocalState, { replaceMissing: false }, { getItem: key => local[key] ?? null, setItem: (key, value) => put(key, value), removeItem: key => { delete local[key]; } });

    for (const asset of data.collaborationAssetIndex || []) {
        if (!asset.path?.startsWith('collaboration/assets/') || !zip?.file(asset.path)) throw new Error('备份协同文件缺失');
        const bytes = await zip.file(asset.path).async('uint8array');
        if (bytes.byteLength !== asset.size) throw new Error('备份协同文件不完整');
        (tables.collab_assets ||= []).push({ id: asset.id, createdAt: asset.createdAt, blob: new Blob([bytes], { type: asset.mimeType }) });
    }
    const stores: Record<string, string[]> = Object.create(null);
    for (const [store, rows] of Object.entries(tables)) {
        const path = `spaces/default/${store}.0.json`;
        files.set(path, JSON.stringify(await encode(rows))); stores[store] = [path];
    }
    const blobs = [];
    if (zip) for (const entry of await readBlobsIndex(zip)) {
        const bytes = await zip.file(`blobs/${entry.id}`).async('uint8array');
        if (bytes.byteLength !== entry.size) throw new Error('备份图片文件不完整');
        blobs.push({ ...entry, path: addBinary(bytes) });
    }
    files.set('user-spaces.json', JSON.stringify({ format: 'sully-user-spaces', version: 1,
        mode: data.collaborationBackupMode === 'text_only' ? 'text_only' : 'full',
        spaces: [{ id: 'default', name: data.userProfile?.name || '独立用户', local: await encode(local), stores }], settings: {}, blobs,
    }));
    return importUserSpaces({ file: (path: string) => files.has(path) ? {
        async: async (type: string) => {
            const value = files.get(path)!;
            return type === 'string' ? typeof value === 'string' ? value : new TextDecoder().decode(value)
                : typeof value === 'string' ? new TextEncoder().encode(value) : value;
        },
    } : null }, false, { asNewUsers: true });
}
