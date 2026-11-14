// utils/amsgRelay.test.ts
// 回归守卫：
//   1. 中转只改「往哪发」，不改存盘的 Worker 地址；开了中转、令牌格式对、地址是 https 域名时才走中转，
//      IP、带端口或路径的地址、令牌不对时照旧直连（中转那边根本不认，发过去只会报错）。
//   2. infra/amsg-relay/relay.py 里的路径白名单必须覆盖客户端和 Worker 实际用到的每一个接口。
//      新增接口时只改了代码、忘了改白名单，开了中转的用户就会在那个功能上静默失败。
//   3. 白名单不能放开：任意路径都要被拒，否则中转会变成公共跳板。
//   4. 只有官方渠道能走中转：客户端判不是官方就直连，中转服务那边按 Origin 放行的名单和首页二改提醒的官方网址一致。
import { beforeAll, describe, it, expect, vi } from 'vitest';

const deployment = vi.hoisted(() => ({ source: 'official' as 'official' | 'unofficial' | 'unknown' }));
vi.mock('./deploymentSource', async (importOriginal) => ({
  ...await importOriginal<typeof import('./deploymentSource')>(),
  detectDeploymentSource: async () => deployment.source,
}));
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AMSG_RELAY_BASE, canRelayWorkerUrl, checkRelayDeployment, relayUsageUrl, resolveWorkerFetchBase } from './amsgRelay';
import { OFFICIAL_HOSTS } from './deploymentSource';

beforeAll(async () => { await checkRelayDeployment(); });

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

// relay.py 里是 Python 的 r"..." 原始字符串；这条规则里没有 Python 和 JS 解释不同的写法，原样交给 RegExp。
const relayPattern = read('infra/amsg-relay/relay.py').match(/^PATH_ALLOWLIST = re\.compile\(r"(.+)"\)\s*$/m)?.[1];
const relayRegex = new RegExp(relayPattern || '(?!)');

const collect = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map((match) => match[1]);

const clientSdk = read('node_modules/@rei-standard/amsg-client/dist/index.mjs');
const serverDist = 'node_modules/@rei-standard/amsg-server/dist';
const serverSource = readdirSync(join(root, serverDist))
  .filter((name) => name.endsWith('.mjs'))
  .map((name) => read(`${serverDist}/${name}`))
  .join('\n');

