import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MessageItem from '../../components/chat/MessageItem';
import ChatRuntimeStyle from '../../components/chat/ChatRuntimeStyle';
import { ChatSubtitleLayer } from '../../components/chat/ChatSubtitleLayer';
import TranslationStylePicker from '../../components/chat/TranslationStylePicker';
import { readChatTranslationStyle, type ChatTranslationStyle } from '../../utils/chatTranslationStyle';
import { PRESET_THEMES } from '../../components/chat/ChatConstants';
import type { Message } from '../../types';

const noop = () => {};
const avatar = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="18" fill="#b7cbdc"/><text x="32" y="44" text-anchor="middle" font-size="38">☺</text></svg>')}`;
const examples = [
    ['今日は海のそばを歩いてきたよ。\n**風が気持ちよかった。**', '今天去海边散了会儿步，风吹过来的时候很舒服。'],
    ['よかったら、今度は一緒に行こう。', '下次有空的话，我们一起去吧。'],
    ['うん。', '好呀，我已经开始期待下次见面了。'],
];
function App() {
    const [charId, setCharId] = useState('qa-a');
    const [style, setStyle] = useState<ChatTranslationStyle>(() => readChatTranslationStyle(charId));
    const [theme, setTheme] = useState('plain');
    const [expanded, setExpanded] = useState(true);
    const [enabled, setEnabled] = useState(true);
    const [grown, setGrown] = useState(false);
    const [clicked, setClicked] = useState(0);
    const [showing, setShowing] = useState(false);
    const [appendCount, setAppendCount] = useState(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => { if (appendCount && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [appendCount]);
    return <main className={`sully-chat-root qa-${theme}`}>
        <ChatRuntimeStyle />
        <div className="controls">
            <div className="flex gap-2">
                <select aria-label="测试气泡" value={theme} onChange={e => setTheme(e.target.value)}>
                    <option value="plain">默认气泡</option><option value="clipped">裁切与装饰</option><option value="flat">无框美化</option><option value="dark">深色气泡</option>
                </select>
                <select aria-label="测试角色" value={charId} onChange={e => { setCharId(e.target.value); setStyle(readChatTranslationStyle(e.target.value)); }}>
                    <option value="qa-a">角色 A</option><option value="qa-b">角色 B</option>
                </select>
            </div>
            <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> 消息翻译</label>
            <label><input type="checkbox" checked={expanded} onChange={e => setExpanded(e.target.checked)} /> 同时展开</label>
            {enabled && expanded && <TranslationStylePicker value={style} onChange={v => { setStyle(v); localStorage.setItem(`chat_translate_style_${charId}`, v); }} />}
            <button onClick={() => setGrown(v => !v)}>改变上方内容高度</button>
            <button onClick={() => setAppendCount(v => v + 1)}>追加双语消息</button>
        </div>
        <div className="scroll" ref={scrollRef} onClick={() => setClicked(v => v + 1)}>
            <ChatSubtitleLayer enabled={enabled && expanded && style === 'subtitle'}>
                <div data-spacer="" style={{ height: grown ? 120 : 0 }} />
                {[...examples, ...examples, ...Array.from({ length: appendCount }, () => ['うん。', '好呀，我们一起去海边。'.repeat(12)])].map(([source, translation], index) => {
                    const msg = { id: index + 1, charId, role: 'assistant', type: 'text', timestamp: 1794630000000,
                        content: `${source}%%BILINGUAL%%${translation}`,
                        ...(index === 0 ? { replyTo: { name: '小夏', content: '今天去哪里玩了？', id: 0 } } : {}),
                    } as Message;
                    return <div key={index} data-example={index}>
                        <MessageItem msg={msg} activeTheme={theme === 'dark' ? { ...PRESET_THEMES.default, ai: { ...PRESET_THEMES.default.ai, textColor: '#fff' } } : PRESET_THEMES.default} charName="小秋" charAvatar={avatar} userAvatar={avatar}
                            onLongPress={noop} onReply={noop} onToggleSelect={noop} isFirstInGroup isLastInGroup
                            selectionMode={false} isSelected={false} translationEnabled={enabled} translationExpanded={expanded}
                            translationStyle={style} isShowingTarget={showing} onTranslateToggle={() => setShowing(v => !v)}
                            suppressEntranceAnimation />
                    </div>;
                })}
            </ChatSubtitleLayer>
        </div>
        <div className="qa-footer">输入消息… <output data-clicks="">{clicked}</output></div>
    </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
