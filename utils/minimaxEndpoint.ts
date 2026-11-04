/**
 * MiniMax API endpoint resolution + native HTTP for Capacitor.
 *
 * Web/dev mode: prefers `/api/minimax/*` when a proxy exists.
 * Static web/file previews: falls back to MiniMax upstream directly.
 * Capacitor native: uses CapacitorHttp to bypass browser CORS.
 *
 * Region-aware: resolves upstream to either
 *   - 国内站   https://api.minimaxi.com   ('domestic', default)
 *   - 海外站   https://api.minimax.io     ('overseas')
 * The region is synced from OSContext via `setMinimaxRegion()` and also
 * forwarded on every request as `X-MiniMax-Region`, so server-side proxies
 * (Vite dev proxy, Vercel serverless, dev middleware) can route correctly.
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import type { MinimaxRegion } from '../types';
import { safeResponseJson } from './safeApi';
import { isStaticWebDeployment } from './staticWebDeployment';

type MiniMaxResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
};

const REGION_BASE_URLS: Record<MinimaxRegion, string> = {
  domestic: 'https://api.minimaxi.com',
  overseas: 'https://api.minimax.io',
};

// Proxy path → upstream endpoint (concatenated with region base).
const PROXY_ENDPOINTS: Record<string, string> = {
  '/api/minimax/t2a': '/v1/t2a_v2',
  '/api/minimax/stt': '/v1/speech_to_text',
  '/api/minimax/get-voice': '/v1/get_voice',
  '/api/minimax/music': '/v1/music_generation',
};

let currentRegion: MinimaxRegion = 'domestic';

export const normalizeMinimaxRegion = (raw: unknown): MinimaxRegion =>
  raw === 'overseas' ? 'overseas' : 'domestic';

export function setMinimaxRegion(region: MinimaxRegion | string | undefined | null): void {
  currentRegion = normalizeMinimaxRegion(region);
}

export function getMinimaxRegion(): MinimaxRegion {
  return currentRegion;
}

export function getMinimaxBaseUrl(region: MinimaxRegion = currentRegion): string {
  return REGION_BASE_URLS[normalizeMinimaxRegion(region)];
}

const isNative = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

const getUpstreamUrl = (proxyPath: string, region: MinimaxRegion = currentRegion): string | null => {
  const endpoint = PROXY_ENDPOINTS[proxyPath];
  if (!endpoint) return null;
  return `${getMinimaxBaseUrl(region)}${endpoint}`;
};

const wrapWebResponse = (response: Response): MiniMaxResponseLike => ({
  ok: response.ok,
  status: response.status,
  json: async () => safeResponseJson(response.clone()),
});

/**
 * Return the actual URL to fetch for a given proxy path.
 * Native platforms always hit the upstream directly (no CORS).
 */
export function resolveMinimaxUrl(proxyPath: string): string {
  const upstream = getUpstreamUrl(proxyPath);
  if (upstream && isNative()) {
    return upstream;
  }
  return proxyPath;
}

const normalizeHeaders = (headers: Record<string, string> = {}): Record<string, string> => {
  const normalized: Record<string, string> = {};
  Object.entries(headers).forEach(([k, v]) => {
    normalized[k.toLowerCase()] = v;
  });
  return normalized;
};

const withRegionHeader = (
  headers: Record<string, string> = {},
  region: MinimaxRegion,
): Record<string, string> => ({
  ...headers,
  'X-MiniMax-Region': region,
});

const buildUpstreamWebInit = (
  init: { method?: string; headers?: Record<string, string>; body?: string },
): { method?: string; headers?: Record<string, string>; body?: string } => {
  const headers = normalizeHeaders(init.headers || {});
  const groupId = (headers['x-minimax-group-id'] || '').trim();

  // MiniMax upstream CORS does not accept these custom headers.
  delete headers['x-minimax-api-key'];
  delete headers['x-minimax-group-id'];
  delete headers['x-minimax-region'];

  if (!groupId || !init.body) {
    return { ...init, headers };
  }

  try {
    const body = JSON.parse(init.body);
    if (body && typeof body === 'object' && !body.group_id) {
      body.group_id = groupId;
      return { ...init, headers, body: JSON.stringify(body) };
    }
  } catch {
    // Keep the original body when it is not JSON.
  }

  return { ...init, headers };
};

const shouldBypassWebProxy = (proxyPath: string): boolean => {
  if (!PROXY_ENDPOINTS[proxyPath]) return false;
  if (typeof window === 'undefined') return false;

  return isStaticWebDeployment(window.location.protocol, window.location.hostname);
};

const shouldRetryAgainstUpstream = (proxyPath: string, response: Response): boolean => {
  if (!PROXY_ENDPOINTS[proxyPath]) return false;
  if (response.status === 404 || response.status === 405) return true;

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  return contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
};

const fetchUpstreamWeb = async (
  proxyPath: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  region: MinimaxRegion,
): Promise<MiniMaxResponseLike> => {
  const upstream = getUpstreamUrl(proxyPath, region);
  if (!upstream) throw new Error(`No upstream mapping for ${proxyPath}`);
  return wrapWebResponse(await fetch(upstream, buildUpstreamWebInit(init)));
};

/**
 * A fetch-like wrapper that uses CapacitorHttp on native platforms
 * and safe JSON parsing on web. The current MiniMax region is
 * appended as `X-MiniMax-Region` so server-side proxies can route.
 */
export async function minimaxFetch(
  proxyPath: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<MiniMaxResponseLike> {
  const region = currentRegion;
  const enrichedInit = { ...init, headers: withRegionHeader(init.headers, region) };
  const url = resolveMinimaxUrl(proxyPath);

  if (!isNative()) {
    if (shouldBypassWebProxy(proxyPath)) {
      return fetchUpstreamWeb(proxyPath, enrichedInit, region);
    }

    try {
      const res = await fetch(url, enrichedInit);
      // Static preview servers can rewrite missing /api routes to index.html.
      if (shouldRetryAgainstUpstream(proxyPath, res)) {
        return fetchUpstreamWeb(proxyPath, enrichedInit, region);
      }
      return wrapWebResponse(res);
    } catch (error) {
      if (PROXY_ENDPOINTS[proxyPath]) {
        return fetchUpstreamWeb(proxyPath, enrichedInit, region);
      }
      throw error;
    }
  }

  const response = await CapacitorHttp.request({
    url,
    method: enrichedInit.method || 'POST',
    headers: enrichedInit.headers || {},
    data: enrichedInit.body ? JSON.parse(enrichedInit.body) : undefined,
  });

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.data,
  };
}
