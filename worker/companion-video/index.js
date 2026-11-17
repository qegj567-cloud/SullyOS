// Standalone, opt-in clip storage. Does not forward model keys or call any AI API.
// Bind a private R2 bucket as CLIPS, secret UPLOAD_TOKEN (32+ chars),
// ALLOWED_ORIGINS (comma-separated exact origins), and cron */5 * * * *.
const MAX_BYTES = 8 * 1024 * 1024;
const TTL_MS = 120_000;
const PREFIX = 'companion-clips/';

async function readBounded(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
    const cors = origin && allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    const reply = (status, text = '', extra = {}) => new Response(status === 204 ? null : text, {
      status, headers: { ...cors, 'Cache-Control': 'no-store', ...extra },
    });
    if (origin && !allowed.includes(origin)) return reply(403);
    if (!env.CLIPS || !env.UPLOAD_TOKEN || env.UPLOAD_TOKEN.length < 32 || !allowed.length) return reply(503, 'Configure CLIPS, UPLOAD_TOKEN and ALLOWED_ORIGINS');
    const id = new URL(request.url).pathname.match(/^\/clips\/([a-f0-9]{32})$/)?.[1];
    if (!id) return reply(404);
    if (request.method === 'OPTIONS') return reply(204, '', {
      'Access-Control-Allow-Methods': 'PUT, DELETE, GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
      'Access-Control-Max-Age': '600',
    });
    const key = PREFIX + id;
    if (request.method === 'PUT' || request.method === 'DELETE') {
      if (request.headers.get('Authorization') !== `Bearer ${env.UPLOAD_TOKEN}`) return reply(401);
      if (request.method === 'DELETE') { await env.CLIPS.delete(key); return reply(204); }
      if (request.headers.get('Content-Type') !== 'video/mp4') return reply(415);
      if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return reply(413);
      const bytes = await readBounded(request);
      if (!bytes || bytes.length > MAX_BYTES) return reply(413);
      // MediaRecorder MP4 begins with the ISO BMFF file type box.
      if (bytes.length < 12 || new TextDecoder().decode(bytes.slice(4, 8)) !== 'ftyp') return reply(415);
      await env.CLIPS.put(key, bytes, { httpMetadata: { contentType: 'video/mp4', cacheControl: 'no-store' },
        customMetadata: { expiresAt: String(Date.now() + TTL_MS) } });
      return reply(204);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply(405);
    const head = await env.CLIPS.head(key);
    if (!head) return reply(404);
    if (!(Number(head.customMetadata?.expiresAt) > Date.now())) { await env.CLIPS.delete(key); return reply(410); }
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff' };
    if (request.method === 'HEAD') return reply(200, '', { ...headers, 'Content-Length': String(head.size) });
    let range;
    const requested = request.headers.get('Range');
    if (requested) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(requested);
      if (!match || (!match[1] && !match[2])) return reply(416, '', { 'Content-Range': `bytes */${head.size}` });
      const start = match[1] ? Number(match[1]) : Math.max(0, head.size - Number(match[2]));
      const end = match[1] && match[2] ? Math.min(Number(match[2]), head.size - 1) : head.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= head.size) return reply(416, '', { 'Content-Range': `bytes */${head.size}` });
      range = { offset: start, length: end - start + 1 };
      headers['Content-Range'] = `bytes ${start}-${end}/${head.size}`;
    }
    const object = await env.CLIPS.get(key, range ? { range } : undefined);
    if (!object) return reply(404);
    headers['Content-Length'] = String(range?.length ?? head.size);
    return reply(range ? 206 : 200, object.body, headers);
  },
  async scheduled(_event, env) {
    let cursor;
    do {
      const page = await env.CLIPS.list({ prefix: PREFIX, limit: 1000, include: ['customMetadata'], ...(cursor ? { cursor } : {}) });
      const expired = page.objects.filter(object => !(Number(object.customMetadata?.expiresAt) > Date.now())).map(object => object.key);
      if (expired.length) await env.CLIPS.delete(expired);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  },
};
