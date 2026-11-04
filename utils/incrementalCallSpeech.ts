import { parseCallAssistantMessage, stripCallTextFormatting } from './callReplyFormat';

/** Consume cumulative SSE content. Never send incomplete reasoning/acting markup to TTS. */
export class IncrementalCallSpeech {
  private emitted = '';
  constructor(private readonly emit: (text: string) => void, private readonly voiceOnly = false) {}

  update(raw: string, final = false): void {
    const safe = raw.replace(/<[^>]*$/, '').replace(/\[\[(?:(?!\]\])[^])*$/, '');
    let content = parseCallAssistantMessage({ content: safe }).text;
    if (this.voiceOnly) {
      const voice = content.match(/<[语語]音(?=\s|>)[^>]*>([^]*?)(?:<\/[语語]音\s*>|$)/);
      if (!voice && !final) return;
      content = voice ? voice[1] : content;
    }
    content = content.replace(/<\/?[语語]音[^>]*>/g, '').replace(/%%BILINGUAL%%[^]*/i, '');
    const text = stripCallTextFormatting(content)
      .replace(/\[v:\s*[a-z_]+\]/gi, '').trim();
    if (!text.startsWith(this.emitted)) throw new Error('模型流改写了已播放台词，请重新生成');
    const tail = text.slice(this.emitted.length);
    let bracket = 0;
    let ipa = false;
    let end = 0;
    for (let i = 0; i < tail.length; i++) {
      const c = tail[i];
      if (c === '[') bracket++;
      if (c === ']') bracket = Math.max(0, bracket - 1);
      if (!bracket && c === '/') ipa = !ipa;
      if (!bracket && !ipa && /[。！？!?；;\n]/.test(c)) end = i + 1;
      // A period at the current edge can still become a decimal or abbreviation.
      if (!bracket && !ipa && c === '.' && (final || i + 1 < tail.length) && !/\d/.test(tail[i + 1] || '') && !/[A-Za-z]/.test(tail[i + 1] || '')) end = i + 1;
    }
    if (final && bracket) throw new Error('语音标签未闭合，已停止剩余台词，请检查正文后重播');
    // A lone slash can be ordinary prose. At EOF it must not silently discard text.
    if (final) end = tail.length;
    if (end) {
      const sentence = tail.slice(0, end);
      this.emitted += sentence;
      if (sentence.trim()) this.emit(sentence);
    }
  }

  finish(text: string): void { this.update(text, true); }
}
