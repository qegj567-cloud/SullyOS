import React, { useState } from 'react';
import Modal from '../os/Modal';

const MemoryEyeExplanation = () => (
    <div className="space-y-3 text-sm leading-relaxed text-slate-600">
        <p><strong className="text-slate-800">开启小眼睛：</strong>每次聊天都会带上该月已保存的全部详细记忆，会增加输入 Token。</p>
        <p><strong className="text-slate-800">关闭小眼睛：</strong>不再每次带上整月详细记忆，仍会按你的设置使用月度总结、记忆宫殿召回等内容。</p>
        <p>如果允许自主查阅，角色仍可以临时查看这个月。这里的详细记忆指已归档的记忆条目，不是整月聊天原文。</p>
    </div>
);

export const MemoryEyeHelpButton = () => {
    const [open, setOpen] = useState(false);
    return <>
        <button type="button" onClick={() => setOpen(true)} className="text-xs text-blue-600 underline decoration-blue-300 underline-offset-2">小眼睛说明</button>
        <Modal isOpen={open} title="小眼睛是什么？" onClose={() => setOpen(false)}><MemoryEyeExplanation /></Modal>
    </>;
};

export default function MonthlyRecallSetting({ enabled, onChange }: { enabled?: boolean; onChange: (enabled: boolean) => void }) {
    const [help, setHelp] = useState<'recall' | 'eye' | null>(null);
    return <>
        <div className="flex items-center justify-between gap-4 border-t border-slate-100 px-4 py-3">
            <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-slate-700">允许自主查阅月度记忆</span>
                    <button type="button" aria-label="自主查阅月度记忆说明" onClick={() => setHelp('recall')} className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-blue-600 hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-400">?</button>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">默认开启。角色可按需查看整月详细记忆，可能额外调用一次 API。</p>
            </div>
            <label className="shrink-0">
                <input type="checkbox" role="switch" aria-label="允许自主查阅月度记忆" checked={enabled !== false} onChange={event => onChange(event.target.checked)} className="peer sr-only" />
                <span aria-hidden="true" className="relative block h-6 w-11 rounded-full bg-slate-200 transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-transform peer-checked:after:translate-x-5" />
            </label>
        </div>
        <Modal isOpen={help !== null} title={help === 'eye' ? '小眼睛是什么？' : '自主查阅月度记忆'} onClose={() => setHelp(null)} footer={help === 'eye' ? <button type="button" onClick={() => setHelp('recall')} className="w-full rounded-2xl bg-slate-100 py-3 font-bold text-slate-500">返回查阅说明</button> : undefined}>
            {help === 'eye' ? <MemoryEyeExplanation /> : <div className="space-y-3 text-sm leading-relaxed text-slate-600">
                <p><strong className="text-slate-800">默认开启。</strong>角色觉得某个月的经历与当前话题有关时，可以查看该月已保存的全部详细记忆，再继续回复。</p>
                <p>即使该月的<button type="button" onClick={() => setHelp('eye')} className="mx-1 text-blue-600 underline decoration-blue-300 underline-offset-2">小眼睛</button>关闭，也可以临时查阅；已开启小眼睛时，这些记忆本来就会带上。</p>
                <p><strong className="text-slate-800">查阅后继续回复可能额外调用一次 API，增加 Token 消耗。</strong></p>
                <p>关闭后，普通消息、即时对话和主动消息都不再自主按月查阅。月度总结、小眼睛和记忆宫殿召回仍按原设置工作。</p>
                <p className="text-xs text-slate-400">这个开关只控制按月查阅。搜索、主动消息排程等工具仍可能额外调用模型。</p>
            </div>}
        </Modal>
    </>;
}
