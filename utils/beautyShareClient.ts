import { BEAUTY_MAX_BYTES, validateBeautyPackage, type BeautyKind, type BeautyShare } from './beautyShareContract';
import { readShareFile } from './pngShare';
import { validateDecoration } from './chatDecoration';
import { formatUnknownError } from './errorSelfCheck';
import { summarizeHtmlErrorBody } from './networkFailureDiagnosis';

// Deployments can override this at build time; authors never enter a server URL.
import {BEAUTY_SHARE_URL} from './beautyShareConfig';
export {BEAUTY_SHARE_URL} from './beautyShareConfig';
const SESSION_KEY = 'sully-beauty-author-session-v1';
export interface BeautySession { token: string; authorCode: string; expiresAt: number }
export function readBeautySession(): BeautySession | null {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return value?.expiresAt > Date.now() && /^A-[A-F0-9]{16}$/.test(value.authorCode) && /^[a-f0-9]{64}$/.test(value.token) ? value : null;
  } catch { return null; }
}
export function saveBeautySession(value: BeautySession | null) {
  if (value) localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  else localStorage.removeItem(SESSION_KEY);
}
function parseBeautyErrorText(rawText: string, status: number, fallback: string): string {
  const trimmed = (rawText || '').trim();
  if (!trimmed) return `${fallback} (HTTP ${status})`;
  if (/^\s*<(?:!doctype|html|head|body)\b/i.test(trimmed)) {
    const summary = summarizeHtmlErrorBody(trimmed).headline;
    return `${fallback} (HTTP ${status}${summary ? ` · ${summary}` : ''})`;
  }
  try {
    const parsed = JSON.parse(trimmed);
    const msg = formatUnknownError(parsed?.error ?? parsed, '');
    if (msg) return msg;
  } catch { /* non-json */ }
  return `${fallback} (HTTP ${status} · ${trimmed.slice(0, 120)})`;
}

export async function beautyRequest<T>(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  if (!BEAUTY_SHARE_URL) throw Error('此版本尚未配置美化分享服务');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(BEAUTY_SHARE_URL + '/api' + path, {
      method: options.method || 'GET', signal: controller.signal, credentials: 'omit', cache: 'no-store',
      headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const rawText = await response.text();
    if (!response.ok) throw Error(parseBeautyErrorText(rawText, response.status, '美化分享服务异常'));
    try {
      return JSON.parse(rawText) as T;
    } catch {
      throw Error(parseBeautyErrorText(rawText, response.status, '美化分享服务返回非 JSON 响应'));
    }
  } catch (error) {
    if (controller.signal.aborted) throw Error(options.method === 'POST' || options.method === 'DELETE' ? '请求超时，请刷新确认结果后再重试' : '请求超时，请刷新重试');
    throw error;
  } finally { clearTimeout(timer); }
}

export function normalizeBeautyPackage(value: unknown, kind: BeautyKind) {
  const pack = validateBeautyPackage(value);
  if (pack.kind !== kind) throw Error(kind === 'appearance' ? '请到聊天装扮中领取这份美化' : '请到外观预设中领取这份美化');
  const data = kind === 'chat-decoration' ? validateDecoration(pack.data) : pack.data;
  if (new Blob([JSON.stringify(data)]).size > BEAUTY_MAX_BYTES) throw Error('分享包最多 20 MB，请精简素材');
  return data;
}

export async function readBeautyPackage(input: File, kind: BeautyKind) {
  if (input.size > BEAUTY_MAX_BYTES) throw Error('分享文件最多 20 MB，请精简素材');
  const file = await readShareFile(input, kind);
  let text: string;
  const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (signature[0] === 0x50 && signature[1] === 0x4b) {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    const entry = zip.file('preset.json');
    if (!entry) throw Error('压缩包中缺少 preset.json，请重新导出外观预设');
    // JSZip async() inflates the whole entry; stream and cap actual output too.
    const parts: ArrayBuffer[] = []; let total = 0;
    await new Promise<void>((resolve, reject) => {
      // JSZip exposes this browser streaming API at runtime but omits it from JSZipObject typings.
      interface ByteStream { on(event: 'data', callback: (chunk: Uint8Array) => void): ByteStream; on(event: 'error', callback: (error: Error) => void): ByteStream; on(event: 'end', callback: () => void): ByteStream; pause(): void; resume(): void }
      const stream = (entry as unknown as { internalStream(type: 'uint8array'): ByteStream }).internalStream('uint8array');
      stream.on('data', chunk => {
        total += chunk.byteLength;
        if (total > BEAUTY_MAX_BYTES) { stream.pause(); reject(Error('解压后的预设超过 20 MB')); }
        else parts.push(new Uint8Array(chunk).buffer);
      }).on('error', reject).on('end', resolve).resume();
    });
    text = await new Blob(parts).text();
  } else {
    if (file.size > BEAUTY_MAX_BYTES) throw Error('分享包最多 20 MB');
    text = await file.text();
  }
  let value: unknown;
  try { value = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw Error('请提交导出的美化预设 JSON、ZIP 或 PNG 分享原图'); }
  return normalizeBeautyPackage(value, kind);
}

export async function downloadBeauty(share: BeautyShare, kind: BeautyKind) {
  if (share.kind !== kind) throw Error(kind === 'appearance' ? '这份美化请从聊天装扮领取' : '这份美化请从外观预设领取');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`${BEAUTY_SHARE_URL}/api/shares/${share.code}/file?revision=${share.revision}`, { signal: controller.signal, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) {
      const rawText = await response.text().catch(() => '');
      throw Error(parseBeautyErrorText(rawText, response.status, '下载失败'));
    }
    const reader = response.body?.getReader(); if (!reader) throw Error('文件内容为空');
    const chunks: ArrayBuffer[] = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > BEAUTY_MAX_BYTES) { await reader.cancel(); throw Error('分享包超过大小限制'); }
      chunks.push(new Uint8Array(value).buffer);
    }
    const blob = new Blob(chunks); const buffer = await blob.arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(n => n.toString(16).padStart(2, '0')).join('');
    if (digest !== share.sha256 || size !== share.bytes) throw Error('文件校验失败，请重新领取');
    return normalizeBeautyPackage(JSON.parse(await blob.text()), kind);
  } finally { clearTimeout(timer); }
}
