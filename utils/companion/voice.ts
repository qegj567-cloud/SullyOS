import type { APIConfig, CharacterProfile } from '../../types';
import { PcmVoicePlayer, pcmToWav, type VoiceCue, splitSpeechText } from '../voiceStream';
import { streamElevenLabsSpeech } from '../elevenLabsStream';
import { synthesizeSpeechDetailed, assertTtsLanguageSupported, stripTtsMarkupForDisplay } from '../ttsRouter';
import { fetchBlobForShare } from '../shareExport';
import { resolveTtsProvider } from '../ttsProvider';

/** One player owned by 同行. The signal stops both current audio and future utterances. */
export class CompanionVoice {
  private context?: AudioContext;
  prime() {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!this.context && Ctor) this.context = new Ctor();
    void this.context?.resume().catch(() => {});
  }
  close() { void this.context?.close().catch(() => {}); this.context = undefined; }

  async play(text: string, char: CharacterProfile, api: APIConfig, signal: AbortSignal, heard: (text: string) => void, onAudible?: () => void, options?: { skipCache?: boolean; language?: string; emotion?: string; record?(blob: Blob): void }) {
    signal.throwIfAborted();
    let started = false;
    const audible = () => { if (!started && !signal.aborted) { started = true; onAudible?.(); } };
    const languageBoost = options?.language;
    assertTtsLanguageSupported(char, api, languageBoost);
    if (resolveTtsProvider(api) === 'elevenlabs') {
      this.prime();
      if (!this.context) throw new Error('当前浏览器不支持音频播放');
      const player = new PcmVoicePlayer(this.context);
      const received: Uint8Array[] = [];
      let cues: VoiceCue[] = [];
      let previous = '';
      const report = () => {
        if (player.currentTime > 0) audible();
        const next = stripTtsMarkupForDisplay(cues.filter(cue => cue.end <= player.currentTime).map(cue => cue.text).join(''), api);
        if (next !== previous) { previous = next; heard(next); }
      };
      const abort = () => {
        report();
        if (started && received.length) {
          let remaining = Math.floor(player.currentTime * player.sampleRate) * 2;
          const audibleBytes = received.map(part => {
            const prefix = part.subarray(0, Math.max(0, remaining)); remaining -= prefix.length; return prefix;
          }).filter(part => part.length);
          if (audibleBytes.length) options?.record?.(pcmToWav(audibleBytes));
        }
        player.stop();
      };
      signal.addEventListener('abort', abort, { once: true });
      const timer = setInterval(report, 80);
      try {
        await player.resume();
        signal.throwIfAborted();
        const result = await streamElevenLabsSpeech(text, char, api, { signal, languageBoost, emotion: options?.emotion,
          onAudio: pcm => { if (options?.record) received.push(pcm); player.push(pcm); }, onCues: next => { cues = next; } });
        await player.finish();
        signal.throwIfAborted();
        report();
        options?.record?.(result.blob);
        heard(text);
      } finally {
        clearInterval(timer); signal.removeEventListener('abort', abort); player.stop();
      }
      return;
    }
    // Existing MP3 providers have no reliable character alignment. Only completed
    // short chunks are committed as heard, never an invented percentage of the text.
    let completed = '';
    for (const chunk of splitSpeechText(text, 160)) {
      signal.throwIfAborted();
      const { url, blob } = await synthesizeSpeechDetailed(chunk, char, api, { languageBoost, emotion: options?.emotion, skipCache: options?.skipCache, signal });
      let localUrl: string | undefined;
      try {
        signal.throwIfAborted(); // Some providers cannot abort an already submitted synthesis.
        const saved = blob || (options?.record ? await fetchBlobForShare(url, 'audio/mpeg', { signal }).catch(() => null) : null);
        signal.throwIfAborted();
        if (!blob && saved) localUrl = URL.createObjectURL(saved);
        const audio = new Audio(localUrl || url);
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: unknown) => {
            signal.removeEventListener('abort', abort);
            audio.onended = null; audio.onerror = null; audio.onplaying = null; audio.pause(); audio.removeAttribute('src');
            error ? reject(error) : resolve();
          };
          const abort = () => finish(signal.reason ?? new DOMException('已停止', 'AbortError'));
          audio.onended = () => finish();
          audio.onplaying = () => {
            audible();
            if (saved) options?.record?.(saved);
            audio.onplaying = null;
          };
          audio.onerror = () => finish(new Error('语音播放失败，请检查音频权限或改用文字模式'));
          signal.addEventListener('abort', abort, { once: true });
          void audio.play().catch(finish);
        });
      } finally { if (localUrl) URL.revokeObjectURL(localUrl); if (url.startsWith('blob:')) URL.revokeObjectURL(url); }
      signal.throwIfAborted();
      completed += chunk;
      heard(completed);
    }
  }
}
