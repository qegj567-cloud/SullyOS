import React from 'react';
import { createRoot } from 'react-dom/client';
import ChatHeaderShell from '../../components/chat/ChatHeaderShell';
const avatar = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="20" fill="#ddd6ef"/><text x="20" y="27" text-anchor="middle" font-family="Arial" font-size="22" fill="#6b5c86">S</text></svg>')}`;
createRoot(document.getElementById('root')!).render(<main>
    {(['left', 'center'] as const).flatMap(headerAlign => (['dot', 'pill', 'subtle'] as const).map(statusStyle => <section key={`${headerAlign}-${statusStyle}`} data-case={`${headerAlign}-${statusStyle}`}>
        <h2>Telegram · {headerAlign === 'left' ? '左对齐' : '居中'} · {statusStyle}</h2>
        <ChatHeaderShell activeCharacter={{ id: 'qa', name: 'sully', avatar }} selectionMode={false} selectedCount={0} onCancelSelection={() => {}}
            isTyping={false} isSummarizing={false} lastTokenUsage={null} onClose={() => {}} onTriggerAI={() => {}} onShowCharsPanel={() => {}}
            headerStyle="telegram" headerDensity="compact" headerAlign={headerAlign} statusStyle={statusStyle}/>
    </section>))}
</main>);
