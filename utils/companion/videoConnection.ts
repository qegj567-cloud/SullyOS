import type { CompanionVideoApiConfig } from '../../types';
import { companionVideoDirectEndpoint, companionVideoEndpoint } from './videoProviders';

type VideoAddress = Pick<CompanionVideoApiConfig, 'baseUrl'>;

/** Describe the same route used by both the sample and real video requests. */
export function companionVideoRouteLabel(api: VideoAddress, origin = typeof window !== 'undefined' ? window.location.origin : '') {
  try {
    const endpoint = companionVideoEndpoint(api, origin), target = new URL(endpoint);
    if (endpoint === companionVideoDirectEndpoint(api)) return `浏览器 → ${target.hostname}（不经应用 Worker）`;
    const local = origin && target.origin === new URL(origin).origin;
    return `浏览器 → ${local ? '本机转发' : `应用主代理 ${target.hostname}`} → 火山套餐接口`;
  } catch { return '地址或应用主代理配置无效，请检查后再测试'; }
}

/** An empty request checks CORS without submitting media or starting inference.
 * Use the draft key because providers may apply different CORS headers to auth errors.
 * HTTP errors are readable responses, NOT proof of valid credentials or video support.
 */
export async function testCompanionVideoDirect(api: VideoAddress & Pick<CompanionVideoApiConfig, 'apiKey'>, signal: AbortSignal) {
  signal.throwIfAborted();
  const url = new URL(api.baseUrl.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('请填写不含账号、查询参数或片段的 HTTP(S) API Base URL');
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
  try {
    const response = await fetch(companionVideoDirectEndpoint(api), {
      method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
      body: '{}',
      __sullyHandlesFailure: true,
      __sullyMeta: { appId: 'companion', appName: '同行', purpose: '测试连接' },
    } as RequestInit);
    signal.throwIfAborted();
    if (timedOut) throw new Error('timeout');
    if (!response.status || response.type === 'opaque' || response.type === 'opaqueredirect') throw new Error('不可读响应');
    void response.body?.cancel().catch(() => {});
    return {
      summary: `直连响应可读（HTTP ${response.status}），仅表示浏览器能读取响应`,
      detail: '本次发送空请求，未提交视频、未指定模型。400 / 401 等错误也可用于检查跨域，但不代表 Key、额度或视频功能可用；请再点击「测试视频 API」。套餐的实际视频路径仍以上方显示为准，不会因这次检查自动切换。',
    };
  } catch (error) {
    signal.throwIfAborted();
    if (timedOut) throw new Error('直连检查超时（15 秒）。未改走代理，也未发送视频；请检查网络后重试。');
    throw new Error('浏览器未能读取直连响应，可能是跨域限制、网络、证书或地址问题；仅凭此结果无法区分。未改走代理，也未发送视频。');
  } finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
}
