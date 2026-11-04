import { Capacitor } from '@capacitor/core';
import type { APIConfig, CharacterProfile } from '../types';
import { DB } from './db';
import { hashTtsParams } from './ttsCache';
import { getProxyWorkerUrl } from './proxyWorker';
import { isStaticWebDeployment } from './staticWebDeployment';
import { friendlyElevenLabsError, buildElevenLabsRequestBody, normalizeElevenLabsVoiceId, resolveElevenLabsApiKey, resolveElevenLabsModel } from './elevenLabsTts';
import { isElevenLabsV4Model } from './elevenLabsModels';
import { decodeVoiceBase64, pcmToWav, readVoiceJsonStream, splitSpeechText, throwIfVoiceAborted, VOICE_SAMPLE_RATE, type VoiceCue } from './voiceStream';

export interface StreamedVoice {
  blob: Blob;
  cues: VoiceCue[];
  duration: number;
}
export interface VoiceStreamOptions {
  signal?: AbortSignal;
  languageBoost?: string;
  emotion?: string;
  previousText?: string;
  onAudio?: (pcm: Uint8Array) => void;
  onCues?: (cues: VoiceCue[]) => void;
}
export interface DialogueLine { text: string; character: CharacterProfile }
type RequestPart = { voiceId?: string; body: Record<string, unknown> };

/** A single consumer drains complete sentences while the LLM is still producing text. */
export class VoiceTextQueue {
  private pending: string[] = [];
  private ended = false;
  private wake?: () => void;
  append(text: string): void {
    if (this.ended) throw new Error('语音文本队列已结束');
    if (text.trim()) this.pending.push(text);
    this.wake?.();
  }
  finish(): void { this.ended = true; this.wake?.(); }
  async next(signal?: AbortSignal): Promise<string | null> {
    while (true) {
      throwIfVoiceAborted(signal);
      if (this.pending.length) return this.pending.shift()!;
      if (this.ended) return null;
      await new Promise<void>(resolve => {
        const wake = () => { signal?.removeEventListener('abort', wake); this.wake = undefined; resolve(); };
        this.wake = wake;
        signal?.addEventListener('abort', wake, { once: true });
        if (signal?.aborted) wake();
      });
    }
  }
}

export async function streamElevenLabsSequence(queue: VoiceTextQueue, character: CharacterProfile, config: APIConfig, options: VoiceStreamOptions = {}): Promise<StreamedVoice> {
  const chunks: Uint8Array[] = [];
  const cues: VoiceCue[] = [];
  let duration = 0;
  let previousText = '';
  while (true) {
    const text = await queue.next(options.signal);
    if (text === null) break;
    let currentCues: VoiceCue[] = [];
    const result = await streamElevenLabsSpeech(text, character, config, {
      ...options, previousText,
      onAudio: pcm => { chunks.push(pcm); options.onAudio?.(pcm); },
      onCues: next => {
        currentCues = next.map(cue => ({ ...cue, start: duration + cue.start, end: duration + cue.end }));
        options.onCues?.([...cues, ...currentCues]);
      },
    });
    cues.push(...currentCues); duration += result.duration;
    previousText = text;
  }
  throwIfVoiceAborted(options.signal);
  if (!chunks.length) throw new Error('没有可朗读的台词');
  return { blob: pcmToWav(chunks), cues, duration };
}

function voiceIdFor(character: CharacterProfile): string {
  const id = normalizeElevenLabsVoiceId(character.voiceProfile?.elevenLabsVoiceId);
  if (!id) throw new Error(`${character.name || '角色'}未配置 ElevenLabs Voice ID`);
  return id;
}

function streamUrl(voiceId?: string): string {
  const worker = Capacitor.isNativePlatform() || (typeof window !== 'undefined'
    && isStaticWebDeployment(window.location.protocol, window.location.hostname));
  const query = voiceId ? `voice_id=${encodeURIComponent(voiceId)}` : 'mode=dialogue';
  return `${worker ? `${getProxyWorkerUrl()}/elevenlabs/tts` : '/api/elevenlabs/tts'}?${query}&timestamps=1&output_format=pcm_24000`;
}

