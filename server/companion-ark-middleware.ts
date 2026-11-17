import type { IncomingMessage, ServerResponse } from 'node:http';

export const COMPANION_ARK_PATH = '/api/companion/ark-plan/chat/completions';
const UPSTREAM = 'https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions';
const MAX_BYTES = 12 * 1024 * 1024;

/** Local preview only: fixed official destination, no storage, retries or billing fallback. */
export function companionArkMiddleware(transport: typeof fetch = fetch) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url?.split('?')[0] !== COMPANION_ARK_PATH) { next(); return; }
    res.setHeader('Cache-Control', 'no-store');
    const fail = (status: number, message: string) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message } }));
    };
    let sameOrigin = false;
    try { sameOrigin = new URL(req.headers.origin || '').host === req.headers.host; } catch {}
    if (!sameOrigin || req.url !== COMPANION_ARK_PATH || req.method !== 'POST') { fail(403, '仅允许当前本机页面发起套餐测试或同行视频请求'); return; }
    const authorization = req.headers.authorization || '';
    if (!/^Bearer\s+\S+$/i.test(authorization)) { fail(401, '请填写 Agent Plan 专属 API Key'); return; }
    if (!req.headers['content-type']?.startsWith('application/json')) { fail(415, '需要 JSON 请求'); return; }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 60_000);
    const cancel = () => { if (!res.writableEnded) abort.abort(); };
    res.on('close', cancel);
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) { fail(413, '视频请求超过本机转发上限'); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed;
      try { parsed = JSON.parse(body); } catch { fail(400, '无效 JSON'); return; }
      if (typeof parsed.model !== 'string' || !Array.isArray(parsed.messages) || parsed.stream !== false) { fail(400, '需要非流式模型请求'); return; }
      const response = await transport(UPSTREAM, {
        method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Authorization: authorization }, body,
      });
      // Keep provider errors visible, without echoing credentials into the browser or logs.
      const responseBody = (await response.text()).split(authorization.replace(/^Bearer\s+/i, '')).join('[已隐藏凭据]');
      if (!res.destroyed) {
        res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') || 'application/json' });
        res.end(responseBody);
      }
    } catch { fail(abort.signal.aborted ? 504 : 502, abort.signal.aborted ? '套餐请求超时或已取消' : '本机无法连接火山套餐接口，请检查网络'); }
    finally { clearTimeout(timer); res.removeListener('close', cancel); }
  };
}
