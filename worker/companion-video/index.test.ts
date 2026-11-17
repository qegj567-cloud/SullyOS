import { afterEach, expect, it, vi } from 'vitest';
import worker from './index.js';

const origin = 'http://127.0.0.1:5175';
const id = 'a'.repeat(32), endpoint = `https://clips.example/clips/${id}`;
const token = 't'.repeat(32);
const bytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]);
function fixture() {
  const entries = new Map<string, any>();
  const bucket = {
    put: vi.fn(async (key, data, metadata) => entries.set(key, { ...metadata, size: data.length, bytes: data })),
    head: vi.fn(async key => entries.get(key)),
    get: vi.fn(async (key, options) => { const object = entries.get(key); return object && { ...object, body: options?.range ? object.bytes.slice(options.range.offset, options.range.offset + options.range.length) : object.bytes }; }),
    delete: vi.fn(async key => { for (const k of Array.isArray(key) ? key : [key]) entries.delete(k); }),
    list: vi.fn(async () => ({ objects: [...entries].map(([key, value]) => ({ key, customMetadata: value.customMetadata })), truncated: false })),
  };
  const env = { CLIPS: bucket, UPLOAD_TOKEN: token, ALLOWED_ORIGINS: origin };
  const request = (method = 'GET', overrides: Record<string, string> = {}, body?: BodyInit) => new Request(endpoint, {
    method, headers: { ...(method === 'PUT' || method === 'DELETE' ? { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'video/mp4' } : {}), ...overrides }, body,
  });
  const upload = () => worker.fetch(request('PUT', {}, bytes), env);
  return { env, bucket, request, upload };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('accepts only authenticated, bounded MP4 uploads from configured origins', async () => {
  const { env, request, bucket } = fixture();
  expect((await worker.fetch(request('PUT', { Authorization: 'Bearer wrong' }, bytes), env)).status).toBe(401);
  expect((await worker.fetch(request('PUT', { Origin: 'https://other.example' }, bytes), env)).status).toBe(403);
  expect((await worker.fetch(request('PUT', { 'Content-Length': String(9 * 1024 * 1024) }, bytes), env)).status).toBe(413);
  expect((await worker.fetch(request('PUT', {}, 'invalid'), env)).status).toBe(415);
  expect(bucket.put).not.toHaveBeenCalled();
  const response = await worker.fetch(request('PUT', {}, bytes), env);
  expect(response.status).toBe(204); expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  expect(bucket.put).toHaveBeenCalledOnce();
});

it('serves video HEAD and Range to the provider, refuses expiry, and authenticates deletion', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const { env, request, upload, bucket } = fixture(); await upload();
  const whole = await worker.fetch(request(), env);
  expect(whole.status).toBe(200); expect(whole.headers.get('Cache-Control')).toBe('no-store');
  expect(new Uint8Array(await whole.arrayBuffer())).toEqual(bytes);
  const part = await worker.fetch(request('GET', { Range: 'bytes=4-7' }), env);
  expect(part.status).toBe(206); expect(await part.text()).toBe('ftyp'); expect(part.headers.get('Content-Range')).toBe('bytes 4-7/12');
  expect((await worker.fetch(request('HEAD'), env)).headers.get('Content-Length')).toBe('12');
  expect((await worker.fetch(request('DELETE', { Authorization: 'wrong' }), env)).status).toBe(401);
  vi.advanceTimersByTime(120_000);
  expect((await worker.fetch(request(), env)).status).toBe(410); expect(bucket.delete).toHaveBeenCalled();
});

it('sweeps expired abandoned clips while retaining live ones', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const { env, upload, bucket } = fixture(); await upload();
  await worker.scheduled({}, env); expect(bucket.delete).not.toHaveBeenCalled();
  vi.advanceTimersByTime(120_001); await worker.scheduled({}, env);
  expect(bucket.delete).toHaveBeenCalledWith([`companion-clips/${id}`]);
});
