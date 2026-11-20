import type { APIConfig, CharacterProfile } from '../../types';
import { PcmVoicePlayer, type VoiceCue, splitSpeechText } from '../voiceStream';
import { streamElevenLabsSpeech } from '../elevenLabsStream';
import { synthesizeSpeech, stripTtsMarkupForDisplay } from '../ttsRouter';
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

  async play(text: string, char: CharacterProfile, api: APIConfig, signal: AbortSignal, heard: (text: string) => void, onAudible?: () => void, options?: { skipCache?: boolean }) {
    signal.throwIfAborted();
    let started = false;
    const audible = () => { if (!started && !signal.aborted) { started = true; onAudible?.(); } };
    if (resolveTtsProvider(api) === 'elevenlabs') {
      this.prime();
      if (!this.context) throw new Error('当前浏览器不支持音频播放');
      const player = new PcmVoicePlayer(this.context);
      let cues: VoiceCue[] = [];
      let previous = '';
      const report = () => {
        if (player.currentTime > 0) audible();
        const next = stripTtsMarkupForDisplay(cues.filter(cue => cue.end <= player.currentTime).map(cue => cue.text).join(''), api);
        if (next !== previous) { previous = next; heard(next); }
      };
      const abort = () => { report(); player.stop(); };
      signal.addEventListener('abort', abort, { once: true });
      const timer = setInterval(report, 80);
      try {
        await player.resume();
        signal.throwIfAborted();
        await streamElevenLabsSpeech(text, char, api, { signal, onAudio: pcm => player.push(pcm), onCues: next => { cues = next; } });
        await player.finish();
        signal.throwIfAborted();
        report();
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
      const url = await synthesizeSpeech(chunk, char, api, { ...options, signal });
      try {
        signal.throwIfAborted(); // Some providers cannot abort an already submitted synthesis.
        const audio = new Audio(url);
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: unknown) => {
            signal.removeEventListener('abort', abort);
            audio.onended = null; audio.onerror = null; audio.onplaying = null; audio.pause(); audio.removeAttribute('src');
            error ? reject(error) : resolve();
          };
          const abort = () => finish(signal.reason ?? new DOMException('已停止', 'AbortError'));
          audio.onended = () => finish();
          audio.onplaying = audible;
          audio.onerror = () => finish(new Error('语音播放失败，请检查音频权限或改用文字模式'));
          signal.addEventListener('abort', abort, { once: true });
          void audio.play().catch(finish);
        });
      } finally { if (url.startsWith('blob:')) URL.revokeObjectURL(url); }
      signal.throwIfAborted();
      completed += chunk;
      heard(completed);
    }
  }
}
