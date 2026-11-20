/**
 * 主动消息 2.0 中转：大陆网络连不上 workers.dev（DNS 污染 + SNI 重置），
 * 用户可以在设置里选择让请求经 SullyOS 的中转服务器转发。设计与取舍见 docs/amsg2-relay.md。
 *
 * 存盘的 workerUrl 始终是 Worker 本身的地址：它同时是客户端缓存、云端数据归属等处的身份标识，
 * 换成中转地址会让这些地方误以为换了一台后端。只有真正发请求的那一步才换成这里算出来的地址。
 */
import { detectDeploymentSource, type DeploymentSource } from './deploymentSource';

export const AMSG_RELAY_BASE = 'https://amsg-relay.friedsully.com/t';

// 只有官方渠道（官方网址、签名校验过的官方 APK）能用官方中转：二改版本里改过的主动消息逻辑
// 可能产生未经认证的流量，会被当成滥用。判定复用首页二改提醒那套。本地开发（localhost）也算不上官方，
// 一样走直连。这里只是客户端这一道，中转服务那边还会按请求来源的网址再拦一次。
let deploymentCheck: Promise<DeploymentSource> | undefined;
let officialDeployment = false;

/** 重新判断一次当前是不是官方渠道。正常只在模块加载时判一次，测试里用它换场景。 */
export const checkRelayDeployment = (): Promise<DeploymentSource> => {
  // 没有页面地址（非浏览器环境）时传空串，判定结果就是 unknown
  deploymentCheck = detectDeploymentSource(globalThis.location?.href ?? '').then((source) => {
    officialDeployment = source === 'official';
    return source;
  });
  return deploymentCheck;
};

export const getRelayDeploymentSource = (): Promise<DeploymentSource> => deploymentCheck ?? checkRelayDeployment();
void getRelayDeploymentSource();

// 和 infra/amsg-relay/relay.py 认的令牌格式一致：Discord 机器人发的是 43 位，留出余量。
const RELAY_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

// 域名而不是 IP：最后一段以字母开头就排除了 IPv4，IPv6 在 URL 里带方括号也过不了。
// 目标是不是托管在 Cloudflare 上由中转那边判断，客户端不查。
const DNS_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const isRelayTokenWellFormed = (token?: string): boolean => RELAY_TOKEN.test(token?.trim() ?? '');

/** 这个 Worker 地址能不能走中转：https、域名（不是 IP）、不带端口和路径。 */
export const canRelayWorkerUrl = (workerUrl: string): boolean => {
  try {
    const url = new URL(workerUrl.trim());
    return url.protocol === 'https:' && !url.port && !url.username && !url.search && !url.hash
      && url.pathname.replace(/\/+$/, '') === '' && DNS_HOST.test(url.hostname);
  } catch {
    return false;
  }
};

/**
 * 实际发请求用的地址（不带结尾斜杠）。官方渠道、开了中转、令牌格式对、地址也走得了中转时才换成中转地址，
 * 否则就是 Worker 地址本身。
 */
export const resolveWorkerFetchBase = (workerUrl: string, useRelay?: boolean, relayToken?: string): string => {
  const direct = workerUrl.trim().replace(/\/+$/, '');
  if (!useRelay || !officialDeployment || !isRelayTokenWellFormed(relayToken) || !canRelayWorkerUrl(direct)) return direct;
  return `${AMSG_RELAY_BASE}/${relayToken!.trim()}/${new URL(direct).hostname}`;
};

export const relayUsageUrl = (relayToken: string): string => `${AMSG_RELAY_BASE}/${relayToken.trim()}/_usage`;

/** 单位是字节。 */
export interface RelayUsageWindow { up: number; down: number; requests: number }

export type RelayUsageResult =
  | { kind: 'ok'; last30: RelayUsageWindow }
  | { kind: 'invalid-token' }
  | { kind: 'error' };

/** 查这个令牌近 30 天经中转的流量。中转只按账号按天记上传、下载字节和请求次数。 */
export const fetchRelayUsage = async (relayToken: string): Promise<RelayUsageResult> => {
  try {
    const response = await fetch(relayUsageUrl(relayToken));
    if (response.status === 401) return { kind: 'invalid-token' };
    if (!response.ok) return { kind: 'error' };
    const last30 = (await response.json())?.last30;
    if (![last30?.up, last30?.down, last30?.requests].every(Number.isFinite)) return { kind: 'error' };
    return { kind: 'ok', last30: { up: last30.up, down: last30.down, requests: last30.requests } };
  } catch {
    return { kind: 'error' };
  }
};