const sdkPaths = [
  ...collect(clientSdk, /\$\{this\._baseUrl\}\/([a-z][a-z0-9/_-]*)/g),
  ...collect(clientSdk, /_cloudDataRequest\(["`]\/(cloud-data\/[a-z0-9/_-]+)/g),
];
const appPaths = collect(read('utils/activeMsgClient.ts'), /fetchWithAuth(?:Raw)?\(\s*['`]([a-z][a-z0-9/_-]*)/g);
const workerRoutes = collect(read('worker/amsg/src/index.ts'), /pathname\.endsWith\('\/([a-z0-9/_-]+)'\)/g);
const serverRoutes = collect(serverSource, /pathname\.endsWith\("\/([a-z0-9/_-]+)"\)/g);

const token = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE';

describe('resolveWorkerFetchBase', () => {
  it('没开中转时就是 Worker 地址本身（去掉结尾斜杠）', () => {
    expect(resolveWorkerFetchBase(' https://amsg.example.workers.dev/ ', false)).toBe('https://amsg.example.workers.dev');
  });

  it('开了中转、令牌格式对时，workers.dev 和自定义域名都换成中转地址', () => {
    expect(resolveWorkerFetchBase('https://Amsg.Example.workers.dev/', true, ` ${token} `))
      .toBe(`${AMSG_RELAY_BASE}/${token}/amsg.example.workers.dev`);
    expect(resolveWorkerFetchBase('https://amsg.my-domain.com', true, token))
      .toBe(`${AMSG_RELAY_BASE}/${token}/amsg.my-domain.com`);
  });

  it('IP、带路径、带端口、非 https 的地址开了中转也直连', () => {
    for (const url of [
      'https://1.2.3.4',
      'https://[::1]',
      'https://amsg.example.workers.dev/sub',
      'https://amsg.example.workers.dev:8443',
      'http://amsg.example.workers.dev',
      'https://localhost',
      'not a url',
    ]) {
      expect(canRelayWorkerUrl(url)).toBe(false);
      expect(resolveWorkerFetchBase(url, true, token)).toBe(url.trim().replace(/\/+$/, ''));
    }
  });

  it('令牌没填或格式不对时开了中转也直连', () => {
    for (const bad of [undefined, '', 'too-short', 'has space in the middle of it', 'a/b'.repeat(10), 'x'.repeat(65)]) {
      expect(resolveWorkerFetchBase('https://amsg.example.workers.dev', true, bad)).toBe('https://amsg.example.workers.dev');
    }
  });

  it('用量地址挂在令牌下面', () => {
    expect(relayUsageUrl(token)).toBe(`${AMSG_RELAY_BASE}/${token}/_usage`);
  });
});

describe('infra/amsg-relay/relay.py 中转白名单', () => {
  it('提取得到规则和各处的接口路径（提取失效时别让下面的断言空过）', () => {
    expect(relayPattern).toBeTruthy();
    expect(sdkPaths.length).toBeGreaterThan(10);
    expect(appPaths.length).toBeGreaterThan(10);
    expect(workerRoutes.length).toBeGreaterThan(5);
    expect(serverRoutes.length).toBeGreaterThan(5);
  });

  it.each([...new Set([...sdkPaths, ...appPaths, ...workerRoutes, ...serverRoutes])])('放行 /%s', (path) => {
    expect(`/${path}`).toMatch(relayRegex);
  });

  it('中转地址去掉令牌和域名两段后，剩下的路径就是白名单认的形状', () => {
    const base = resolveWorkerFetchBase('https://sullyos-amsg.example.workers.dev', true, token);
    const pathname = new URL(`${base}/config-check`).pathname;
    expect(pathname).toBe(`/t/${token}/sullyos-amsg.example.workers.dev/config-check`);
    expect(pathname.split('/').slice(4).join('/')).toBe('config-check');
    expect('/config-check').toMatch(relayRegex);
  });

  it('拒绝任意路径', () => {
    for (const path of [
      '/',
      '',
      '/anything',
      '/config-check/../../x',
      '/config-checkx',
      '/xconfig-check',
      '/config-check/extra',
      '/_usage',
    ]) {
      expect(path).not.toMatch(relayRegex);
    }
  });
});

describe('备份不带中转令牌', () => {
  it('默认导出摘掉令牌和中转开关，勾了「带上后端连接」才保留', async () => {
    const { vi } = await import('vitest');
    const { ActiveMsgStore, exportAmsg2GlobalConfig } = await import('./activeMsgStore');
    const token = 'a'.repeat(43);
    const spy = vi.spyOn(ActiveMsgStore, 'getGlobalConfig').mockResolvedValue({
      userId: 'u', workerUrl: 'https://x.y.workers.dev', useRelay: true, relayToken: token,
    } as Awaited<ReturnType<typeof ActiveMsgStore.getGlobalConfig>>);
    try {
      const shared = await exportAmsg2GlobalConfig();
      expect(shared?.relayToken).toBeUndefined();
      expect(shared?.useRelay).toBeUndefined();
      const own = await exportAmsg2GlobalConfig({ includeBackendConnection: true });
      expect(own?.relayToken).toBe(token);
      expect(own?.useRelay).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('只有官方渠道能用官方中转', () => {
  const token = 'a'.repeat(43);
  it.each(['unofficial', 'unknown'] as const)('%s 渠道开了中转也直连', async (source) => {
    deployment.source = source;
    try {
      await checkRelayDeployment();
      expect(resolveWorkerFetchBase('https://x.y.workers.dev', true, token)).toBe('https://x.y.workers.dev');
    } finally {
      deployment.source = 'official';
      await checkRelayDeployment();
    }
    expect(resolveWorkerFetchBase('https://x.y.workers.dev', true, token)).toBe(`${AMSG_RELAY_BASE}/${token}/x.y.workers.dev`);
  });

  it('中转服务按 Origin 放行的名单 = 官方网址 + 官方 APK 的 https://localhost', () => {
    const origins = read('infra/amsg-relay/relay.py').match(/^ALLOWED_ORIGINS = \{([^}]+)\}/m)?.[1] ?? '';
    const listed = [...origins.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...[...OFFICIAL_HOSTS].map((host) => `https://${host}`), 'https://localhost'].sort());
  });
});
