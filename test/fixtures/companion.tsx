import React from 'react';
import { createRoot } from 'react-dom/client';
import chibi from '../../assets/sar/aiven-chibi.png';
import sleeveUrl from './companion-sleeve.wav?url';
import lightUrl from './companion-light.wav?url';
import { CompanionSurface } from '../../apps/CompanionApp';

// Uses local speech samples and no provider credentials. An explicit favorite uses the local library;
// real shared context/range/API route are covered by requests.test.ts.
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')); };
  signal.addEventListener('abort', abort, { once: true });
});
const samples = [
  { chinese: '我们拿到自然光下看看吧。', english: 'Let us look at it in daylight.', url: lightUrl },
  { chinese: '把袖口翻过来吧，我想看看合不合身。', english: 'Turn the cuff over. I want to see how it fits.', url: sleeveUrl },
];
const answer = (index: number, language?: string) => {
  const sample = samples[index];
  return language === 'en' ? sample.chinese + '\n<语音>' + sample.english + '</语音>' : sample.chinese;
};
createRoot(document.getElementById('root')!).render(<CompanionSurface introKey="sully_companion_fixture_intro_v1"
  initialView={new URLSearchParams(location.search).get('view') === 'tools' ? 'tools' : 'call'}
  characters={[{ id: 'fixture', name: '林间', callVoiceLang: 'en', companionAvatar: { source: 'date' }, sprites: { normal: '/sar-portraits/Aiven/normal.webp', happy: '/sar-portraits/Aiven/happy.webp', chibi }, systemPrompt: '说话温柔但有自己的判断，称呼对方小雨。', contextLimit: 50 } as any]}
  user={{ name: '小雨' } as any} api={{} as any} close={() => { window.location.assign('/'); }}
  playSample={async (text, signal, heard, started, speech) => {
    const sample = samples.find(item => item.english === text);
    if (!sample) { started('text'); heard(text); return; }
    const blob = await (await fetch(sample.url, { signal })).blob();
    signal.throwIfAborted();
    const url = URL.createObjectURL(blob), audio = new Audio(url);
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        audio.onplaying = () => { started('audio'); speech.record(blob); audio.onplaying = null; };
        audio.onended = () => { signal.removeEventListener('abort', abort); resolve(); };
        audio.onerror = () => { signal.removeEventListener('abort', abort); reject(new Error('示例语音读取失败')); };
        void audio.play().catch(error => { signal.removeEventListener('abort', abort); reject(error); });
      });
      heard(text);
    } finally { audio.pause(); audio.removeAttribute('src'); URL.revokeObjectURL(url); }
  }}
  requestFactory={({ debug }) => ({
    quick: async (_history, signal, language) => { const trace = debug?.get(signal); trace?.begin('quick_request'); await wait(900, signal); trace?.end('quick_request'); return answer(0, language); },
    prepare: async (_, quick, signal) => { const trace = debug?.get(signal); trace?.begin('full_prepare'); trace?.begin('memory'); await wait(650, signal); trace?.end('memory'); await quick; trace?.end('full_prepare'); return {} as any; },
    full: async (_, signal, _quickEnabled, language) => { const trace = debug?.get(signal); trace?.begin('full_request'); await wait(1400, signal); trace?.end('full_request'); return answer(1, language); },
  })}
/>);
