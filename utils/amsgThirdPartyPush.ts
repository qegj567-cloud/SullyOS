export type ThirdPartyPushProvider = 'wxpusher' | 'bark' | 'meow';

export type PushDeliveryMode = 'web-push' | 'third-party';

export interface ThirdPartyPushConfig {
    provider: ThirdPartyPushProvider;
    token: string;
    serverUrl?: string;
}

export interface ParsedThirdPartyPushEndpoint {
    provider: ThirdPartyPushProvider;
    token: string;
    serverOrigin: string;
}

export const DEFAULT_BARK_SERVER_ORIGIN = 'https://api.day.app';
export const DEFAULT_MEOW_SERVER_ORIGIN = 'https://api.chuckfang.com';
export const WXPUSHER_SIMPLE_PUSH_URL = 'https://wxpusher.zjiecode.com/api/send/message/simple-push';

export interface ThirdPartyPushProviderMeta {
    id: ThirdPartyPushProvider;
    label: string;
    shortLabel: string;
    badge: string;
    tokenLabel: string;
    tokenPlaceholder: string;
    supportsCustomServer: boolean;
    defaultServerOrigin?: string;
    helpText: string;
}

export const THIRD_PARTY_PUSH_PROVIDERS: readonly ThirdPartyPushProviderMeta[] = [
    {
        id: 'wxpusher',
        label: 'WxPusher（推荐）',
        shortLabel: 'WxPusher',
        badge: 'iOS / 安卓全厂牌 / 纯血鸿蒙',
        tokenLabel: 'SPT (Simple Push Token)',
        tokenPlaceholder: '例如：SPT_xxxxxxxxxxxxxxxxxxxxxxxx',
        supportsCustomServer: false,
        helpText: '支持 iOS、安卓各家系统级推送与纯血鸿蒙（HarmonyOS NEXT），个人免费且无需科学上网。在 WxPusher App 或公众号获取 SPT_ 开头的极简推送 Token 填入即可。',
    },
    {
        id: 'bark',
        label: 'Bark（支持角色头像）',
        shortLabel: 'Bark',
        badge: 'iOS 锁屏显示角色头像',
        tokenLabel: 'Device Key 或推送 URL',
        tokenPlaceholder: '例如：AbCdEfGh123456 或 https://api.day.app/AbCdEfGh123456/',
        supportsCustomServer: true,
        defaultServerOrigin: DEFAULT_BARK_SERVER_ORIGIN,
        helpText: '专为 iOS 打造（走苹果 APNs），支持在锁屏通知横幅上直接显示角色头像（需角色头像为公开 http/https 链接）。直接粘贴 Bark 首页复制的链接或 Device Key 即可。',
    },
    {
        id: 'meow',
        label: 'MeoW（纯血鸿蒙备用）',
        shortLabel: 'MeoW',
        badge: '纯血鸿蒙 / iOS / 安卓备用',
        tokenLabel: '昵称 (Nickname) 或推送 URL',
        tokenPlaceholder: '例如：my_nickname 或 https://api.chuckfang.com/my_nickname/',
        supportsCustomServer: true,
        defaultServerOrigin: DEFAULT_MEOW_SERVER_ORIGIN,
        helpText: '针对纯血鸿蒙（HarmonyOS NEXT）用户的备用推送通道，打开 MeoW App 设置好昵称后填入即可。',
    },
] as const;

export function getThirdPartyPushProviderMeta(provider?: string | null): ThirdPartyPushProviderMeta {
    const found = THIRD_PARTY_PUSH_PROVIDERS.find(item => item.id === provider);
    return found || THIRD_PARTY_PUSH_PROVIDERS[0];
}

function normalizeServerOrigin(raw: string | undefined, fallback: string): string {
    const trimmed = (raw || '').trim().replace(/\/+$/, '');
    if (!trimmed) return fallback;
    try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return fallback;
        }
        const cleanPath = parsed.pathname.replace(/\/+$/, '');
        return `${parsed.origin}${cleanPath}`;
    } catch {
        return fallback;
    }
}

/**
 * Normalize user input where they might paste either a raw token/key or a full URL
 * copied directly from the WxPusher / Bark / MeoW app.
 */
