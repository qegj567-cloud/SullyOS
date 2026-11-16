import type { ActiveMsg2GlobalConfig } from '../types';
import { getRelayDeploymentSource, resolveWorkerFetchBase } from './amsgRelay';

const PREFIX = 'SULLY-AMSG2:';
export type AmsgConnection = Pick<ActiveMsg2GlobalConfig, 'workerUrl' | 'userId' | 'serverToken' | 'masterKey'>;

/** A portable connection, not a chat backup. Never include CF/API tokens or device subscriptions. */
function validate(value: unknown): AmsgConnection {
  if (!value || typeof value !== 'object') throw new Error('连接码不完整，请从原设备重新复制。');
  const data = value as Record<string, unknown>;
  if (typeof data.workerUrl !== 'string' || typeof data.userId !== 'string' || !data.userId.trim() || data.userId.length > 200 || /[\r\n]/.test(data.userId)) throw new Error('连接码缺少后台地址或原用户身份。');
  let url: URL;
  try { url = new URL(data.workerUrl); } catch { throw new Error('连接码中的后台地址无效。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('后台地址需要是完整的 HTTPS 地址，不能带账号、查询参数或片段。');
  if (data.serverToken !== undefined && (typeof data.serverToken !== 'string' || data.serverToken.length > 2048 || /[\r\n]/.test(data.serverToken))) throw new Error('连接码中的共享密钥无效。');
  if (data.masterKey !== undefined && (typeof data.masterKey !== 'string' || !/^[a-f\d]{64}$/i.test(data.masterKey))) throw new Error('连接码中的主密钥无效。');
  return { workerUrl: url.href.replace(/\/+$/, ''), userId: data.userId.trim(), serverToken: data.serverToken as string | undefined, masterKey: data.masterKey as string | undefined };
}

export function createAmsgConnectionCode(config: AmsgConnection): string {
  const data = JSON.stringify({ version: 1, connection: validate(config) });
  return PREFIX + btoa(Array.from(new TextEncoder().encode(data), b => String.fromCharCode(b)).join(''));
}

export function parseAmsgConnectionCode(input: string): AmsgConnection {
  const text = input.trim();
  if (!text.startsWith(PREFIX) || text.length > 16_000) throw new Error('请粘贴以 SULLY-AMSG2: 开头的完整连接码。Cloudflare Token 不是连接码。');
  let data: any;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(text.slice(PREFIX.length)), c => c.charCodeAt(0)))); }
  catch { throw new Error('连接码无法读取，请从原设备重新复制。'); }
  if (data?.version !== 1) throw new Error('这份连接码需要更新 SullyOS 后再使用。');
  return validate(data.connection);
}

/** Read-only authentication check before changing this device's saved identity. */
export async function verifyAmsgConnection(connection: AmsgConnection, localRelay?: Pick<ActiveMsg2GlobalConfig, 'useRelay' | 'relayToken'>): Promise<void> {
  const headers: Record<string, string> = { 'X-User-Id': connection.userId };
  if (connection.serverToken) headers['X-Client-Token'] = connection.serverToken;
  await getRelayDeploymentSource();
  const base = resolveWorkerFetchBase(connection.workerUrl, localRelay?.useRelay, localRelay?.relayToken);
  const response = await fetch(`${base}/get-user-key`, { headers, signal: AbortSignal.timeout(12_000), redirect: 'error' });
  if (response.status === 401 || response.status === 403) throw new Error('后台没有接受这份连接码，请在原设备重新复制最新连接码。');
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success || !body?.data?.userKey) throw new Error('暂时无法验证后台连接。请检查地址和网络后重试，本机原连接未更改。');
}
