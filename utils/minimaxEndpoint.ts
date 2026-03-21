/**
 * MiniMax API endpoint resolution + native HTTP for Capacitor.
 *
 * Web/dev mode:  Vite proxy `/api/minimax/*` → api.minimaxi.com
 * Capacitor native: CapacitorHttp (bypasses CORS via native networking)
 */

import { Capacitor, CapacitorHttp } from '@capacitor/core';

const isNative = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

const PROXY_MAP: Record<string, string> = {
  '/api/minimax/t2a': 'https://api.minimaxi.com/v1/t2a_v2',
  '/api/minimax/get-voice': 'https://api.minimaxi.com/v1/get_voice',
};

/**
 * Return the actual URL to fetch for a given proxy path.
 */
export function resolveMinimaxUrl(proxyPath: string): string {
  if (PROXY_MAP[proxyPath] && isNative()) {
    return PROXY_MAP[proxyPath];
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

const buildUpstreamWebInit = (
  init: { method?: string; headers?: Record<string, string>; body?: string },
): { method?: string; headers?: Record<string, string>; body?: string } => {
  const headers = normalizeHeaders(init.headers || {});
  const groupId = (headers['x-minimax-group-id'] || '').trim();

  // MiniMax upstream CORS doesn't allow x-minimax-api-key/x-minimax-group-id custom headers.
  delete headers['x-minimax-api-key'];
  delete headers['x-minimax-group-id'];

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
    // Keep original body when it's not JSON.
  }

  return { ...init, headers };
};

/**
 * A fetch-like wrapper that uses CapacitorHttp on native platforms
 * to bypass CORS restrictions, and regular fetch on web.
 *
 * Returns a Response-like object with .ok, .status, and .json() method.
 */
export async function minimaxFetch(
  proxyPath: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  const url = resolveMinimaxUrl(proxyPath);

  if (!isNative()) {
    const res = await fetch(url, init);
    // Static deployments (e.g. GitHub Pages) don't support POST /api/* proxy.
    // If proxy endpoint is unavailable, retry against MiniMax upstream directly.
    if ((res.status === 404 || res.status === 405) && PROXY_MAP[proxyPath]) {
      return fetch(PROXY_MAP[proxyPath], buildUpstreamWebInit(init));
    }
    return res;
  }

  // Use CapacitorHttp for native — this goes through native networking, no CORS
  const response = await CapacitorHttp.request({
    url,
    method: init.method || 'POST',
    headers: init.headers || {},
    data: init.body ? JSON.parse(init.body) : undefined,
  });

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    json: async () => response.data,
  };
}
