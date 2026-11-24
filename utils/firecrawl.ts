/**
 * Firecrawl 单页抓取适配。
 *
 * API Key 只保存在当前设备，并由客户端直接请求 Firecrawl；不会经过项目的
 * Cloudflare Worker。这样用户各自使用自己的免费额度，也不会把作者的共享额度
 * 挤在同一个 Worker 出口上。
 */

import { formatUnknownError } from './errorSelfCheck';

const FIRECRAWL_API_BASE = 'https://api.firecrawl.dev/v2';
const FIRECRAWL_KEY_STORAGE = 'sully_firecrawl_api_key_v1';
const FIRECRAWL_TIMEOUT_MS = 35_000;

export const FIRECRAWL_API_KEYS_URL = 'https://www.firecrawl.dev/app/api-keys';

export interface FirecrawlCreditUsage {
  remainingCredits: number;
  planCredits: number;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
}

export interface FirecrawlScrapeResult {
  markdown: string;
  title?: string;
  finalUrl?: string;
  image?: string;
}

export class FirecrawlApiError extends Error {
  readonly status: number;
  readonly kind: 'missing_key' | 'invalid_key' | 'quota' | 'rate_limit' | 'request';

  constructor(
    message: string,
    options: { status?: number; kind?: FirecrawlApiError['kind'] } = {},
  ) {
    super(message);
    this.name = 'FirecrawlApiError';
    this.status = options.status || 0;
    this.kind = options.kind || 'request';
  }
}

export const getFirecrawlApiKey = (): string => {
  try {
    return (localStorage.getItem(FIRECRAWL_KEY_STORAGE) || '').trim();
  } catch {
    return '';
  }
};

export const setFirecrawlApiKey = (key: string): void => {
  try {
    const value = (key || '').trim();
    if (value) localStorage.setItem(FIRECRAWL_KEY_STORAGE, value);
    else localStorage.removeItem(FIRECRAWL_KEY_STORAGE);
  } catch { /* localStorage 不可用时保持未配置 */ }
};

const errorFromResponse = (status: number, body: any): FirecrawlApiError => {
  const upstream = formatUnknownError(body, '').trim();
  if (status === 401 || status === 403) {
    return new FirecrawlApiError('Firecrawl API Key 无效或无权访问', { status, kind: 'invalid_key' });
  }
  if (status === 402) {
    return new FirecrawlApiError('Firecrawl 本期额度已用完', { status, kind: 'quota' });
  }
  if (status === 429) {
    return new FirecrawlApiError('Firecrawl 请求过于频繁，请稍后再试', { status, kind: 'rate_limit' });
  }
  return new FirecrawlApiError(upstream || `Firecrawl 请求失败 (HTTP ${status})`, { status });
};

const firecrawlRequest = async <T>(
  path: string,
  init: RequestInit,
  apiKey = getFirecrawlApiKey(),
): Promise<T> => {
  const key = apiKey.trim();
  if (!key) {
    throw new FirecrawlApiError('尚未配置 Firecrawl API Key', { kind: 'missing_key' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);
  try {
    const response = await fetch(`${FIRECRAWL_API_BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        ...(init.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!response.ok || body?.success === false) throw errorFromResponse(response.status, body);
    return body as T;
  } catch (error: any) {
    if (error instanceof FirecrawlApiError) throw error;
    if (error?.name === 'AbortError') throw new FirecrawlApiError('Firecrawl 抓取超时');
    throw new FirecrawlApiError(error?.message || '无法连接 Firecrawl');
  } finally {
    clearTimeout(timer);
  }
};

/** 不消耗抓取额度；同时验证 Key 并返回本期实时余额。 */
export const getFirecrawlCreditUsage = async (
  apiKey = getFirecrawlApiKey(),
): Promise<FirecrawlCreditUsage> => {
  const body = await firecrawlRequest<{ success: boolean; data?: Partial<FirecrawlCreditUsage> }>(
    '/team/credit-usage',
    { method: 'GET' },
    apiKey,
  );
  const data = body.data || {};
  return {
    remainingCredits: Number(data.remainingCredits || 0),
    planCredits: Number(data.planCredits || 0),
    billingPeriodStart: data.billingPeriodStart,
    billingPeriodEnd: data.billingPeriodEnd,
  };
};

/** 已知 URL 的单页正文抓取；普通页面固定只花 1 credit。 */
export const scrapeWebpageWithFirecrawl = async (
  url: string,
  apiKey = getFirecrawlApiKey(),
): Promise<FirecrawlScrapeResult> => {
  const body = await firecrawlRequest<{
    success: boolean;
    data?: {
      markdown?: string;
      metadata?: Record<string, unknown>;
    };
  }>(
    '/scrape',
    {
      method: 'POST',
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
        removeBase64Images: true,
        blockAds: true,
        storeInCache: false,
        maxAge: 0,
        timeout: 30_000,
      }),
    },
    apiKey,
  );
  const data = body.data || {};
  const markdown = String(data.markdown || '').trim();
  if (!markdown) throw new FirecrawlApiError('Firecrawl 没有提取到正文');
  const metadata = data.metadata || {};
  return {
    markdown,
    title: String(metadata.title || metadata.ogTitle || '').trim() || undefined,
    finalUrl: String(metadata.sourceURL || metadata.url || '').trim() || undefined,
    image: String(metadata.ogImage || metadata.image || '').trim() || undefined,
  };
};

