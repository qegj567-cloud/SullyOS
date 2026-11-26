import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { isAnthropicEndpoint, type LlmRequestInit } from './llmEndpoint';

// Per-call routing, never a global replacement for WebView fetch. Match the
// configured base *including its path*, not just a host or endpoint suffix.
export function useAndroidModelHttp(resource: RequestInfo | URL, init: LlmRequestInit | undefined, savedBase?: string): boolean {
    if (Capacitor.getPlatform() !== 'android' || typeof resource !== 'string') return false;
    const base = (init?.__sullySettingsModelBase ?? savedBase)?.trim().replace(/\/+$/, '');
    if (!base || isAnthropicEndpoint(base)) return false;
    let endpoint: URL;
    try { endpoint = new URL(base); } catch { return false; }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return false;
    const method = (init?.method || 'GET').toUpperCase();
    if (method === 'GET') return resource === base + '/models';
    if (method !== 'POST' || resource !== base + '/chat/completions' || typeof init?.body !== 'string') return false;
    try {
        const data = JSON.parse(init.body);
        return typeof data?.model === 'string' && Array.isArray(data.messages) && !data.stream;
    } catch { return false; }
}

// Only called after useAndroidModelHttp. No proxy fallback, credential-bearing
// redirects or automatic resend. Capacitor 6 buffers responses, so real SSE
// stays on its existing transport. Abort releases the caller, not the provider.
export const androidModelHttp: typeof fetch = async (resource, init = {}) => {
    const signal = init.signal;
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const headers: Record<string, string> = {};
    const input = new Headers(init.headers);
    for (const name of ['Authorization', 'Content-Type', 'Accept', 'X-Api-Key']) {
        const value = input.get(name);
        if (value !== null) headers[name] = value;
    }
    let onAbort: (() => void) | undefined;
    try {
        const pending = CapacitorHttp.request({
            url: String(resource), method: init.method || 'GET', headers,
            ...(typeof init.body === 'string' ? { data: JSON.parse(init.body) } : {}),
            responseType: 'text', disableRedirects: true, connectTimeout: 30000, readTimeout: 180000,
        });
        const reply = signal ? await Promise.race([pending, new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
        })]) : await pending;
        const body = [204, 205, 304].includes(reply.status) ? null :
            typeof reply.data === 'string' ? reply.data : JSON.stringify(reply.data);
        return new Response(body, { status: reply.status, headers: reply.headers });
    } finally {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
};
