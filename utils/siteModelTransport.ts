export const siteOrigin = 'https://friedsully.com';
export const modelRelayPath = '/api/model-request';

export function modelEndpoint(raw: string): URL | undefined {
    let url: URL;
    try { url = new URL(raw); } catch { return; }
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return;
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(url.hostname)) return;
    if (/(^|\.)(?:friedsully\.com|localhost|local|internal|lan|home|arpa|test|invalid|onion)$/.test(url.hostname)) return;
    if (/^[\w/.-]+$/.test(url.pathname) && /\/(models|chat\/completions)\/?$/.test(url.pathname)) return url;
}

export function createSiteModelTransport(network: typeof fetch, origin: string): typeof fetch {
    if (origin !== siteOrigin) return network;
    const routes = new Map<string, { viaSite: boolean; until: number }>();
    return async (resource, init) => {
        // The app's JSON model callers supply a URL and RequestInit. Leave opaque Requests untouched.
        if (resource instanceof Request) return network(resource, init);
        const url = modelEndpoint(String(resource));
        if (!url) return network(resource, init);
        const models = /\/models\/?$/.test(url.pathname);
        const method = (init?.method || 'GET').toUpperCase();
        const headers = new Headers(init?.headers);
        if (method !== (models ? 'GET' : 'POST') || (!models && typeof init?.body !== 'string') ||
            !/^Bearer\s+\S/i.test(headers.get('authorization') || '') || init?.credentials === 'include' ||
            [...headers.keys()].some(key => !['authorization','content-type','accept'].includes(key))) return network(resource, init);

        const target = url.href;
        const signal = init?.signal;
        const remember = (viaSite: boolean) => routes.set(target, { viaSite, until: Date.now() + 300_000 });
        function viaSite() {
            const outgoing = new Headers(headers);
            outgoing.set('x-model-endpoint', target);
            return network(siteOrigin + modelRelayPath, {
                method: 'POST', headers: outgoing, body: init?.body, signal, credentials: 'omit',
                redirect: 'error', cache: 'no-store', referrerPolicy: 'origin',
            });
        }
        const cached = routes.get(target);
        if (cached && cached.until > Date.now() && cached.viaSite) return viaSite();
        // Test an unfamiliar chat endpoint without a prompt. Never replay a possibly billable POST.
        if (!models && (!cached || cached.until <= Date.now())) {
            try {
                await network(target, { method: 'HEAD', headers, signal, credentials: 'omit', redirect: 'error' });
            } catch (error) {
                if (!(error instanceof TypeError) || signal?.aborted || globalThis.navigator?.onLine === false) throw error;
                remember(true);
                return viaSite();
            }
        }
        try {
            const response = await network(resource, init);
            remember(false);
            return response;
        } catch (error) {
            if (!(error instanceof TypeError) || signal?.aborted || globalThis.navigator?.onLine === false) throw error;
            remember(true);
            if (models) return viaSite();
            throw error;
        }
    };
}
