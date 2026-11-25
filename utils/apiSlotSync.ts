/**
 * API 预设引用的全站盘点、跨空间快照刷新与存量配置自动绑定。
 *
 * 规则：
 * 1. 修改某条预设后，刷新所有绑定它的槽位的内联快照与 presetFp（当前空间 + 其他用户空间），
 *    保证退回正式版、删除预设或离线导出备份时，内联快照始终是最新的有效值。
 * 2. 批量刷新角色快照时直接写库，不逐条走 updateCharacter 触发云端风暴；全部刷完后由调用方
 *    合并触发一次主动消息 2.0 云端凭据同步。
 */

import type { APIConfig, ApiPreset, CharacterProfile, DialogueApiConfig, LifeSimState } from '../types';
import { openCollaborationSpace } from '../features/collaboration/store';
import type { CollaborationApiProfile, CollaborationSettings } from '../features/collaboration/types';
import {
  autoBindUniquePreset,
  computeSlotPresetFp,
  isBlankApiSlot,
  slotFromPreset,
} from './apiSlots';
import { DB, openDB, openSpaceDB } from './db';
import { isUserSpaceDeleting, listUserSpaces, SESSION_SPACE_ID } from './userSpaces';

const CHECK_PHONE_LS_KEY = 'check_phone_api';
const WORLD_HOME_LS_KEY = 'world_home_api';
const STUDY_API_LS_KEY = 'study_api_config';
const FRIEND_FEED_ASSET_ID = 'friend_feed_api';

export function isSlotActivelyBoundToPreset(
  slot: Partial<DialogueApiConfig> | null | undefined,
  presetId: string,
): boolean {
  if (!slot || !presetId || slot.presetId !== presetId) return false;
  if (!slot.presetFp) return true;
  return slot.presetFp === computeSlotPresetFp({
    baseUrl: String(slot.baseUrl ?? ''),
    apiKey: String(slot.apiKey ?? ''),
    model: String(slot.model ?? ''),
    apiType: slot.apiType,
  });
}

function isCollabProfileBoundToPreset(
  profile: CollaborationApiProfile | undefined,
  presetId: string,
): boolean {
  if (!profile || !presetId) return false;
  if (profile.source === 'preset' && profile.sourceId === presetId) return true;
  return isSlotActivelyBoundToPreset(profile, presetId);
}

function readJsonKey<T>(key: string): T | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJsonKey(key: string, value: unknown): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // 存储不可写时保持内存流程不中断。
  }
}

function idbGet<T>(db: IDBDatabase, storeName: string, key: IDBValidKey): Promise<T | undefined> {
  if (!db.objectStoreNames.contains(storeName)) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  if (!db.objectStoreNames.contains(storeName)) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve((req.result as T[]) || []);
    req.onerror = () => reject(req.error);
  });
}