function appendAlignment(target: VoiceCue[], frame: any, offset: number): void {
  const alignment = frame.normalized_alignment || frame.alignment;
  if (!alignment?.characters) return;
  const chars: unknown[] = alignment.characters;
  chars.forEach((text, i) => {
    const start = alignment.character_start_times_seconds?.[i];
    const end = alignment.character_end_times_seconds?.[i];
    if (typeof text !== 'string' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return;
    const segment = frame.voice_segments?.find((v: any) => i >= v.character_start_index && i < v.character_end_index);
    target.push({ text, start: offset + start, end: offset + end, ...(segment?.voice_id ? { voiceId: segment.voice_id } : {}) });
  });
}

/** The cache stores complete PCM/WAV and alignment together; failed/aborted streams never enter it. */
async function generate(parts: RequestPart[], config: APIConfig, options: VoiceStreamOptions): Promise<StreamedVoice> {
  throwIfVoiceAborted(options.signal);
  const apiKey = resolveElevenLabsApiKey(config);
  if (!apiKey) throw new Error('缺少 ElevenLabs API Key');
  const cacheKey = hashTtsParams({ kind: 'elevenlabs-timed-pcm-v1', parts, output_format: 'pcm_24000' });
  const cached = await DB.getAssetRaw(cacheKey).catch(() => null) as StreamedVoice | null;
  throwIfVoiceAborted(options.signal);
  if (cached?.blob instanceof Blob && Array.isArray(cached.cues)) {
    options.onCues?.(cached.cues);
    const pcm = new Uint8Array(await cached.blob.slice(44).arrayBuffer());
    throwIfVoiceAborted(options.signal);
    // Short scheduling blocks keep replay cancellable and avoid huge WebAudio buffers.
    for (let i = 0; i < pcm.length; i += VOICE_SAMPLE_RATE * 2) {
      throwIfVoiceAborted(options.signal);
      options.onAudio?.(pcm.slice(i, i + VOICE_SAMPLE_RATE * 2));
    }
    return cached;
  }
  const chunks: Uint8Array[] = [];
  const cues: VoiceCue[] = [];
  const requestIds: string[] = [];
  let byteCount = 0;
  for (const part of parts) {
    throwIfVoiceAborted(options.signal);
    const body = { ...part.body };
    // v3 does not support request stitching. Model choice is never changed automatically.
    if (isElevenLabsV4Model(config.elevenLabsModel) && requestIds.length) body.previous_request_ids = requestIds.slice(-3);
    // Native streaming goes through the CORS proxy using WebView fetch, not CapacitorHttp's buffered bridge.
    const nativeFetch = typeof window !== 'undefined' ? (window as any).CapacitorWebFetch : undefined;
    const fetcher: typeof fetch = nativeFetch ? nativeFetch.bind(window) : fetch;
    const response = await fetcher(streamUrl(part.voiceId), {
      method: 'POST', signal: options.signal,
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey, Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(friendlyElevenLabsError(response.status, await response.text()));
    const requestId = response.headers.get('request-id');
    await readVoiceJsonStream(response, frame => {
      // HTTP alignment accompanies each audio chunk; offset it by preceding PCM duration.
      appendAlignment(cues, frame, byteCount / (VOICE_SAMPLE_RATE * 2));
      options.onCues?.(cues.slice());
      if (frame.audio_base64) {
        const pcm = decodeVoiceBase64(frame.audio_base64);
        chunks.push(pcm); byteCount += pcm.length;
        options.onAudio?.(pcm);
      }
    }, options.signal);
    if (requestId) requestIds.push(requestId);
  }
  throwIfVoiceAborted(options.signal);
  if (!byteCount) throw new Error('ElevenLabs 返回了空音频');
  const result = { blob: pcmToWav(chunks), cues, duration: byteCount / (VOICE_SAMPLE_RATE * 2) };
  await DB.saveAssetRaw(cacheKey, { ...result, createdAt: Date.now(), lastUsedAt: Date.now() }).catch(() => {});
  return result;
}

export async function streamElevenLabsSpeech(
  text: string, character: CharacterProfile, config: APIConfig, options: VoiceStreamOptions = {},
): Promise<StreamedVoice> {
  const voiceId = voiceIdFor(character);
  const payload = buildElevenLabsRequestBody(text, character, config, options);
  if (!payload.text.trim()) throw new Error('没有可朗读的台词');
  const texts = splitSpeechText(payload.text);
  const parts = texts.map((part, i) => ({
    voiceId,
    body: {
      ...payload, text: part,
      ...(isElevenLabsV4Model(payload.model_id) ? {
        previous_text: i ? texts[i - 1] : options.previousText || '',
        next_text: texts[i + 1] || '',
      } : {}),
    },
  }));
  return generate(parts, config, options);
}

export async function streamElevenLabsDialogue(
  lines: DialogueLine[], config: APIConfig, options: VoiceStreamOptions = {},
): Promise<StreamedVoice> {
  const model = resolveElevenLabsModel(config);
  if (!isElevenLabsV4Model(model) && model !== 'eleven_v3') throw new Error('多人配音需要 Eleven v4 或 v3');
  const inputs = lines.flatMap(line => {
    const voice_id = voiceIdFor(line.character);
    const text = buildElevenLabsRequestBody(line.text, line.character, config, options).text;
    return splitSpeechText(text).filter(part => part.trim()).map(part => ({ text: part, voice_id }));
  });
  if (!inputs.length) throw new Error('请选择有台词的角色消息');
  const voiceCount = new Set(inputs.map(input => input.voice_id)).size;
  if (voiceCount > 10) throw new Error('一段配音最多支持 10 个不同音色');
  if (model === 'eleven_v4_turbo' && voiceCount > 1) throw new Error('v4 Turbo 仅支持单音色，请在设置中选择 Eleven v4 后再生成多人配音');
  const batches: typeof inputs[] = [];
  let batch: typeof inputs = [];
  let count = 0;
  for (const input of inputs) {
    const length = Array.from(input.text).length;
    if (count + length > 1800 && batch.length) { batches.push(batch); batch = []; count = 0; }
    batch.push(input); count += length;
  }
  if (batch.length) batches.push(batch);
  const language = options.languageBoost || '';
  const parts = batches.map(inputs => ({ body: {
    inputs, model_id: model, ...(/^[a-z]{2}$/.test(language) ? { language_code: language } : {}),
  } }));
  return generate(parts, config, options);
}
