import React from 'react';
import { createRoot } from 'react-dom/client';
import { CompanionSurface } from '../../apps/CompanionApp';

// No production storage or credentials. This page only exercises UI/orchestration;
// real shared context/range/API route are covered by requests.test.ts.
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(new DOMException('已取消', 'AbortError')); };
  signal.addEventListener('abort', abort, { once: true });
});
createRoot(document.getElementById('root')!).render(<CompanionSurface
  characters={[{ id: 'fixture', name: '林间', systemPrompt: '说话温柔但有自己的判断，称呼对方小雨。', contextLimit: 50 } as any]}
  user={{ name: '小雨' } as any} api={{} as any} close={() => { document.title = '同行已关闭'; }}
  requestFactory={({ debug }) => ({
    quick: async (history, signal) => { const trace = debug?.get(signal); trace?.begin('quick_request'); await wait(900, signal); trace?.end('quick_request'); return `你说“${history.at(-1)?.text}”，我听着呢。先把衣服拿到自然光下看看，店里的灯光有时候会把颜色变暖。`; },
    prepare: async (_, quick, signal) => { const trace = debug?.get(signal); trace?.begin('full_prepare'); trace?.begin('memory'); await wait(4000, signal); trace?.end('memory'); await quick; trace?.end('full_prepare'); return {} as any; },
    full: async (_, signal) => { const trace = debug?.get(signal); trace?.begin('full_request'); await wait(8000, signal); trace?.end('full_request'); return '再看看肩线落在哪里。如果你想搭那条浅色裤子，这件的颜色倒是很容易配。你把袖口翻过来给我看看？'; },
  })}
/>);
