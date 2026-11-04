/** Capacitor 原生 FCM 通道与第三方推送 App（WxPusher / Bark / MeoW）通道；普通 Web Push endpoint 完整委托给既有发送器。 */

import {
  buildThirdPartyClickUrl,
  parseThirdPartyPushEndpoint,
  WXPUSHER_SIMPLE_PUSH_URL,
  type ParsedThirdPartyPushEndpoint,
} from '../../../utils/amsgThirdPartyPush';

export interface NativeFcmEnv {
  FCM_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT_EMAIL?: string;
  FCM_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
}

interface PushTransport {
  sendNotification(subscription: any, payload: string): Promise<any>;
}

let accessTokenCache: { key: string; token: string; expiresAt: number } | null = null;
const utf8 = new TextEncoder();

const bytesToB64u = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const textToB64u = (value: string): string => bytesToB64u(utf8.encode(value));

const pemToPkcs8 = (raw: string): ArrayBuffer => {
  const base64 = raw.replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!base64) throw new Error('FCM_SERVICE_ACCOUNT_PRIVATE_KEY 不是有效的 PKCS#8 PEM');
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
};

const requireFcmConfig = (env: NativeFcmEnv) => {
  const projectId = env.FCM_PROJECT_ID?.trim();
  const clientEmail = env.FCM_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKey = env.FCM_SERVICE_ACCOUNT_PRIVATE_KEY?.trim();
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('FCM 配置不完整：需要 FCM_PROJECT_ID / FCM_SERVICE_ACCOUNT_EMAIL / FCM_SERVICE_ACCOUNT_PRIVATE_KEY');
  }
  return { projectId, clientEmail, privateKey };
};

