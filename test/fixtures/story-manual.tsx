import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OSPreviewProvider } from '../../context/OSContext';
import StoryTheaterEditor from '../../components/date/story/StoryTheaterEditor';
import { StoryTheaterThemeProvider } from '../../components/date/story/StoryTheaterTheme';
import { HomeRomanceSettings } from '../../apps/room3d/HomeRomanceSettings';
import { updateHomeRomanticRelation } from '../../apps/room3d/homeRomance';
import { DB } from '../../utils/db';
import { createStoryTheaterDraft, storyTheaterThreadId, BUILTIN_NIGHT_SCREENING_PRESET } from '../../utils/storyTheater';
import { archiveStoryManually } from '../../utils/storyTheaterArchive';
import type { CharacterProfile, StoryTheaterEntry } from '../../types';

if (location.port !== '5192') throw Error('请使用隔离验收端口 5192');
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => String(input).includes('/__manual_summary_mock')
    ? new Response(JSON.stringify({ choices: [{ message: { content: '雨停后，两人一起离开车站，约好下次带伞。' } }] }), { headers: { 'Content-Type': 'application/json' } })
    : nativeFetch(input, init);
const character = { id: 'qa-manual-actor', name: '阿泽', avatar: '', systemPrompt: '' } as CharacterProfile;
let romance = {};
const editor = { getState: () => romance, setRomanticRelation: (a: string, b: string, enabled: boolean) => { romance = updateHomeRomanticRelation(romance, a, b, enabled); } } as any;
function App() {
    const [entry, setEntry] = useState<StoryTheaterEntry>();
    const [notice, setNotice] = useState('隔离测试数据，使用模拟总结接口，不调用真实模型。');
    useEffect(() => { void (async () => {
        const id = 'qa-manual-story';
        const existing = (await DB.getStoryTheaters()).find(item => item.id === id);
        if (existing) { setEntry(existing); return; }
        const next = { ...createStoryTheaterDraft(), id, title: '雨夜车站', characterIds: [character.id], writesToCharacterMemory: false };
        await DB.saveStoryTheater(next);
        for (const [role, content] of [['user', '雨停了，我们走吧。'], ['assistant', '他收起伞，陪你走出车站。']] as const)
            await DB.saveMessage({ charId: storyTheaterThreadId(id), role, type: 'text', content, metadata: { source: 'story_theater' } });
        setEntry(next);
    })(); }, []);
    return <OSPreviewProvider value={{ theme: {}, userProfile: { name: '小雨' }, characters: [character], registerBackHandler: () => () => {} } as any}>
        <div className='flex flex-wrap'><div className='qa-phone'>{entry && <StoryTheaterThemeProvider><StoryTheaterEditor key={entry.updatedAt}
            initial={entry} characters={[character]} user={{ name: '小雨' } as any} masks={[]} maskLocked presets={[BUILTIN_NIGHT_SCREENING_PRESET]}
            onCancel={() => setNotice('返回')} onSave={async next => { await DB.saveStoryTheater(next); setEntry(next); setNotice('设置已保存'); }}
            onManualArchive={async draft => { const next = await archiveStoryManually(draft, { baseUrl: location.origin + '/__manual_summary_mock', apiKey: 'mock', model: 'mock' }); setEntry(next); setNotice(`归档成功：${next.archives.at(-1)?.messageCount} 层；${next.archives.at(-1)?.summary}`); return next; }}
            onImportPreset={async () => null} onEditPreset={() => {}} onOpenMaskBox={() => {}} /></StoryTheaterThemeProvider>}</div>
            <aside><h1>手动总结与亲密互动验收</h1><p role='status' className='my-5'>{notice}</p><HomeRomanceSettings editor={editor} members={[{ id: 'user', label: '我' }, { id: 'A', label: '阿泽' }, { id: 'B', label: '小北' }]} /></aside>
        </div>
    </OSPreviewProvider>;
}
const root = createRoot(document.getElementById('root')!); root.render(<App />);
import.meta.hot?.dispose(() => { root.unmount(); window.fetch = nativeFetch; });
