import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OSProvider, useOS } from '../../context/OSContext';
import Character from '../../apps/Character';
import Settings from '../../apps/Settings';
import { DB } from '../../utils/db';
import type { ApiCallLogEntry } from '../../utils/apiCallLog';
import DateSettings from '../../components/date/DateSettings';

function Preview() {
  const os = useOS();
  const [logHint, setLogHint] = useState('');
  const [page, setPage] = useState('settings');
  const seed = () => {
    os.updateApiConfig({ baseUrl: 'https://default.example/v1', apiKey: 'demo-only', model: 'default-model' });
    const groups = ['日常对话', '创作写作', '长文阅读', '备用线路', ''];
    const names = ['轻快', '均衡', '细腻', '深度', '超长模型名称与移动端换行展示'];
    os.apiPresets.filter(p => p.name.startsWith('演示 · ')).forEach(p => os.removeApiPreset(p.id));
    for (let i = 4; i >= 0; i--) groups.forEach((group, g) => {
      os.addApiPreset(`演示 · ${g + 1}-${i + 1} ${names[i]}`, {
        baseUrl: 'https://api-preview.example.invalid/v1', apiKey: 'demo-only',
        model: `demo-model-${g + 1}-${i + 1}`, stream: false, temperature: 0.85,
      }, group);
    });
    os.setAvailableModels(['default-model', 'default-model-long-name-for-mobile-layout-review']);
  };
  const seedLarge = () => {
    os.apiPresets.filter(p => p.name.startsWith('压力预设 ')).forEach(p => os.removeApiPreset(p.id));
    for (let i = 1; i <= 60; i++) os.addApiPreset(`压力预设 ${i}`, {
      baseUrl: 'https://api-preview.example.invalid/v1', apiKey: 'demo-only', model: `demo-${i}`,
    });
  };
  const seedLogs = async () => {
    const now = Date.now();
    const entries: ApiCallLogEntry[] = Array.from({ length: 12 }, (_, i) => {
      const failed = i % 5 === 1, pending = i === 2;
      return { id: `api-preview-log-${i}`, timestamp: now - i * 180000,
        appId: i % 2 ? 'settings' : 'chat', appName: i % 2 ? '设置' : '消息', charName: i % 2 ? undefined : '演示角色',
        purpose: pending ? '聊天回复（演示）' : failed ? '测试连接（演示失败）' : '聊天回复（演示）',
        presetName: `演示预设 ${i % 3 + 1}`, baseUrl: 'https://api-preview.example.invalid/v1', model: 'demo-chat-model',
        backendModel: failed || pending ? undefined : i === 3 ? 'demo-chat-model-lite' : 'demo-chat-model',
        ok: !failed && !pending, status: pending ? undefined : failed ? 401 : 200,
        route: pending ? 'cloud-instant-chat' : undefined, pending,
        durationMs: pending ? undefined : 1200 + i * 160,
        promptTokens: failed || pending ? undefined : 2400 + i * 100,
        completionTokens: failed || pending ? undefined : 180, totalTokens: failed || pending ? undefined : 2580 + i * 100,
        promptBreakdown: failed || pending ? undefined : [{ label: '角色设定（演示）', chars: 1600 }, { label: '聊天历史·12条（演示）', chars: 2400 }],
      };
    });
    await DB.updateApiCallLog(existing => [...entries, ...existing.filter(entry => !entry.id.startsWith('api-preview-log-'))]);
    setLogHint('已添加 12 条演示记录，重新打开调用记录页签查看');
  };
  return <div className="h-full max-w-md mx-auto flex flex-col bg-slate-50">
    <nav className="flex flex-wrap gap-3 px-4 py-2 text-xs shrink-0 border-b border-slate-200">
      <button onClick={seed}>加载 25 个演示预设</button>
      <button onClick={seedLarge}>添加 60 个未分组预设</button>
      <button onClick={() => void seedLogs()}>加载调用记录占位</button>
      <button onClick={() => setPage('character')}>神经链接</button>
      <button onClick={() => setPage('settings')}>设置</button>
      <button onClick={() => setPage('date')}>场景布置</button>
    </nav>
    {logHint && <p role="status" className="text-xs px-4 py-1 text-slate-500">{logHint}</p>}
    <main className="relative min-h-0 flex-1">{page === 'character' ? <Character /> : page === 'date' && os.characters[0] ? <DateSettings char={os.characters[0]} onBack={() => setPage('character')} /> : <Settings />}</main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<OSProvider><Preview /></OSProvider>);
