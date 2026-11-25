import type { APIConfig, DialogueApiConfig } from '../types';
import { isBlankApiSlot, resolveEffectiveSlot, resolveGlobalMainApi } from './apiSlots';
import { pickDialogueApi } from './characterApi';

const STORAGE_KEY = 'check_phone_api';

/** 读取查手机原始 API 槽位（保留 presetId / presetFp，供设置面板展示绑定态）。 */
export function getRawCheckPhoneApiSlot(): DialogueApiConfig | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<DialogueApiConfig> | null;
        if (!parsed || isBlankApiSlot(parsed)) return null;
        return pickDialogueApi(parsed as DialogueApiConfig);
    } catch {
        return null;
    }
}

/** 查手机 App 独立 API（实时解析所绑预设最新值）；null 表示跟随聊天默认。 */
export function getCheckPhoneApi(): APIConfig | null {
    const resolved = resolveEffectiveSlot(getRawCheckPhoneApiSlot());
    return resolved?.baseUrl ? (resolved as APIConfig) : null;
}

export function setCheckPhoneApi(config: DialogueApiConfig | APIConfig | null | undefined): void {
    try {
        if (!config || isBlankApiSlot(config)) {
            localStorage.removeItem(STORAGE_KEY);
        } else {
            const picked = pickDialogueApi(config as DialogueApiConfig);
            if (!picked.baseUrl) localStorage.removeItem(STORAGE_KEY);
            else localStorage.setItem(STORAGE_KEY, JSON.stringify(picked));
        }
        window.dispatchEvent(new CustomEvent('check-phone-api-changed'));
    } catch { /* localStorage may be unavailable in private/restricted contexts */ }
}

export function resolveCheckPhoneApi(independent: APIConfig | null, chatDefault: APIConfig): APIConfig {
    return independent?.baseUrl ? independent : resolveGlobalMainApi(chatDefault);
}

