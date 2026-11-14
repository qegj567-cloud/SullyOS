import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import BeautyCatalog from '../../components/appearance/BeautyCatalog';
import ChatHeaderShell from '../../components/chat/ChatHeaderShell';
import ChatInputArea from '../../components/chat/ChatInputArea';
import ChatRuntimeStyle from '../../components/chat/ChatRuntimeStyle';
import BlobRefStyle from '../../components/chat/BlobRefStyle';
import MessageItem from '../../components/chat/MessageItem';
import { ChatSubtitleLayer } from '../../components/chat/ChatSubtitleLayer';
import { PRESET_THEMES } from '../../components/chat/ChatConstants';
import { validateDecoration, type DecorationPreset } from '../../utils/chatDecoration';
import { buildChatFineTuneCss } from '../../utils/chatFineTuneCss';
import { avatarFrameLayer } from '../../utils/avatarFrameTarget';
import { BEAUTY_PREVIEW_AVATAR } from '../../utils/beautyPreviewAssets';
import type { ChatTranslationStyle } from '../../utils/chatTranslationStyle';
import type { Message } from '../../types';
import baseCss from '../../components/chat/chatPreview.generated.css?inline';

const noop = () => {};
const samples = [
    ['今日は海のそばを歩いてきたよ。\n**風が気持ちよかった。**', '今天去海边散了会儿步，风吹过来的时候很舒服。'],
    ['よかったら、今度は一緒に行こう。', '下次有空的话，我们一起去吧。'],
    ['うん。', '好呀，我已经开始期待下次见面了。'],
];
function App() {
    const [library, setLibrary] = useState(true);
    const [preset, setPreset] = useState<DecorationPreset>();
    const [code, setCode] = useState('');
    const [style, setStyle] = useState<ChatTranslationStyle>('subtitle');
    const [count, setCount] = useState(0);
    const [longPresses, setLongPresses] = useState(0);
    const [input, setInput] = useState('');
    const [panel, setPanel] = useState<'none' | 'actions' | 'emojis' | 'chars'>('none');
    const scrollRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => { if (count && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [count]);
    const p = preset?.parts || {}, l = p.layout || {};
    return <>
        <style>{baseCss}</style>
        <div className="qa-toolbar">
            <button onClick={() => setLibrary(v => !v)}>美化库</button>
            <button onClick={() => setStyle(v => v === 'subtitle' ? 'bubble' : 'subtitle')}>样式：{style === 'subtitle' ? '外挂字幕' : '气泡内'}</button>
            <button onClick={() => setCount(v => v + 1)}>追加双语消息</button>
        </div>
        <div className="qa-state" data-applied-code={code}>{preset?.name || '尚未装载'} · 长按 {longPresses}</div>
        <div className="qa-phone" style={{ transform: 'translateZ(0)', isolation: 'isolate' }}>
            {library ? <BeautyCatalog onBack={() => setLibrary(false)} onReceive={async (pack, entry) => {
                setPreset(validateDecoration(pack)); setCode(entry.code); setCount(0); setLibrary(false);
            }} /> : <div className="sully-chat-root flex flex-col h-full bg-[#f1f5f9] overflow-hidden relative font-sans"
                style={{ backgroundImage: p.background?.image ? `url(${JSON.stringify(p.background.image)})` : undefined, backgroundSize: 'cover' }}>
                <ChatRuntimeStyle />
                <style>{buildChatFineTuneCss(l)}</style>
                {p.css && <BlobRefStyle css={p.css} />}
                {p.bubbles?.customCss && <style>{p.bubbles.customCss}</style>}
                <style>{avatarFrameLayer(p.css || '') + '\n.sully-chat-back,.sully-chat-inputbar{visibility:visible!important;opacity:1!important;pointer-events:auto!important}.sully-chat-inputbar textarea,.sully-chat-inputbar button{pointer-events:auto!important;visibility:visible!important}'}</style>
                <ChatHeaderShell selectionMode={false} selectedCount={0} onCancelSelection={noop} activeCharacter={{ id: 'qa-library', name: '小秋', avatar: BEAUTY_PREVIEW_AVATAR }}
                    isTyping={false} isSummarizing={false} lastTokenUsage={1200} statusText="在线" onClose={noop} onTriggerAI={noop} onShowCharsPanel={noop}
                    headerStyle={l.chatHeaderStyle} avatarShape={l.chatAvatarShape} headerAlign={l.chatHeaderAlign} headerDensity={l.chatHeaderDensity} statusStyle={l.chatStatusStyle} chromeStyle={l.chatChromeStyle} />
                <div ref={scrollRef} data-qa-scroll="" onClick={() => setPanel('none')}
                    className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain pt-6 pb-6 no-scrollbar">
                    <ChatSubtitleLayer enabled={style === 'subtitle'}>
                        {[...samples, ...samples, ...Array.from({ length: count }, () => ['うん。', '好呀，我们一起去海边。'.repeat(8)])].map(([source, translation], index) => {
                            const msg = { id: index + 1, charId: 'qa-library', role: 'assistant', type: 'text', timestamp: 1794630000000,
                                content: `${source}%%BILINGUAL%%${translation}`,
                                ...(index === 0 ? { replyTo: { name: '小夏', content: '今天去哪里玩了？', id: 0 } } : {}),
                            } as Message;
                            return <div key={index} id={`chat-msg-${index + 1}`} data-qa-message={index} className="transition-all duration-300">
                                <MessageItem msg={msg} activeTheme={p.bubbles || PRESET_THEMES.default} charName="小秋" charAvatar={BEAUTY_PREVIEW_AVATAR} userAvatar={BEAUTY_PREVIEW_AVATAR}
                                    onLongPress={() => setLongPresses(v => v + 1)} onReply={noop} onToggleSelect={noop} isFirstInGroup isLastInGroup
                                    selectionMode={false} isSelected={false} translationEnabled translationExpanded translationStyle={style}
                                    avatarShape={l.chatAvatarShape} avatarSize={l.chatAvatarSize} avatarMode={l.chatAvatarMode} bubbleVariant={l.chatBubbleStyle}
                                    messageSpacing={l.chatMessageSpacing} showTimestamp={l.chatShowTimestamp} suppressEntranceAnimation />
                            </div>;
                        })}
                    </ChatSubtitleLayer>
                </div>
                <div className="relative z-40">
                    <ChatInputArea input={input} setInput={setInput} isTyping={false} selectionMode={false} showPanel={panel} setShowPanel={setPanel}
                        onSend={() => setInput('')} onDeleteSelected={noop} selectedCount={0} emojis={[]} onPanelAction={noop} onImageSelect={noop}
                        isSummarizing={false} onReroll={noop} canReroll={false} inputStyle={l.chatInputStyle} sendButtonStyle={l.chatSendButtonStyle} chromeStyle={l.chatChromeStyle} />
                </div>
            </div>}
        </div>
    </>;
}
createRoot(document.getElementById('root')!).render(<App />);
