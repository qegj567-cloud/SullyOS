import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider, useOS } from '../../context/OSContext';
import { MusicProvider } from '../../context/MusicContext';
import { DB } from '../../utils/db';
import type { APIConfig, CharacterProfile, Message } from '../../types';
import Chat from '../../apps/Chat';
import CallApp from '../../apps/CallApp';
import GroupChat from '../../apps/GroupChat';
import DateSession from '../../components/date/DateSession';
import DialogueVoicePanel from '../../components/voice/DialogueVoicePanel';
import StreamingVoiceBar from '../../components/voice/StreamingVoiceBar';
import { useStreamingVoice } from '../../hooks/useStreamingVoice';
import { IncrementalCallSpeech } from '../../utils/incrementalCallSpeech';
import { safeFetchJson } from '../../utils/safeApi';

// Standalone QA origin only. All model/audio requests use synthetic text and PCM.
const characters = ['甲', '乙'].map((name, i) => ({ id: `qa-voice-${i}`, name: `配音${name}`, avatar: '', systemPrompt: '用于语音模拟验收。', voiceProfile: { elevenLabsVoiceId: `voice_test_${i}` }, chatVoiceEnabled: true, chatVoiceAutoPlay: true, dateVoiceEnabled: true, dateAppearance: { preset: 'paper' }, showThinkingChain: false } as CharacterProfile));
const config = { ttsProvider: 'elevenlabs', elevenLabsApiKey: 'qa-only', elevenLabsModel: 'eleven_v4', baseUrl: '/qa-voice/v1', apiKey: 'qa-only', model: 'qa-only', stream: false } as APIConfig;
const telemetry = { requests: [] as { text: string; at: number; dialogue: boolean }[], audioStarts: [] as number[], textDone: 0, cancelled: 0, openAudio: 0 };
(window as any).voiceQA = { telemetry, DB };
const originalFetch = window.fetch.bind(window);
const originalCreateSource = AudioContext.prototype.createBufferSource;
AudioContext.prototype.createBufferSource = function () {
  const source = originalCreateSource.call(this);
  const start = source.start.bind(source);
  source.start = (...args: Parameters<typeof source.start>) => { telemetry.audioStarts.push(performance.now()); start(...args); };
  return source;
};
const pcm = new Int16Array(10800);
for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i * 2 * Math.PI * 330 / 24000) * 800;
const bytes = new Uint8Array(pcm.buffer);
const base64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
window.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('/elevenlabs/tts')) {
    const body = JSON.parse(String(init?.body));
    const text = body.text || body.inputs.map((line: any) => line.text).join('');
    telemetry.requests.push({ text, at: performance.now(), dialogue: !!body.inputs }); telemetry.openAudio++;
    const chars = Array.from(text) as string[];
    const midpoint = Math.ceil(chars.length / 2);
    let closed = false; const timers: ReturnType<typeof setTimeout>[] = [];
    return new Response(new ReadableStream({
      start(controller) {
        const finish = () => { if (closed) return; closed = true; telemetry.openAudio--; timers.forEach(clearTimeout); };
        init?.signal?.addEventListener('abort', () => { if (closed) return; finish(); telemetry.cancelled++; controller.error(new DOMException('canceled', 'AbortError')); }, { once: true });
        for (let i = 0; i < 2; i++) timers.push(setTimeout(() => {
          if (closed) return;
          const letters = i ? chars.slice(midpoint) : chars.slice(0, midpoint);
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ audio_base64: base64, alignment: { characters: letters, character_start_times_seconds: letters.map((_, j) => j * .45 / letters.length), character_end_times_seconds: letters.map((_, j) => (j + 1) * .45 / letters.length) } }) + '\n'));
        }, i ? 400 : 40));
        timers.push(setTimeout(() => { if (!closed) { finish(); controller.close(); } }, 700));
      },
      cancel() { if (!closed) { closed = true; telemetry.openAudio--; telemetry.cancelled++; timers.forEach(clearTimeout); } },
    }), { headers: { 'Content-Type': 'application/json', 'request-id': `qa-${telemetry.requests.length}` } });
  }
  if (url.includes('/chat/completions')) {
    const body = JSON.parse(String(init?.body));
    if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { content: '你好。这是模拟回复。' } }] }), { headers: { 'Content-Type': 'application/json' } });
    return new Response(new ReadableStream({ start(controller) {
      const parts = ['<think>这句不应该念出来。</think>你好。', '第二句话正在写。', '最后一句。'];
      parts.forEach((content, i) => setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        if (i === 2) { telemetry.textDone = performance.now(); controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); }
      }, 100 + i * 1000));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  return originalFetch(input, init);
};
if (!localStorage.getItem('voice-qa-seeded')) {
  for (const char of characters) await DB.saveCharacter(char);
  await DB.saveGroup({ id: 'qa-voice-group', name: '多人配音验收', members: characters.map(c => c.id), createdAt: 1 });
  for (const [i, char] of characters.entries()) await DB.saveMessage({ groupId: 'qa-voice-group', charId: char.id, role: 'assistant', type: 'text', content: i ? '你好，我们一起配音吧。' : '今天来测试两个人的对话。' } as any);
  await DB.saveMessage({ charId: characters[0].id, role: 'assistant', type: 'text', content: '<语音>点我试听同步字幕。</语音>' });
  localStorage.setItem('os_api_config', JSON.stringify(config));
  localStorage.setItem('os_last_active_char_id', characters[0].id);
  localStorage.setItem('sully-call-update-preferences-2026-08-v2', 'seen');
  localStorage.setItem('voice-qa-seeded', '1');
}
function Lab() {
  const [page, setPage] = useState('基础');
  const [dialogue, setDialogue] = useState(false);
  const [error, setError] = useState('');
  const voice = useStreamingVoice(page);
  const { userProfile } = useOS();
  const sequence = async () => {
    setError(''); voice.prime();
    const live = voice.sequence('sequence', characters[0], config);
    const parser = new IncrementalCallSpeech(text => live.append(text));
    try {
      const result = await safeFetchJson('/qa-voice/v1/chat/completions', { method: 'POST', body: JSON.stringify({ stream: true }) }, 0, 0, undefined, { onDelta: (_d, text) => parser.update(text) });
      parser.finish(result.choices[0].message.content); live.finish(); await live.result;
    } catch (e) { voice.stop(); setError(String(e)); }
  };
  return <div className="h-full flex flex-col bg-slate-100">
    <nav className="flex gap-2 p-2 bg-white shrink-0">{['基础', '聊天', '电话', '群聊', '见面'].map(name => <button key={name} onClick={() => setPage(name)} className="px-2 py-1 border rounded">{name}</button>)}</nav>
    <main className="relative flex-1 min-h-0">
      {page === '基础' && <div className="p-5 space-y-4">
        <h1>ElevenLabs 模拟验收</h1><p>合成音为轻声正弦波，接口与文字均为测试数据。</p>
        <button onClick={() => void sequence()} className="p-3 bg-emerald-700 text-white rounded">增量句子</button>
        <button onClick={() => void voice.speak('long', '长文分段连续朗读。'.repeat(240), characters[0], config).catch(e => setError(String(e)))} className="p-3 bg-white rounded">长文朗读</button>
        <button onClick={() => setDialogue(true)} className="p-3 bg-white rounded">多人面板</button>
        <StreamingVoiceBar state={voice.state} onStop={voice.stop} /><p role="alert">{error}</p>
        {dialogue && <DialogueVoicePanel lines={characters.map((character, i) => ({ character, text: i ? '我来接第二句。' : '我们来一起说话。' }))} apiConfig={config} onClose={() => setDialogue(false)} />}
      </div>}
      {page === '聊天' && <Chat />}
      {page === '电话' && <CallApp />}
      {page === '群聊' && <GroupChat />}
      {page === '见面' && <DateSession char={characters[0]} userProfile={userProfile} messages={[{ id: 90001, charId: characters[0].id, role: 'assistant', type: 'text', content: '[happy]“今天来读一段长故事。”\n故事的后半段也会接着读。', timestamp: 1 } as Message]} peekStatus="" onSendMessage={async () => ''} onReroll={async () => ''} onExit={() => setPage('基础')} onEditMessage={() => {}} onDeleteMessage={() => {}} onDeleteMessages={async () => {}} onSettings={() => {}} />}
    </main>
  </div>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<OSProvider><MusicProvider><Lab /></MusicProvider></OSProvider>);
import.meta.hot?.dispose(() => { root.unmount(); window.fetch = originalFetch; AudioContext.prototype.createBufferSource = originalCreateSource; });
