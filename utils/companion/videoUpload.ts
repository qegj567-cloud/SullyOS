import type { CompanionVideoApiConfig } from '../../types';

export function clipUploadBase(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('临时上传服务需要不含用户名、密码或查询参数的 HTTPS 地址');
  }
  return url.href.replace(/\/+$/, '');
}

/** Upload tokens only go to this explicitly configured service, never to the model endpoint. */
export async function uploadCompanionClip(blob: Blob, config: NonNullable<CompanionVideoApiConfig['upload']>, signal: AbortSignal) {
  signal.throwIfAborted();
  const url = `${clipUploadBase(config.baseUrl)}/clips/${crypto.randomUUID().replace(/-/g, '')}`;
  const headers = { Authorization: `Bearer ${config.token}` };
  const release = async () => {
    const cancel = new AbortController();
    const timer = setTimeout(() => cancel.abort(), 3000);
    try { await fetch(url, { method: 'DELETE', headers, signal: cancel.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' }); }
    catch { /* The service also denies expired reads and sweeps abandoned objects. */ }
    finally { clearTimeout(timer); }
  };
  const cancel = new AbortController();
  const abort = () => cancel.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 15_000);
  try {
    const response = await fetch(url, { method: 'PUT', body: blob,
      headers: { ...headers, 'Content-Type': 'video/mp4' }, signal: cancel.signal,
      cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error(`视频临时上传失败（HTTP ${response.status}）`);
    signal.throwIfAborted();
    return { url, release };
  } catch (error) {
    void release();
    signal.throwIfAborted();
    if (cancel.signal.aborted) throw new Error('视频临时上传超时，请检查上传服务');
    throw error;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
