import { expect, it } from 'vitest';
import { COMPANION_ARK_PLAN, companionVideoEndpoint } from './videoProviders';

it('uses the local relay only for the exact official plan endpoint on localhost', () => {
  const plan = { baseUrl: COMPANION_ARK_PLAN.baseUrl };
  expect(companionVideoEndpoint(plan, 'http://127.0.0.1:5175')).toBe('http://127.0.0.1:5175/api/companion/ark-plan/chat/completions');
  expect(companionVideoEndpoint(plan, 'https://sully.example')).toBe(`${plan.baseUrl}/chat/completions`);
  for (const baseUrl of ['https://ark.cn-beijing.volces.com/api/v3', 'https://ark.cn-beijing.volces.com.evil.test/api/plan/v3', 'https://custom.test/v1']) {
    expect(companionVideoEndpoint({ baseUrl }, 'http://127.0.0.1:5175')).toBe(`${baseUrl}/chat/completions`);
  }
});
