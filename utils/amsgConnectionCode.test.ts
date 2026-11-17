import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAmsgConnectionCode, parseAmsgConnectionCode, verifyAmsgConnection } from './amsgConnectionCode';
import { discoverAmsgBackends, provisionAmsgBackend } from './cfProvision';

afterEach(() => vi.unstubAllGlobals());
const connection = { workerUrl: 'https://custom.example.test/amsg/', userId: 'original-user', serverToken: 'fixture-secret', masterKey: 'a'.repeat(64) };

describe('portable AMSG connection', () => {
  it('retains the original identity, domain and keys, excluding unrelated settings and device tokens', () => {
    const code = createAmsgConnectionCode({ ...connection, cfToken: 'never-copy', apiKey: 'never-copy', initializedAt: 123, instantChatEnabled: true } as any);
    const decoded = parseAmsgConnectionCode(code);
    expect(decoded).toEqual({ ...connection, workerUrl: 'https://custom.example.test/amsg' });
    expect(atob(code.split(':')[1])).not.toContain('never-copy');
    expect(decoded).not.toHaveProperty('initializedAt');
  });
  it('supports old manual installations without a local master-key copy', () => {
    expect(parseAmsgConnectionCode(createAmsgConnectionCode({ workerUrl: connection.workerUrl, userId: connection.userId })).masterKey).toBeUndefined();
  });
  it.each(['CF-token-value', 'SULLY-AMSG2:broken', 'SULLY-AMSG2:' + btoa(JSON.stringify({ version: 2 }))])('rejects incomplete or incompatible codes', value => {
    expect(() => parseAmsgConnectionCode(value)).toThrow();
  });
  it.each(['http://example.test', 'https://u:p@example.test', 'https://example.test/#fragment', 'https://example.test/?secret=123'])('rejects an unsafe connection address: %s', workerUrl => {
    expect(() => createAmsgConnectionCode({ ...connection, workerUrl })).toThrow();
  });
  it('validates against the existing Worker without initializing, changing subscriptions or following redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, data: { userKey: 'fixture-user-key' } }));
    vi.stubGlobal('fetch', fetcher);
    await verifyAmsgConnection({ ...connection, workerUrl: 'https://custom.example.test/amsg' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('https://custom.example.test/amsg/get-user-key');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { 'X-User-Id': 'original-user', 'X-Client-Token': 'fixture-secret' } });
    expect(fetcher.mock.calls[0][1].method).toBeUndefined();
  });
  it('rejects expired credentials and misleading successful HTML/JSON responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('', { status: 401 })).mockResolvedValueOnce(Response.json({ success: true })));
    await expect(verifyAmsgConnection(connection)).rejects.toThrow('没有接受');
    await expect(verifyAmsgConnection(connection)).rejects.toThrow('无法验证');
  });
});

function mockCf(handler: (path: string) => { result?: unknown; status?: number; relay?: boolean }) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const path = parsed.searchParams.get('path') || 'relay';
    seen.push(`${(init?.headers as Record<string, string>)?.['X-CF-Method'] || init?.method || 'GET'} ${path}`);
    const response = handler(path);
    return Response.json(response.relay ? { relay: 'cf-api', version: 1 } : { success: (response.status || 200) < 400, result: response.result }, { status: response.status || 200 });
  }));
  return seen;
}
function cfResult(path: string) {
  if (path === '/user/tokens/verify') return { result: { status: 'active' } };
  if (path.startsWith('/accounts?')) return { result: [{ id: 'a', name: 'One' }, { id: 'b', name: 'Two' }] };
  if (path.endsWith('/scripts')) return { result: [{ id: 'sullyos-amsg' }] };
  if (path.endsWith('/settings')) return { result: { bindings: [{ name: 'AMSG_MASTER_KEY', type: 'secret_text' }] } };
  if (path.includes('/domains')) return { result: [{ service: 'sullyos-amsg', hostname: 'custom.example.test', environment: 'production' }] };
  if (path.includes('/scripts/') && path.endsWith('/subdomain')) return { result: { enabled: false } };
  if (path.endsWith('/subdomain')) return { result: { subdomain: 'owner' } };
  if (path === 'relay') return { relay: true };
  throw new Error(`Unexpected API path: ${path}`);
}

describe('existing-backend journey', () => {
  it('finds multiple accounts and custom domains using reads only; does not claim a disabled workers.dev URL', async () => {
    const seen = mockCf(cfResult);
    const result = await discoverAmsgBackends('token');
    expect(result.backends).toHaveLength(2);
    expect(result.backends[0].urls).toEqual(['https://custom.example.test']);
    expect(seen.every(call => call.startsWith('GET '))).toBe(true);
    expect(seen.some(call => /\/secrets|\/d1\//.test(call))).toBe(false);
  });
  it('distinguishes access failures from a genuinely absent deployment', async () => {
    mockCf(path => path.includes('/a/workers/scripts/') && path.endsWith('/settings') ? { status: 403 } : path.endsWith('/settings') ? { status: 404 } : cfResult(path));
    const result = await discoverAmsgBackends('token');
    expect(result.backends).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('暂时无法检查');
  });
  it('does not identify an unrelated same-name Worker as AMSG', async () => {
    mockCf(path => path.endsWith('/settings') ? { result: { bindings: [] } } : cfResult(path));
    const result = await discoverAmsgBackends('token');
    expect(result.backends).toHaveLength(0);
    expect(result.warnings).toHaveLength(2);
  });
  it('blocks redeployment on a fresh device before any database or Worker write', async () => {
    const seen = mockCf(cfResult);
    const result = await provisionAmsgBackend({ token: 'token', accountId: 'a' });
    expect(result).toMatchObject({ ok: false, code: 'SCRIPT_EXISTS' });
    expect(seen.every(call => call.startsWith('GET '))).toBe(true);
    expect(seen.some(call => call.includes('/d1/'))).toBe(false);
  });
  it('fails closed when the existing Worker list cannot be checked', async () => {
    const seen = mockCf(path => path.endsWith('/scripts') ? { status: 503 } : cfResult(path));
    expect(await provisionAmsgBackend({ token: 'token', accountId: 'a' })).toMatchObject({ ok: false, code: 'CF_ERROR' });
    expect(seen.every(call => call.startsWith('GET '))).toBe(true);
  });
});
