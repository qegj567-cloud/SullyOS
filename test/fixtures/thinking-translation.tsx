import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MessageItem from '../../components/chat/MessageItem';
import { PRESET_THEMES } from '../../components/chat/ChatConstants';
import ChatRuntimeStyle from '../../components/chat/ChatRuntimeStyle';
import type { ThinkingPromptCharacter } from '../../utils/thinkingChainPrompt';
import ThinkingChainSettingsModal from '../../components/chat/ThinkingChainSettingsModal';
import { DB } from '../../utils/db';
import { translateThinkingMessage } from '../../utils/thinkingTranslation';
import { handleLocalBack } from '../../utils/localBackHandlers';
import type { APIConfig, ApiPreset, Message, UserProfile } from '../../types';

Object.assign(window, { thinkingQA: { DB, handleLocalBack } });
const preset: ApiPreset = { id: 'cheap', name: '日常翻译', group: '低价模型', config: { baseUrl: 'https://translate.example.invalid/v1', apiKey: 'translation-fixture', model: 'translator-fixture' } };
function App() {
    const [message, setMessage] = useState<Message>();
    const [open, setOpen] = useState(false);
    const [api, setApi] = useState<APIConfig>(() => JSON.parse(localStorage.getItem('os_api_config') || 'null') || { baseUrl: 'https://chat.example.invalid/v1', apiKey: 'chat-fixture', model: 'expensive-chat' });
    const [presets, setPresets] = useState<ApiPreset[]>([preset]);
    const [character, setCharacter] = useState<ThinkingPromptCharacter>({ showThinkingChain: true });
    const [shared, setShared] = useState<UserProfile['thinkingChainPrompt']>();
    useEffect(() => { void (async () => {
        let current = (await DB.getMessagesByCharId('thinking-fixture'))[0];
        if (!current) {
            const id = await DB.saveMessage({ charId: 'thinking-fixture', role: 'assistant', type: 'text', content: '今晚一起散步吗？', metadata: { thinkingChain: 'I want to invite her for a walk.\nShe has had a long day, so I should keep the invitation gentle and leave room for her to rest.' } });
            current = (await DB.getMessageById(id))!;
        }
        setMessage(current);
    })(); }, []);
    return <><main className="sully-chat-root"><ChatRuntimeStyle /><button className="qa-open-settings" onClick={() => setOpen(true)}>打开心象设置</button>
        <p className="qa-label">长按心象，选择复制或翻译</p>
        {message && <MessageItem msg={message} activeTheme={PRESET_THEMES.default} charName="小秋" charAvatar="" userAvatar=""
            onLongPress={() => {}} onReply={() => {}} onToggleSelect={() => {}} isFirstInGroup isLastInGroup selectionMode={false} isSelected={false}
            thinkingChainOptions={{ onOpenSettings: () => setOpen(true), onTranslate: async () => {
                if (!api.thinkingTranslationApi) { setOpen(true); throw new Error('请先配置翻译 API，然后再长按翻译。'); }
                const text = await translateThinkingMessage(message, api.thinkingTranslationApi, '小秋');
                setMessage((await DB.getMessageById(message.id))!); return text;
            } }} />}
    </main><ThinkingChainSettingsModal isOpen={open} onClose={() => setOpen(false)} character={character} sharedPrompt={shared}
        onChangeCharacter={patch => setCharacter(previous => ({ ...previous, ...patch }))}
        onChangeSharedPrompt={patch => setShared(previous => ({ ...previous, ...patch }))}
        translationApi={api.thinkingTranslationApi} dialogueApi={api} apiPresets={presets}
        onChangeTranslationApi={thinkingTranslationApi => { const next = { ...api, thinkingTranslationApi }; localStorage.setItem('os_api_config', JSON.stringify(next)); setApi(next); }}
        onAddApiPreset={(name, config) => setPresets(rows => [...rows, { id: 'saved', name, config, group: '心象翻译' }])} /></>;
}
createRoot(document.getElementById('root')!).render(<App />);
