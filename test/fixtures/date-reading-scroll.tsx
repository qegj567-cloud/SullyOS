import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OSPreviewProvider } from '../../context/OSContext';
import DateSession from '../../components/date/DateSession';
import type { CharacterProfile, Message } from '../../types';

// Only the surrounding data is synthetic; all rendering and scrolling use DateSession.
const character = { id: 'qa-date-scroll', name: '见面回归', avatar: '', dateVoiceEnabled: false } as CharacterProfile;
const makeMessages = (first: number, count: number): Message[] => Array.from({ length: count }, (_, index) => {
  const id = first + index;
  return { id, charId: character.id, role: id % 2 ? 'user' : 'assistant', type: 'text', timestamp: id,
    content: id % 2 ? `用户第 ${id} 条：接下来会发生什么？` : Array.from({ length: 12 + id % 5 }, (_, line) => `[normal] 第 ${id} 条 · 段落 ${line + 1}：窗外的雨已经停了，他回过头看着你，慢慢讲起刚才没说完的那个故事。`).join('\n'),
    metadata: { source: 'date', dateEncounterId: 'qa-current' } } as Message;
});

function App() {
  const [messages, setMessages] = useState(() => makeMessages(51, 50));
  const [session, setSession] = useState(0);
  const [paper, setPaper] = useState(false);
  const [report, setReport] = useState('50 条长短交错记录。菜单切换阅读模式后，应该一直停在最新一条的末尾。上翻加载更早记录应保留当前阅读位置。');
  const append = async () => {
    const next = makeMessages((messages.at(-1)?.id ?? 100) + 1, 2);
    setMessages(previous => [...previous, ...next]);
    return next[1].content;
  };
  const os = { theme: {}, apiConfig: {}, addToast: setReport, registerBackHandler: () => () => {}, updateCharacter: () => {} } as any;
  return <OSPreviewProvider value={os}><div className="qa-layout">
    <div className="qa-phone"><DateSession key={session} char={{ ...character, dateAppearance: { preset: paper ? 'paper' : 'none' } }}
      userProfile={{ name: '测试用户' } as any} messages={messages} peekStatus={messages.at(-1)?.content || ''}
      encounterId="qa-current" onSendMessage={append} onReroll={append} onExit={() => setReport('退出')}
      onEditMessage={() => {}} onDeleteMessage={() => {}} onDeleteMessages={async () => {}} onSettings={() => {}}
      onLoadMoreHistory={async () => setMessages(previous => [...makeMessages(previous[0].id - 50, 50), ...previous])}
      historyReachedEnd={messages.length > 0 && messages[0].id <= 1} />
    </div>
    <aside className="qa-report"><h1>见面阅读位置回归</h1>
      <button onClick={() => void append()}>模拟生成新回复</button>
      <button onClick={() => setSession(previous => previous + 1)}>退出后重新进入</button>
      <button onClick={() => { setPaper(previous => !previous); setSession(previous => previous + 1); }}>切换默认阅读外观</button>
      <button onClick={() => setMessages([])}>模拟读取前的空历史</button>
      <button onClick={() => setMessages(makeMessages(51, 50))}>完成异步历史读取</button>
      <button onClick={() => {
        const element = document.querySelector<HTMLElement>('.meeting-reading-page');
        if (!element) { setReport('当前为立绘模式'); return; }
        const bounds = element.getBoundingClientRect();
        const visible = [...element.querySelectorAll<HTMLElement>('[data-date-message-id]')]
          .filter(row => { const r = row.getBoundingClientRect(); return r.bottom > bounds.top && r.top < bounds.bottom; })
          .map(row => row.dataset.dateMessageId);
        setReport(JSON.stringify({ top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight,
          bottomGap: element.scrollHeight - element.clientHeight - element.scrollTop, visible }, null, 2));
      }}>检查阅读位置</button>
      <pre role="status">{report}</pre>
    </aside>
  </div></OSPreviewProvider>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<App />);
import.meta.hot?.dispose(() => root.unmount());
