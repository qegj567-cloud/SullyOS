/**
 * 「彼方」独立 API 配置 + 调用记录。存于 IndexedDB（vr_settings store），
 * 随数据导出/备份一起走，不再依赖 localStorage。
 *
 * 彼方的角色会自主、频繁地登入触发 LLM 调用，比较费 API，所以允许用户单独
 * 指定一份 API（与聊天 App 共用同一批已保存的预设 os_api_presets，但选择独立）。
 * 不设则由调用用途决定：角色回复跟随角色默认再回退全局，系统任务继续使用全局。同时记录每次调用，方便对账。
 */
import type { APIConfig, DialogueApiConfig } from '../../types';
import { isBlankApiSlot, resolveEffectiveSlot } from '../apiSlots';
import { pickDialogueApi } from '../characterApi';
import { DB } from '../db';

export interface VRApiCall {
    ts: number;
    charName?: string;
    room?: string;
    model?: string;
    baseUrl?: string;
    ok: boolean;
    ms: number;
    error?: string;
    /** 角色 id。角色被删掉后名字就没了，靠它还能认出是谁的调度在动。 */
    charId?: string;
    /**
     * 这条记的是什么。省略 = 一次真实的模型调用。
     *   - `skipped`：调度到点了，但这一轮没走到模型（角色没接入、角色已删）
     *   - `throttled`：来得太密，被最小间隔闸拦下。出现这一行就说明有东西在催调度
     *   - `tripped`：连续失败攒够，自主登入被停掉
     */
    kind?: 'skipped' | 'throttled' | 'tripped';
    /** kind 非空时的一句话说明，直接显示给用户。 */
    note?: string;
    /**
     * 发起这次调用的**那一刻**读到的接入状态。
     *
     * 「界面上明明全关了，调用记录还在涨」这类反馈，光看请求本身分不清是谁的锅：
     * 是这一轮绕过了接入判断，还是界面和实际跑的是两份数据。把当时读到的值一起记下来，
     * 一眼就能分开。
     */
    charEnabled?: boolean;
}

// 旧版本曾把数据放在 localStorage，这里做一次性迁移到 IndexedDB。
const OLD_API_KEY = 'vr_world_api';
const OLD_LOG_KEY = 'vr_world_api_log';
let migrated = false;
async function migrateOnce(): Promise<void> {
    if (migrated) return;
    migrated = true;
    try {
        const oldApi = localStorage.getItem(OLD_API_KEY);
        if (oldApi) { await DB.saveVRApiConfig(JSON.parse(oldApi)); localStorage.removeItem(OLD_API_KEY); }
        const oldLog = localStorage.getItem(OLD_LOG_KEY);
        if (oldLog) { await DB.setVRApiLog(JSON.parse(oldLog)); localStorage.removeItem(OLD_LOG_KEY); }
    } catch { /* ignore */ }
}

/** 读取 IndexedDB 中保存的彼方原始 API 槽位（保留 presetId / presetFp，供设置面板展示绑定态）。 */
export async function getRawVRApiSlot(): Promise<DialogueApiConfig | null> {
    await migrateOnce();
    const raw = (await DB.getVRApiConfig()) as DialogueApiConfig | null;
    if (!raw || isBlankApiSlot(raw)) return null;
    return pickDialogueApi(raw);
}

/** 彼方独立 API（实时解析所绑预设最新值）；null = 由调用方按角色回复 / 系统任务规则选择。 */
export async function getVRApi(): Promise<APIConfig | null> {
    const raw = await getRawVRApiSlot();
    const resolved = resolveEffectiveSlot(raw);
    return resolved ? (resolved as APIConfig) : null;
}

export async function setVRApi(cfg: APIConfig | DialogueApiConfig | null): Promise<void> {
    const normalized = cfg && !isBlankApiSlot(cfg) ? pickDialogueApi(cfg) : null;
    await DB.saveVRApiConfig(normalized);
    try { window.dispatchEvent(new CustomEvent('vr-api-changed')); } catch { /* ignore */ }
}

export async function getVRApiLog(): Promise<VRApiCall[]> {
    await migrateOnce();
    return (await DB.getVRApiLog()) as VRApiCall[];
}

export async function logVRApiCall(entry: VRApiCall): Promise<void> {
    try {
        await DB.appendVRApiLog(entry);
        window.dispatchEvent(new CustomEvent('vr-api-log'));
    } catch { /* ignore */ }
}

export async function clearVRApiLog(): Promise<void> {
    await DB.clearVRApiLog();
    try { window.dispatchEvent(new CustomEvent('vr-api-log')); } catch { /* ignore */ }
}