function idbPutMany<T>(db: IDBDatabase, storeName: string, items: T[]): Promise<void> {
  if (items.length === 0 || !db.objectStoreNames.contains(storeName)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const item of items) store.put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export interface PresetUsageSummary {
  /** 当前空间与全局共用入口的可读名称列表。 */
  currentSpaceLabels: string[];
  /** 其他用户空间中引用该预设的槽位总数（不跨空间泄漏私人角色名）。 */
  otherSpacesCount: number;
  /** 全站总引用数。 */
  totalCount: number;
}

export async function collectPresetUsageSummary(
  presetId: string,
  context: {
    apiConfig: APIConfig;
    memoryLightLlm?: Partial<DialogueApiConfig> | null;
    characters: readonly CharacterProfile[];
  },
): Promise<PresetUsageSummary> {
  if (!presetId) return { currentSpaceLabels: [], otherSpacesCount: 0, totalCount: 0 };
  const labels: string[] = [];

  if (isSlotActivelyBoundToPreset(context.apiConfig, presetId)) labels.push('全局主对话');
  if (isSlotActivelyBoundToPreset(context.apiConfig.visionApi, presetId)) labels.push('独立识图');
  if (isSlotActivelyBoundToPreset(context.memoryLightLlm, presetId)) labels.push('记忆宫殿副 API');
  if (isSlotActivelyBoundToPreset(context.apiConfig.emotionApi, presetId)) labels.push('情绪副 API');
  if (isSlotActivelyBoundToPreset(context.apiConfig.thinkingTranslationApi, presetId)) labels.push('心象翻译');

  for (const char of context.characters) {
    if (isSlotActivelyBoundToPreset(char.dialogueApi, presetId)) {
      labels.push(`角色「${char.name || '未命名'}」`);
    }
  }

  const checkPhone = readJsonKey<DialogueApiConfig>(CHECK_PHONE_LS_KEY);
  if (isSlotActivelyBoundToPreset(checkPhone, presetId)) labels.push('查手机');

  const worldHome = readJsonKey<DialogueApiConfig>(WORLD_HOME_LS_KEY);
  if (isSlotActivelyBoundToPreset(worldHome, presetId)) labels.push('家园');

  const study = readJsonKey<DialogueApiConfig>(STUDY_API_LS_KEY);
  if (isSlotActivelyBoundToPreset(study, presetId)) labels.push('自习室');

  // 当前空间 IndexedDB 中的独立 App 配置
  try {
    const db = await openDB();
    const [friendAsset, vrRow, lifeSimRow] = await Promise.all([
      idbGet<{ id: string; data?: string }>(db, 'assets', FRIEND_FEED_ASSET_ID).catch(() => undefined),
      idbGet<{ id: string; config?: DialogueApiConfig | null }>(db, 'vr_settings', 'api').catch(() => undefined),
      idbGet<LifeSimState>(db, 'life_sim', 'main').catch(() => undefined),
    ]);
    if (friendAsset?.data) {
      try {
        const parsed = JSON.parse(friendAsset.data) as DialogueApiConfig | null;
        if (isSlotActivelyBoundToPreset(parsed, presetId)) labels.push('哔哔');
      } catch { /* ignore */ }
    }
    if (isSlotActivelyBoundToPreset(vrRow?.config, presetId)) labels.push('彼方');
    if (isSlotActivelyBoundToPreset(lifeSimRow?.independentApiConfig, presetId)) labels.push('模拟人生');
  } catch {
    // 测试或无 IDB 环境静默跳过
  }

  try {
    const collabDb = await openCollaborationSpace(SESSION_SPACE_ID);
    const collabSettings = await idbGet<CollaborationSettings>(collabDb, 'settings', 'main').catch(() => undefined);
    if (isCollabProfileBoundToPreset(collabSettings?.immersive, presetId)) labels.push('协同工作（沉浸式）');
    if (isCollabProfileBoundToPreset(collabSettings?.focused, presetId)) labels.push('协同工作（中度）');
  } catch {
    // 忽略无 IDB 环境
  }

  let otherSpacesCount = 0;
  try {
    const otherSpaces = listUserSpaces().filter((s) => s.id !== SESSION_SPACE_ID && !isUserSpaceDeleting(s.id));
    for (const space of otherSpaces) {
      try {
        const db = await openSpaceDB(space.id);
        const [chars, friendAsset, vrRow, lifeSimRow] = await Promise.all([
          idbGetAll<CharacterProfile>(db, 'characters').catch(() => []),
          idbGet<{ id: string; data?: string }>(db, 'assets', FRIEND_FEED_ASSET_ID).catch(() => undefined),
          idbGet<{ id: string; config?: DialogueApiConfig | null }>(db, 'vr_settings', 'api').catch(() => undefined),
          idbGet<LifeSimState>(db, 'life_sim', 'main').catch(() => undefined),
        ]);
        otherSpacesCount += chars.filter((c) => isSlotActivelyBoundToPreset(c.dialogueApi, presetId)).length;
        if (friendAsset?.data) {
          try {
            if (isSlotActivelyBoundToPreset(JSON.parse(friendAsset.data), presetId)) otherSpacesCount += 1;
          } catch { /* ignore */ }
        }
        if (isSlotActivelyBoundToPreset(vrRow?.config, presetId)) otherSpacesCount += 1;
        if (isSlotActivelyBoundToPreset(lifeSimRow?.independentApiConfig, presetId)) otherSpacesCount += 1;
      } catch { /* ignore single space error */ }

      try {
        const collabDb = await openCollaborationSpace(space.id);
        const collabSettings = await idbGet<CollaborationSettings>(collabDb, 'settings', 'main').catch(() => undefined);
        if (isCollabProfileBoundToPreset(collabSettings?.immersive, presetId)) otherSpacesCount += 1;
        if (isCollabProfileBoundToPreset(collabSettings?.focused, presetId)) otherSpacesCount += 1;
      } catch { /* ignore */ }
    }
  } catch {
    // 忽略
  }

  return {
    currentSpaceLabels: labels,
    otherSpacesCount,
    totalCount: labels.length + otherSpacesCount,
  };
}

function refreshCollabProfileSnapshot(
  profile: CollaborationApiProfile,
  preset: ApiPreset,
): CollaborationApiProfile {
  const nextSlot = slotFromPreset(preset);
  return {
    ...profile,
    apiType: nextSlot.apiType,
    baseUrl: nextSlot.baseUrl,
    apiKey: nextSlot.apiKey,
    model: nextSlot.model,
    maxTokens: nextSlot.maxTokens,
    source: 'preset',
    sourceId: preset.id,
    sourceName: preset.name,
    presetId: preset.id,
    presetFp: nextSlot.presetFp,
  };
}

async function refreshSpaceIdbSnapshots(spaceId: string, preset: ApiPreset): Promise<CharacterProfile[] | null> {
  const nextSlot = slotFromPreset(preset);
  let updatedCurrentChars: CharacterProfile[] | null = null;

  try {
    const db = spaceId === SESSION_SPACE_ID ? await openDB() : await openSpaceDB(spaceId);
    const chars = await idbGetAll<CharacterProfile>(db, 'characters').catch(() => []);
    const dirtyChars: CharacterProfile[] = [];
    const nextChars = chars.map((char) => {
      if (!isSlotActivelyBoundToPreset(char.dialogueApi, preset.id)) return char;
      const updated: CharacterProfile = { ...char, dialogueApi: nextSlot };
      dirtyChars.push(updated);
      return updated;
    });
    if (dirtyChars.length > 0) {
      await idbPutMany(db, 'characters', dirtyChars);
      if (spaceId === SESSION_SPACE_ID) updatedCurrentChars = nextChars;
    }

    const friendAsset = await idbGet<{ id: string; data?: string }>(db, 'assets', FRIEND_FEED_ASSET_ID).catch(() => undefined);
    if (friendAsset?.data) {
      try {
        const parsed = JSON.parse(friendAsset.data) as DialogueApiConfig | null;
        if (isSlotActivelyBoundToPreset(parsed, preset.id)) {
          await idbPutMany(db, 'assets', [{ id: FRIEND_FEED_ASSET_ID, data: JSON.stringify(nextSlot) }]);
        }
      } catch { /* ignore */ }
    }

    const vrRow = await idbGet<{ id: string; config?: DialogueApiConfig | null }>(db, 'vr_settings', 'api').catch(() => undefined);
    if (isSlotActivelyBoundToPreset(vrRow?.config, preset.id)) {
      await idbPutMany(db, 'vr_settings', [{ id: 'api', config: nextSlot }]);
      if (spaceId === SESSION_SPACE_ID && typeof window !== 'undefined') {
        try { window.dispatchEvent(new CustomEvent('vr-api-changed')); } catch { /* ignore */ }
      }
    }

    const lifeSimRow = await idbGet<LifeSimState & { id?: string }>(db, 'life_sim', 'main').catch(() => undefined);
    if (lifeSimRow && isSlotActivelyBoundToPreset(lifeSimRow.independentApiConfig, preset.id)) {
      await idbPutMany(db, 'life_sim', [{ ...lifeSimRow, id: 'main', independentApiConfig: nextSlot }]);
    }
  } catch (err) {
    console.warn(`[apiSlotSync] 空间 ${spaceId} 刷新预设快照跳过`, err);
  }

  try {
    const collabDb = await openCollaborationSpace(spaceId);
    const collabSettings = await idbGet<CollaborationSettings>(collabDb, 'settings', 'main').catch(() => undefined);
    if (collabSettings) {
      const immBound = isCollabProfileBoundToPreset(collabSettings.immersive, preset.id);
      const focBound = isCollabProfileBoundToPreset(collabSettings.focused, preset.id);
      if (immBound || focBound) {
        await idbPutMany(collabDb, 'settings', [{
          ...collabSettings,
          id: 'main',
          immersive: immBound ? refreshCollabProfileSnapshot(collabSettings.immersive, preset) : collabSettings.immersive,
          focused: focBound ? refreshCollabProfileSnapshot(collabSettings.focused, preset) : collabSettings.focused,
          updatedAt: Date.now(),
        }]);
      }
    }
  } catch {
    // 忽略协同库未初始化或不可用
  }

  return updatedCurrentChars;
}

/**
 * 预设被编辑保存后，刷新全站所有绑定该预设 ID 的内联快照（含 localStorage 单例与多用户空间 IndexedDB）。
 * 返回当前空间的最新角色列表（若当前空间有角色绑定了该预设），供 OSContext 更新内存 state。
 */
export async function refreshPresetSnapshotsEverywhere(preset: ApiPreset): Promise<{
  updatedCurrentCharacters: CharacterProfile[] | null;
}> {
  const nextSlot = slotFromPreset(preset);

  for (const key of [CHECK_PHONE_LS_KEY, WORLD_HOME_LS_KEY, STUDY_API_LS_KEY]) {
    const stored = readJsonKey<DialogueApiConfig>(key);
    if (isSlotActivelyBoundToPreset(stored, preset.id)) {
      writeJsonKey(key, nextSlot);
    }
  }

  const updatedCurrentCharacters = await refreshSpaceIdbSnapshots(SESSION_SPACE_ID, preset);

  try {
    const otherSpaces = listUserSpaces().filter((s) => s.id !== SESSION_SPACE_ID && !isUserSpaceDeleting(s.id));
    await Promise.all(otherSpaces.map((s) => refreshSpaceIdbSnapshots(s.id, preset)));
  } catch {
    // 其他空间尽力刷新，不阻断当前操作
  }

  if (typeof window !== 'undefined') {
    try {
      window.dispatchEvent(new CustomEvent('sully:api-preset-updated', { detail: { presetId: preset.id } }));
    } catch { /* ignore */ }
  }

  return { updatedCurrentCharacters };
}

/**
 * 从存量角色列表中提取出现次数最多的情绪副 API，供升级后首次收敛至全局 apiConfig.emotionApi。
 * 不删除角色身上的旧字段，保证正式版仍可正常读取。
 */
export function pickMigratedGlobalEmotionApi(
  characters: readonly CharacterProfile[],
  presets: readonly ApiPreset[],
): DialogueApiConfig | undefined {
  const counts = new Map<string, { count: number; slot: DialogueApiConfig }>();
  for (const char of characters) {
    const raw = char.emotionConfig?.api;
    if (!raw || isBlankApiSlot(raw)) continue;
    const slot: DialogueApiConfig = {
      baseUrl: raw.baseUrl,
      apiKey: raw.apiKey,
      model: raw.model,
    };
    const key = `${slot.baseUrl.trim()}\0${slot.apiKey.trim()}\0${slot.model.trim()}`;
    const prev = counts.get(key);
    if (prev) prev.count += 1;
    else counts.set(key, { count: 1, slot });
  }
  if (counts.size === 0) return undefined;
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0].slot;
  return autoBindUniquePreset(best, presets, { credentialsOnly: true })?.slot ?? best;
}

