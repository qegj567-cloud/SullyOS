import { afterEach, expect, it } from 'vitest';
import { COMPANION_ARK_PLAN, companionVideoEndpoint } from './videoProviders';
import { setProxyWorkerUrlOverride } from '../proxyWorker';

afterEach(() => setProxyWorkerUrlOverride(null));

it('uses the local relay on localhost and the selected main proxy online only for the exact official plan endpoint', () => {
  const plan = { baseUrl: COMPANION_ARK_PLAN.baseUrl };
  expect(companionVideoEndpoint(plan, 'http://127.0.0.1:5175')).toBe('http://127.0.0.1:5175/api/companion/ark-plan/chat/completions');
  expect(companionVideoEndpoint(plan, 'https://test.friedsully.com')).toBe('https://proxy.friedsully.com/api/companion/ark-plan/chat/completions');
  setProxyWorkerUrlOverride('https://my-proxy.example/relay');
  expect(companionVideoEndpoint(plan, 'https://sully.example')).toBe('https://my-proxy.example/relay/api/companion/ark-plan/chat/completions');
  for (const baseUrl of ['https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com.evil.test/api/plan/v3', 'https://custom.test/v1']) {
    expect(companionVideoEndpoint({ baseUrl }, 'http://127.0.0.1:5175')).toBe(`${baseUrl}/chat/completions`);
    expect(companionVideoEndpoint({ baseUrl }, 'https://test.friedsully.com')).toBe(`${baseUrl}/chat/completions`);
  }
});

it.each(['http://proxy.example', 'https://key@proxy.example', 'https://proxy.example/?target=other', 'https://proxy.example/#secret'])('refuses unsafe relay configuration %s', proxy => {
  setProxyWorkerUrlOverride(proxy);
  expect(() => companionVideoEndpoint({ baseUrl: COMPANION_ARK_PLAN.baseUrl }, 'https://test.friedsully.com')).toThrow('HTTPS');
});
