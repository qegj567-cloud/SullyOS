import React, { useEffect, useRef, useState } from 'react';
import { useOS } from '../context/OSContext';
import { askSullyHelpDesk, type buildHelpDeskKnowledge, type HelpDeskMessage } from '../utils/sullyHelpDesk';
import { readHelpDeskSettings } from '../utils/sullyHelpSettings';
import type { CharacterProfile } from '../types';

type Knowledge = ReturnType<typeof buildHelpDeskKnowledge>;

export function SullyHelpDesk({ knowledge }: { knowledge: Knowledge }) {
    const { characters, activeCharacterId } = useOS();
    const [selected, setSelected] = useState<string | null>(null);
    const char = characters.find(item => item.id === (selected ?? activeCharacterId));
    return <HelpDeskConversation key={char?.id ?? ''} knowledge={knowledge} char={char} onSelect={setSelected} />;
}

function HelpDeskConversation({ knowledge, char, onSelect }: {
    knowledge: Knowledge; char?: CharacterProfile; onSelect: (id: string) => void;
}) {
    const os = useOS();
    const { apiConfig, characters } = os;
    const [history, setHistory] = useState<HelpDeskMessage[]>([]);
    const [draft, setDraft] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const request = useRef<AbortController | null>(null);
    const log = useRef<HTMLDivElement>(null);
    const configured = !!apiConfig.baseUrl.trim() && !!apiConfig.model.trim();

    useEffect(() => () => request.current?.abort(), []);
    useEffect(() => {
        if (log.current) log.current.scrollTop = log.current.scrollHeight;
    }, [history, pending, error]);

    async function send(event: React.FormEvent) {
        event.preventDefault();
        const question = draft.trim();
        if (!question || request.current || !configured) return;
        const controller = new AbortController();
        request.current = controller;
        const turns: HelpDeskMessage[] = [...history, { role: 'user', content: question }];
        setPending(true);
        setHistory(turns);
        setError('');
        setDraft('');
        try {
            const settings = await readHelpDeskSettings(os, char);
            if (controller.signal.aborted) return;
            const answer = await askSullyHelpDesk(apiConfig, knowledge, turns, settings, controller.signal);
            if (!controller.signal.aborted) setHistory([...turns, { role: 'assistant', content: answer }]);
        } catch (cause) {
            if (!controller.signal.aborted) {
                setHistory(history);
                setDraft(question);
                setError(cause instanceof Error ? cause.message : '请求失败，请检查 API 配置后重试。');
            }
        } finally {
            request.current = null;
            if (!controller.signal.aborted) setPending(false);
        }
    }

    return <section aria-label="Sully-11 答疑" className="flex min-h-0 flex-1 flex-col bg-slate-50 text-slate-800">
        <div ref={log} role="log" aria-live="polite" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
            <div className="flex items-center gap-3">
                <img src="sully/head.png" alt="" className="h-12 w-12 rounded-2xl" />
                <div><h2 className="font-bold">Sully-11</h2><p className="text-xs text-slate-500">糯米机客服 · 工号 11</p></div>
            </div>
            <p className="w-fit rounded-2xl bg-white p-3 text-sm shadow-sm">叮，11 号在。你在小手机的哪一步卡住了？</p>
            {history.map((turn, index) => <p key={index}
                aria-label={turn.role === 'user' ? '你' : 'Sully-11'}
                className={`w-fit max-w-[92%] whitespace-pre-wrap break-words rounded-2xl p-3 text-sm leading-relaxed ${turn.role === 'user' ? 'ml-auto bg-indigo-100' : 'bg-white shadow-sm'}`}>
                {turn.content}
            </p>)}
            {pending && <p className="text-xs text-slate-500">11 号正在翻使用帮助…</p>}
            {error && <p role="alert" className="break-words text-sm text-red-700">{error}</p>}
        </div>
        <form onSubmit={send} className="shrink-0 space-y-2 border-t bg-white px-4 pt-3" style={{ paddingBottom: 'max(12px, var(--safe-bottom, 0px))' }}>
            {characters.length > 0 && <label className="flex flex-wrap items-center gap-2 text-xs text-slate-600">排查范围
                <select className="min-w-0 max-w-[65%] rounded-lg border bg-white p-1 text-slate-800" value={char?.id ?? ''} onChange={e => onSelect(e.target.value)} disabled={pending}>
                    <option value="">仅全局设置</option>
                    {characters.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                {(history.length > 0 || draft) && <span>切换范围会开始新咨询</span>}
            </label>}
            <p className="text-xs text-slate-500">{configured ? '发送时，你的对话 API 会收到问题、相关手册和所选范围的设置摘要。' : '先到「设置」配置对话 API，或点「常见问题」直接查阅。'}</p>
            <div className="flex items-end gap-2">
                <textarea rows={2} aria-label="你的糯米机问题" placeholder="描述遇到的问题…" value={draft}
                    disabled={pending} onChange={event => setDraft(event.target.value)}
                    className="min-w-0 flex-1 resize-none rounded-xl border bg-slate-50 p-2 text-base text-slate-800" />
                <button disabled={pending || !configured || !draft.trim()} className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">发送</button>
            </div>
        </form>
    </section>;
}
