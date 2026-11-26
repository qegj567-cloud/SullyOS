/**
 * 调试面板「假模型」区：把全局主对话 API 一键换成假模型（worker/fake-llm），再一键换回来。
 * 用法和取舍见 docs/fake-llm.md。
 *
 * 两条底线：
 * - 换过去、换回来都走设置页保存 API 的同一出口（updateApiConfig + 强制覆盖云端凭据），
 *   云端那台 Worker 才会跟着换；自己往 os_api_config 里写一份会绕过云端，测到的还是真 API。
 * - 用户的真实 Key 不能因为这个功能丢掉：换之前把连接字段整套备份，已经在假模型上切换场景时
 *   不覆盖备份；换回来写完之后才删备份。
 */
import type { APIConfig } from '../types';
import { syncAmsgLlmCredentials } from './amsgStateSync';
import { readStoredMainApi } from './apiSlots';
import { normalizeApiBaseUrl } from './apiConfigNormalize';

/**
 * 全局共用、不分分支：os_api_config 本身就是全局的，备份要跟它走同一套可见范围。
 * 按分支隔离的话，构建换了分支就再也看不到这份备份，等于把 Key 丢了。
 * 备份里有真 Key 且只对这台设备有意义，不进备份导出（userSpaceBackup.privateLocalExcluded）。
 */
export const FAKE_LLM_STORAGE_KEY = 'sullyos_dev_fake_llm_v1';
/** 假模型不校验 Key；固定值顺带用来认「现在是不是在假模型上」。 */
export const FAKE_LLM_API_KEY = 'fake-llm';
export const FAKE_LLM_MODEL_PREFIX = 'fake/';

/** 主对话的整套连接字段，跟 DialogueApiConfig 一致；语音、识图、情绪副 API 这些不归它管，不动。 */
const CONNECTION_FIELDS = ['baseUrl', 'apiKey', 'model', 'apiType', 'stream', 'temperature', 'maxTokens', 'presetId', 'presetFp'] as const;
type ConnectionFields = Pick<APIConfig, typeof CONNECTION_FIELDS[number]>;

export interface FakeLlmState {
    /** 上次填的假模型地址，例如 http://127.0.0.1:8791/v1 */
    url: string;
    backup?: { fields: ConnectionFields; savedAt: number };
}

type UpdateApiConfig = (updates: Partial<APIConfig>) => void;

export function readFakeLlmState(storage: Pick<Storage, 'getItem'> = localStorage): FakeLlmState {
    try {
        const parsed = JSON.parse(storage.getItem(FAKE_LLM_STORAGE_KEY) || 'null');
        if (parsed && typeof parsed.url === 'string') return parsed;
    } catch { /* 读不出来就当没有 */ }
    return { url: '' };
}

function writeFakeLlmState(state: FakeLlmState, storage: Pick<Storage, 'setItem'>): void {
    // 写不进去时宁可整个操作报错停下，也不能在没有备份的情况下把 API 换掉。
    storage.setItem(FAKE_LLM_STORAGE_KEY, JSON.stringify(state));
}

export const isOnFakeLlm = (api: Pick<APIConfig, 'apiKey' | 'model'>): boolean =>
    api.apiKey === FAKE_LLM_API_KEY && String(api.model || '').startsWith(FAKE_LLM_MODEL_PREFIX);

/** 和设置页 commitApiConfig 同一出口：用户亲手保存 API = 用本机配置直接覆盖云端凭据。 */
function commitMainApi(updateApiConfig: UpdateApiConfig, patch: Partial<APIConfig>): void {
    updateApiConfig(patch);
    const saved = readStoredMainApi();
    if (saved) syncAmsgLlmCredentials(saved);
}

export function switchToFakeLlm(
    current: APIConfig,
    url: string,
    model: string,
    updateApiConfig: UpdateApiConfig,
    storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): void {
    const baseUrl = normalizeApiBaseUrl(url);
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('假模型地址要以 http:// 或 https:// 开头');
    if (!model.startsWith(FAKE_LLM_MODEL_PREFIX)) throw new Error('先选一个场景');
    const state = readFakeLlmState(storage);
    // 已经在假模型上、只是换场景：留着第一次的备份。再备份一次就把假配置当成「原来的」了。
    const backup = isOnFakeLlm(current) && state.backup
        ? state.backup
        : { fields: Object.fromEntries(CONNECTION_FIELDS.map(k => [k, current[k]])) as ConnectionFields, savedAt: Date.now() };
    writeFakeLlmState({ url: baseUrl, backup }, storage);
    // apiType 写死 openai：原来是 Anthropic 原生时，不写的话地址会被规范成 /messages。
    commitMainApi(updateApiConfig, { baseUrl, apiKey: FAKE_LLM_API_KEY, model, apiType: 'openai' });
}

/** 换回备份里的那套。没有备份时什么都不做，返回 false。 */
export function restoreFromFakeLlm(
    updateApiConfig: UpdateApiConfig,
    storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
): boolean {
    const state = readFakeLlmState(storage);
    if (!state.backup) return false;
    // 原来没有的字段也要显式写 undefined，否则假模型那边留下的 apiType 会粘在恢复后的配置上。
    const patch = Object.fromEntries(CONNECTION_FIELDS.map(k => [k, state.backup!.fields[k]])) as Partial<APIConfig>;
    commitMainApi(updateApiConfig, patch);
    writeFakeLlmState({ url: state.url }, storage);
    return true;
}

/** 从假模型的 /models 拉场景列表；baseUrl 跟 App 拉模型列表一样直接拼 /models。 */
export async function fetchFakeLlmScenarios(url: string): Promise<string[]> {
    const res = await fetch(`${normalizeApiBaseUrl(url)}/models`, { headers: { Authorization: `Bearer ${FAKE_LLM_API_KEY}` } });
    if (!res.ok) throw new Error(`拉场景失败：HTTP ${res.status}`);
    const data = await res.json();
    const ids = Array.isArray(data?.data) ? data.data.map((m: any) => m?.id).filter((id: unknown) => typeof id === 'string') : [];
    return ids.filter((id: string) => id.startsWith(FAKE_LLM_MODEL_PREFIX));
}
