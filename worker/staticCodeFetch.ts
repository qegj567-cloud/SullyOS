// Only used for local hashed JS/CSS. Do not buffer API streams, models, audio or video here.
export const CODE_IDLE_TIMEOUT_MS = 30_000;
const MAX_CODE_BYTES = 16 * 1024 * 1024;

export class StaticCodeTimeoutError extends Error {
  constructor() { super('Static code download stopped making progress'); }
}
export class StaticCodeBodyError extends Error {
  constructor() { super('Static code body could not be read completely'); }
}

/** Bound both waiting for headers and gaps between body chunks. Slow, progressing downloads
 * remain valid. Racing as well as aborting also covers a stream that ignores AbortSignal. */
export async function loadStaticCode(
  source: (signal: AbortSignal) => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupt!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_, reject) => { interrupt = reject; });
  const stop = (reason: unknown) => {
    interrupt(reason);
    controller.abort();
    void reader?.cancel().catch(() => {});
  };
  const onAbort = () => stop(new DOMException('Request aborted', 'AbortError'));
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => stop(new StaticCodeTimeoutError()), CODE_IDLE_TIMEOUT_MS);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    arm();
    if (signal?.aborted) onAbort();
    const response = await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new DOMException('Request aborted', 'AbortError');
        return source(controller.signal);
      }).then(response => {
        // A non-cooperative fetch may finish after the deadline; never retain that body.
        if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
        return response;
      }),
      interrupted,
    ]);
    if (!response.ok || !response.body) return response;
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      arm();
      const { value, done } = await Promise.race([reader.read(), interrupted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CODE_BYTES) throw new Error('Static code exceeds size limit');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const headers = new Headers(response.headers);
    headers.delete('Content-Encoding');
    headers.set('Content-Length', String(size));
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    const failure = reader && !controller.signal.aborted ? new StaticCodeBodyError() : error;
    controller.abort();
    void reader?.cancel().catch(() => {});
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