export function normalizeThirdPartyPushConfig(config: ThirdPartyPushConfig): {
    provider: ThirdPartyPushProvider;
    token: string;
    serverOrigin: string;
} {
    const provider: ThirdPartyPushProvider =
        config.provider === 'bark' || config.provider === 'meow' ? config.provider : 'wxpusher';
    const rawToken = (config.token || '').trim();

    if (provider === 'wxpusher') {
        const sptMatch = rawToken.match(/SPT_[A-Za-z0-9_-]+/);
        const token = sptMatch ? sptMatch[0] : rawToken.replace(/^wxpusher:/i, '').trim();
        return {
            provider: 'wxpusher',
            token,
            serverOrigin: 'https://wxpusher.zjiecode.com',
        };
    }

    const defaultOrigin = provider === 'bark' ? DEFAULT_BARK_SERVER_ORIGIN : DEFAULT_MEOW_SERVER_ORIGIN;
    const strippedPrefix = rawToken.replace(/^(bark|meow):/i, '').trim();

    if (/^https?:\/\//i.test(strippedPrefix)) {
        try {
            const parsed = new URL(strippedPrefix);
            const segments = parsed.pathname.split('/').map(s => s.trim()).filter(Boolean);
            if (segments.length > 0) {
                const token = decodeURIComponent(segments[0]);
                const customOrigin = config.serverUrl?.trim()
                    ? normalizeServerOrigin(config.serverUrl, parsed.origin)
                    : parsed.origin;
                return {
                    provider,
                    token,
                    serverOrigin: customOrigin,
                };
            }
        } catch {
            // Fall through to raw token handling
        }
    }

    const token = strippedPrefix.replace(/^\/+|\/+$/g, '').split('/')[0]?.trim() || '';
    const serverOrigin = normalizeServerOrigin(config.serverUrl, defaultOrigin);
    return {
        provider,
        token,
        serverOrigin,
    };
}

export function validateThirdPartyPushConfig(config?: Partial<ThirdPartyPushConfig> | null): {
    ok: boolean;
    error?: string;
    normalized?: { provider: ThirdPartyPushProvider; token: string; serverOrigin: string };
} {
    if (!config || !config.provider) {
        return { ok: false, error: '请选择第三方推送平台' };
    }
    const normalized = normalizeThirdPartyPushConfig({
        provider: config.provider,
        token: config.token || '',
        serverUrl: config.serverUrl,
    });

    if (!normalized.token) {
        if (normalized.provider === 'wxpusher') {
            return { ok: false, error: '请填写 WxPusher 的 SPT (Simple Push Token)' };
        }
        if (normalized.provider === 'bark') {
            return { ok: false, error: '请填写 Bark 的 Device Key 或推送链接' };
        }
        return { ok: false, error: '请填写 MeoW 的昵称或推送链接' };
    }

    if (normalized.provider === 'wxpusher' && !/^SPT_[A-Za-z0-9_-]{6,}$/.test(normalized.token)) {
        return {
            ok: false,
            error: 'WxPusher 极简推送 Token 应以 SPT_ 开头（例如 SPT_xxxxxx）',
        };
    }

    return { ok: true, normalized };
}

export function buildThirdPartyPushEndpoint(config: ThirdPartyPushConfig): string {
    const validation = validateThirdPartyPushConfig(config);
    if (!validation.ok || !validation.normalized) {
        throw new Error(validation.error || '第三方推送配置无效');
    }
    const { provider, token, serverOrigin } = validation.normalized;
    if (provider === 'wxpusher') {
        return `wxpusher:${token}`;
    }
    return `${provider}:${serverOrigin}/${encodeURIComponent(token)}`;
}

export function parseThirdPartyPushEndpoint(endpoint: string | undefined | null): ParsedThirdPartyPushEndpoint | null {
    const raw = (endpoint || '').trim();
    if (!raw) return null;

    if (raw.startsWith('wxpusher:')) {
        const token = raw.slice('wxpusher:'.length).trim();
        if (!token) return null;
        return {
            provider: 'wxpusher',
            token,
            serverOrigin: 'https://wxpusher.zjiecode.com',
        };
    }

    const match = raw.match(/^(bark|meow):(https?:\/\/.+)\/([^/?#]+)\/?$/i);
    if (!match) return null;

    const provider = match[1].toLowerCase() as 'bark' | 'meow';
    const serverOrigin = match[2].replace(/\/+$/, '');
    let token = '';
    try {
        token = decodeURIComponent(match[3]).trim();
    } catch {
        token = match[3].trim();
    }
    if (!token) return null;

    return {
        provider,
        token,
        serverOrigin,
    };
}

export function isThirdPartyPushEndpoint(endpoint: string | undefined | null): boolean {
    return parseThirdPartyPushEndpoint(endpoint) !== null;
}

export function buildThirdPartyClickUrl(baseUrl?: string | null, charId?: string | null): string | undefined {
    const raw = (baseUrl || '').trim();
    if (!raw || !/^https?:\/\//i.test(raw)) return undefined;
    try {
        const parsed = new URL(raw);
        if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
            return undefined;
        }
        const trimmedCharId = (charId || '').trim();
        if (trimmedCharId) {
            parsed.searchParams.set('openApp', 'chat');
            parsed.searchParams.set('activeMsgCharId', trimmedCharId);
        }
        return parsed.toString();
    } catch {
        return undefined;
    }
}
