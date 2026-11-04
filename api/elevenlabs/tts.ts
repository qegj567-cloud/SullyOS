/**
 * ElevenLabs TTS 代理（Vercel serverless）。
 * Key 由客户端请求头或部署环境变量提供；代理只转发，不记录 Key 与待合成文本。
 */
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

function setCors(res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,xi-api-key,Accept');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type,request-id');
}

function normalizeApiKey(raw?: string): string {
  return (raw || '').trim();
}

function normalizeVoiceId(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : '';
}

function normalizeOutputFormat(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^[a-z0-9_]{3,32}$/.test(value) ? value : DEFAULT_OUTPUT_FORMAT;
}

export default async function handler(req: any, res: any) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  try {
    const incomingKey = typeof req.headers['xi-api-key'] === 'string' ? req.headers['xi-api-key'] : '';
    const envKey = typeof process.env.ELEVENLABS_API_KEY === 'string' ? process.env.ELEVENLABS_API_KEY : '';
    const apiKey = normalizeApiKey(incomingKey) || normalizeApiKey(envKey);
    const voiceId = normalizeVoiceId(req.query?.voice_id);
    const outputFormat = normalizeOutputFormat(req.query?.output_format);
    const dialogue = req.query?.mode === 'dialogue';
    const timestamps = req.query?.timestamps === '1';

    if (!apiKey) {
      res.status(400).json({ error: 'Missing API key. Provide xi-api-key or ELEVENLABS_API_KEY.' });
      return;
    }
    if (!dialogue && !voiceId) {
      res.status(400).json({ error: 'Missing or invalid voice_id.' });
      return;
    }

    const endpoint = dialogue ? 'text-to-dialogue' : `text-to-speech/${encodeURIComponent(voiceId)}`;
    const abort = new AbortController();
    const onClose = () => abort.abort();
    res.on('close', onClose);
    try {
      const upstream = await fetch(
        `${ELEVENLABS_BASE}/${endpoint}/stream${timestamps ? '/with-timestamps' : ''}?output_format=${encodeURIComponent(outputFormat)}`,
        {
          method: 'POST',
          signal: abort.signal,
          headers: {
            'Content-Type': 'application/json',
            Accept: timestamps ? 'application/json' : 'audio/mpeg',
            'xi-api-key': apiKey,
          },
          body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}),
        },
      );

      const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
      if (!upstream.ok) {
        const errorText = await upstream.text();
        res.status(upstream.status);
        res.setHeader('Content-Type', contentType.includes('json') ? 'application/json' : 'text/plain; charset=utf-8');
        res.send(errorText);
        return;
      }

      res.status(200);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-store, no-transform');
      const requestId = upstream.headers.get('request-id');
      if (requestId) res.setHeader('request-id', requestId);
      res.flushHeaders?.();
      if (!upstream.body) throw new Error('ElevenLabs returned no audio stream');
      const reader = upstream.body.getReader();
      const cancelReader = () => { void reader.cancel().catch(() => {}); };
      abort.signal.addEventListener('abort', cancelReader, { once: true });
      try {
        while (!abort.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) {
            await new Promise<void>((resolve) => {
              const ready = () => { res.off('drain', ready); res.off('close', ready); resolve(); };
              res.once('drain', ready); res.once('close', ready);
            });
          }
        }
        if (!abort.signal.aborted) res.end();
      } finally {
        abort.signal.removeEventListener('abort', cancelReader);
        await reader.cancel().catch(() => {}); reader.releaseLock();
      }
    } finally { res.off('close', onClose); }
  } catch (error: any) {
    if (res.headersSent) res.destroy(error);
    else res.status(500).json({ error: error?.message || 'ElevenLabs proxy request failed' });
  }
}
