// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { OSProvider, useOS } from '../context/OSContext';

it('returns visual failures to their callers without alerting or probing, and still reports model failures', async () => {
    const cdn = 'https://cdn.example.test';
    const networkError = new TypeError('Failed to fetch');
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push(url);
        if (url.endsWith('.woff2') || url.endsWith('/v1/models')) throw networkError;
        if (url.startsWith(cdn)) return new Response(null, { status: 404 });
        return Response.json({});
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', fetchMock);
    const originalConsole = console.error;
    const host = document.createElement('div');
    const root = createRoot(host);
    function Logs() {
        const { systemLogs, isDataLoaded } = useOS();
        return createElement('output', { 'data-ready': String(isDataLoaded) }, JSON.stringify(systemLogs));
    }
    try {
        await act(async () => root.render(createElement(OSProvider, { children: createElement(Logs) })));
        await vi.waitFor(() => expect(host.querySelector('[data-ready="true"]')).toBeTruthy());
        const before = host.textContent;
        await act(async () => {
            await expect(window.fetch(cdn + '/font.woff2')).rejects.toBe(networkError);
            expect((await window.fetch(cdn + '/sticker.gif?origin=/models')).status).toBe(404);
        });
        expect(host.textContent).toBe(before);
        expect(requests.filter(url => url.startsWith(cdn))).toEqual([cdn + '/font.woff2', cdn + '/sticker.gif?origin=/models']);
        await act(async () => {
            await expect(window.fetch('https://models.example.test/v1/models')).rejects.toBe(networkError);
        });
        expect(host.textContent).toContain('拉取模型列表');
    } finally {
        act(() => root.unmount());
        console.error = originalConsole;
        vi.unstubAllGlobals();
    }
});