const fetchFcmAccessToken = async (env: NativeFcmEnv): Promise<string> => {
  const config = requireFcmConfig(env);
  const cacheKey = `${config.projectId}:${config.clientEmail}`;
  if (accessTokenCache?.key === cacheKey && accessTokenCache.expiresAt > Date.now() + 60_000) {
    return accessTokenCache.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${textToB64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${textToB64u(JSON.stringify({
    iss: config.clientEmail,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToPkcs8(config.privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8.encode(unsigned));
  const assertion = `${unsigned}.${bytesToB64u(new Uint8Array(signature))}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
    }),
  });
  const body = await response.json().catch(() => ({})) as {
    access_token?: string; expires_in?: number; error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new Error(`FCM OAuth 失败 (${response.status})：${body.error_description || '没有 access_token'}`);
  }
  accessTokenCache = {
    key: cacheKey,
    token: body.access_token,
    expiresAt: Date.now() + Math.max(300, Number(body.expires_in) || 3600) * 1000,
  };
  return body.access_token;
};

export const fcmTokenFromEndpoint = (endpoint: unknown): string | null => {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('fcm:')) return null;
  return endpoint.slice(4).trim() || null;
};

/** notification 承载正文、data 承载其余 AMSG2 结构，避免正文重复两份顶穿 4KB。 */
export const buildFcmMessage = (token: string, rawPayload: string) => {
  const payload = JSON.parse(rawPayload) as Record<string, any>;
  const actualBody = String(payload.message ?? payload.body ?? '');
  const portable = { ...payload };
  delete portable.message;
  delete portable.body;
  delete portable.notification;

  const result = {
    message: {
      token,
      notification: {
        title: String(payload.contactName ?? payload.metadata?.charName ?? '主动消息'),
        body: String(payload.notification?.body ?? actualBody).trim() || '有一条新消息',
      },
      data: {
        amsgPayload: JSON.stringify(portable),
        amsgHasBody: actualBody ? '1' : '0',
      },
      android: {
        priority: 'high',
        notification: {
          channel_id: 'amsg2',
          tag: typeof payload.messageId === 'string' ? payload.messageId : undefined,
          sound: 'default',
        },
      },
    },
  };
  const bytes = utf8.encode(JSON.stringify(result)).byteLength;
  if (bytes > 4000) throw new Error(`FCM_PAYLOAD_TOO_LARGE: ${bytes} bytes（安全上限 4000）`);
  return result;
};

const sendFcmNotification = async (env: NativeFcmEnv, token: string, payload: string) => {
  const config = requireFcmConfig(env);
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await fetchFcmAccessToken(env)}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(buildFcmMessage(token, payload)),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`FCM_SEND_FAILED (${response.status}): ${detail.slice(0, 500)}`);
  }
};

const isSilentPushPayload = (payload: Record<string, any>): boolean => {
  const show = payload.notification?.show;
  if (show === 'never' || show === false) return true;
  const kind = payload.messageKind;
  if (kind === 'reasoning' || kind === 'tool-request') return true;
  return false;
};

export const buildThirdPartyPushRequest = (
  parsed: ParsedThirdPartyPushEndpoint,
  subscription: any,
  rawPayload: string,
): { url: string; body: Record<string, any> } | null => {
  let payload: Record<string, any> = {};
  try {
    payload = JSON.parse(rawPayload) as Record<string, any>;
  } catch {
    payload = { body: rawPayload };
  }

  if (isSilentPushPayload(payload)) {
    return null;
  }

  const title = String(
    payload.notification?.title
    ?? payload.title
    ?? payload.contactName
    ?? payload.metadata?.charName
    ?? '主动消息',
  ).trim() || '主动消息';

  const actualBody = String(
    payload.notification?.body
    ?? payload.message
    ?? payload.body
    ?? '',
  ).trim();
  const body = actualBody || '有一条新消息';

  const charId = String(payload.charId ?? payload.metadata?.charId ?? '').trim() || undefined;
  const rawAvatarUrl = String(
    payload.avatarUrl
    ?? payload.notification?.icon
    ?? payload.metadata?.avatarUrl
    ?? '',
  ).trim();
  const avatarUrl = /^https?:\/\//i.test(rawAvatarUrl) ? rawAvatarUrl : undefined;
  const clickUrl = buildThirdPartyClickUrl(
    typeof subscription?.clickUrl === 'string' ? subscription.clickUrl : undefined,
    charId,
  );

  if (parsed.provider === 'wxpusher') {
    const summary = `${title}：${body}`.slice(0, 96);
    const content = `${title}\n\n${body}`;
    return {
      url: WXPUSHER_SIMPLE_PUSH_URL,
      body: {
        spt: parsed.token,
        summary,
        content,
        contentType: 1,
        ...(clickUrl ? { url: clickUrl } : {}),
      },
    };
  }

  if (parsed.provider === 'bark') {
    return {
      url: `${parsed.serverOrigin}/push`,
      body: {
        device_key: parsed.token,
        title,
        body,
        group: charId ? `amsg-${charId}` : 'sullyos',
        ...(avatarUrl ? { icon: avatarUrl } : {}),
        ...(clickUrl ? { url: clickUrl } : {}),
      },
    };
  }

  return {
    url: `${parsed.serverOrigin}/${encodeURIComponent(parsed.token)}`,
    body: {
      title,
      msg: body,
      ...(clickUrl ? { url: clickUrl } : {}),
    },
  };
};

const sendThirdPartyNotification = async (
  parsed: ParsedThirdPartyPushEndpoint,
  subscription: any,
  rawPayload: string,
) => {
  const req = buildThirdPartyPushRequest(parsed, subscription, rawPayload);
  if (!req) {
    return { skipped: true, reason: 'silent-payload' };
  }

  const response = await fetch(req.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(req.body),
  });

  const text = await response.text().catch(() => '');
  let json: Record<string, any> | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (parsed.provider === 'wxpusher') {
    const code = typeof json?.code === 'number' ? json.code : undefined;
    const ok = response.ok && (code === undefined || code === 1000) && json?.success !== false;
    if (!ok) {
      const msg = String(json?.msg || text || `HTTP ${response.status}`).slice(0, 300);
      throw new Error(`WXPUSHER_SEND_FAILED (${code ?? response.status}): ${msg}`);
    }
    return { ok: true, provider: 'wxpusher' };
  }

  if (parsed.provider === 'bark') {
    const code = typeof json?.code === 'number' ? json.code : undefined;
    const ok = response.ok && (code === undefined || code === 200);
    if (!ok) {
      const msg = String(json?.message || text || `HTTP ${response.status}`).slice(0, 300);
      throw new Error(`BARK_SEND_FAILED (${code ?? response.status}): ${msg}`);
    }
    return { ok: true, provider: 'bark' };
  }

  const ok = response.ok && json?.status !== 500 && json?.status !== 400;
  if (!ok) {
    const msg = String(json?.message || json?.msg || text || `HTTP ${response.status}`).slice(0, 300);
    throw new Error(`MEOW_SEND_FAILED (${response.status}): ${msg}`);
  }
  return { ok: true, provider: 'meow' };
};

export const createHybridPushTransport = (
  env: NativeFcmEnv,
  webPush: PushTransport,
): PushTransport => ({
  async sendNotification(subscription: any, payload: string) {
    const endpoint = subscription?.endpoint;
    const token = fcmTokenFromEndpoint(endpoint);
    if (token) return sendFcmNotification(env, token, payload);

    const thirdParty = parseThirdPartyPushEndpoint(typeof endpoint === 'string' ? endpoint : null);
    if (thirdParty) return sendThirdPartyNotification(thirdParty, subscription, payload);

    return webPush.sendNotification(subscription, payload);
  },
});

export const isFcmConfigured = (env: NativeFcmEnv): boolean => Boolean(
  env.FCM_PROJECT_ID?.trim()
  && env.FCM_SERVICE_ACCOUNT_EMAIL?.trim()
  && env.FCM_SERVICE_ACCOUNT_PRIVATE_KEY?.trim(),
);