/**
 * 启动时对全局 localStorage 中的附属槽位与当前空间 IndexedDB 槽位做一次幂等的「唯一匹配预设自动挂接」。
 * 仅在没有 presetId 且严格命中唯一一条预设时才补写引用，不改变任何有效请求参数。
 */
export async function autoBindLegacyStorageSlotsOnce(presets: readonly ApiPreset[]): Promise<{
  updatedCharacters: CharacterProfile[] | null;
}> {
  if (presets.length === 0) return { updatedCharacters: null };

  for (const key of [CHECK_PHONE_LS_KEY, WORLD_HOME_LS_KEY, STUDY_API_LS_KEY]) {
    const stored = readJsonKey<DialogueApiConfig>(key);
    if (stored && !stored.presetId && !isBlankApiSlot(stored)) {
      const bound = autoBindUniquePreset(stored, presets, { credentialsOnly: true });
      if (bound?.boundPresetId) writeJsonKey(key, bound.slot);
    }
  }

  let updatedCharacters: CharacterProfile[] | null = null;
  try {
    const db = await openDB();
    const chars = await idbGetAll<CharacterProfile>(db, 'characters').catch(() => []);
    const dirtyChars: CharacterProfile[] = [];
    const nextChars = chars.map((char) => {
      if (!char.dialogueApi || char.dialogueApi.presetId || isBlankApiSlot(char.dialogueApi)) return char;
      const bound = autoBindUniquePreset(char.dialogueApi, presets);
      if (!bound?.boundPresetId) return char;
      const updated = { ...char, dialogueApi: bound.slot };
      dirtyChars.push(updated);
      return updated;
    });
    if (dirtyChars.length > 0) {
      await idbPutMany(db, 'characters', dirtyChars);
      updatedCharacters = nextChars;
    }

    const friendAsset = await idbGet<{ id: string; data?: string }>(db, 'assets', FRIEND_FEED_ASSET_ID).catch(() => undefined);
    if (friendAsset?.data) {
      try {
        const parsed = JSON.parse(friendAsset.data) as DialogueApiConfig | null;
        if (parsed && !parsed.presetId && !isBlankApiSlot(parsed)) {
          const bound = autoBindUniquePreset(parsed, presets);
          if (bound?.boundPresetId) {
            await idbPutMany(db, 'assets', [{ id: FRIEND_FEED_ASSET_ID, data: JSON.stringify(bound.slot) }]);
          }
        }
      } catch { /* ignore */ }
    }

    const vrRow = await idbGet<{ id: string; config?: DialogueApiConfig | null }>(db, 'vr_settings', 'api').catch(() => undefined);
    if (vrRow?.config && !vrRow.config.presetId && !isBlankApiSlot(vrRow.config)) {
      const bound = autoBindUniquePreset(vrRow.config, presets, { credentialsOnly: true });
      if (bound?.boundPresetId) {
        await idbPutMany(db, 'vr_settings', [{ id: 'api', config: bound.slot }]);
      }
    }

    const lifeSimRow = await idbGet<LifeSimState & { id?: string }>(db, 'life_sim', 'main').catch(() => undefined);
    if (lifeSimRow?.independentApiConfig && !lifeSimRow.independentApiConfig.presetId && !isBlankApiSlot(lifeSimRow.independentApiConfig)) {
      const bound = autoBindUniquePreset(lifeSimRow.independentApiConfig as DialogueApiConfig, presets, { credentialsOnly: true });
      if (bound?.boundPresetId) {
        await idbPutMany(db, 'life_sim', [{ ...lifeSimRow, id: 'main', independentApiConfig: bound.slot }]);
      }
    }
  } catch {
    // 无 IDB 环境静默跳过
  }

  return { updatedCharacters };
}
