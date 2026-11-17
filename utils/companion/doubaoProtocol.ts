/** Official ASR v3 binary protocol. All lengths and sequence numbers are big-endian. */
export function asrPacket(type: 1 | 2, data: Uint8Array, last = false): ArrayBuffer {
  const buffer = new ArrayBuffer(8 + data.length);
  new Uint8Array(buffer).set([0x11, (type << 4) | (last ? 2 : 0), type === 1 ? 0x10 : 0, 0]);
  new DataView(buffer).setUint32(4, data.length);
  new Uint8Array(buffer, 8).set(data);
  return buffer;
}

export function asrStartPacket() {
  return asrPacket(1, new TextEncoder().encode(JSON.stringify({
    audio: { format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1 },
    request: { model_name: 'bigmodel', enable_itn: true, enable_punc: true,
      enable_ddc: false, show_utterances: true, result_type: 'full', enable_nonstream: true, end_window_size: 800 },
  })));
}

export interface AsrUtterance { text: string; start_time: number; end_time: number; definite?: boolean }
export interface AsrResult { result?: { text?: string; utterances?: AsrUtterance[] } }

export async function parseAsrPacket(buffer: ArrayBuffer): Promise<AsrResult> {
  if (buffer.byteLength < 8 || buffer.byteLength > 1024 * 1024) throw new Error('豆包识别响应大小异常');
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  const type = bytes[1] >> 4, flags = bytes[1] & 15, compression = bytes[2] & 15;
  let offset = (bytes[0] & 15) * 4;
  if (bytes[0] >> 4 !== 1 || offset < 4 || ![9, 15].includes(type) || flags > 3) throw new Error('豆包识别响应协议不支持');
  let code = 0;
  if (flags & 1) offset += 4;
  if (type === 15) {
    if (offset + 4 > bytes.length) throw new Error('豆包识别响应不完整');
    code = view.getUint32(offset); offset += 4;
  }
  if (offset + 4 > bytes.length) throw new Error('豆包识别响应不完整');
  const length = view.getUint32(offset); offset += 4;
  if (offset + length !== bytes.length) throw new Error('豆包识别响应不完整');
  // Never surface server error bodies: they can echo request data or credentials.
  if (type === 15) throw new Error(`豆包识别失败（${code}），请检查语音服务权限、额度和音频配置`);
  let payload: ArrayBuffer = buffer.slice(offset);
  if (compression === 1) {
    const reader = new Blob([payload]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error('豆包识别响应过大'); }
      chunks.push(value);
    }
    const joined = new Uint8Array(size); let position = 0;
    for (const chunk of chunks) { joined.set(chunk, position); position += chunk.length; }
    payload = joined.buffer;
  } else if (compression !== 0) throw new Error('豆包识别压缩格式不支持');
  if (bytes[2] >> 4 !== 1) throw new Error('豆包识别响应不是 JSON');
  try {
    const data = JSON.parse(new TextDecoder().decode(payload));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new Error('豆包识别响应不是有效 JSON'); }
}

/** Full result snapshots include old definite sentences. Never interrupt/re-submit those. */
export class AsrTranscript {
  private committedUntil = -1;
  private pending: string[] = [];
  consume(data: AsrResult) {
    const utterances = data.result?.utterances;
    if (!Array.isArray(utterances)) return { partial: '', finals: [] as string[] };
    const fresh = utterances.filter(u => u && typeof u.text === 'string' && u.text.trim()
      && Number.isFinite(u.start_time) && Number.isFinite(u.end_time) && u.end_time >= u.start_time
      && u.end_time > this.committedUntil).sort((a, b) => a.start_time - b.start_time);
    const finals: string[] = []; const partial: string[] = [];
    for (const u of fresh) {
      if (u.end_time <= this.committedUntil) continue;
      if (u.definite === true) { finals.push(u.text.trim()); this.committedUntil = u.end_time; }
      else partial.push(u.text.trim());
    }
    this.pending.push(...finals);
    // Do not submit the first half while a later segment of the same utterance is still being spoken.
    if (partial.length) return { partial: this.pending.join('') + partial.join(''), finals: [] as string[] };
    const completed = this.pending; this.pending = [];
    return { partial: '', finals: completed };
  }
}
