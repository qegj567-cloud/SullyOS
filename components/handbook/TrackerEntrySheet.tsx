/**
 * 通用 Tracker 打卡输入表单(底部弹出)
 *
 * 不绑定 mood —— 根据 tracker.schema 动态渲染:
 *   rating  → 5 颗 emoji/色块按钮
 *   number  → 数字输入(可加 unit)
 *   options → 横排 pill 按钮(可带 emoji)
 *   text    → 单行 textarea
 *   boolean → 开关
 *   photo   → 文件 → base64 缩略
 *
 * 这一个组件覆盖所有 tracker 的输入需求,不必每加一个 tracker 写一个 sheet
 */

import React, { useState, useEffect } from 'react';
import { Tracker, TrackerEntry, TrackerField } from '../../types';
import { PAPER_TONES, SERIF_STACK, CUTE_STACK, WashiTape } from './paper';
import { HeartSticker, StarSticker } from './stickers';
import { Trash, X, FloppyDisk } from '@phosphor-icons/react';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

interface Props {
    visible: boolean;
    tracker: Tracker;
    date: string;
    existingEntry: TrackerEntry | null;
    onCancel: () => void;
    onSave: (values: Record<string, any>) => void;
    onDelete?: () => void;
}

const TrackerEntrySheet: React.FC<Props> = ({
    visible, tracker, date, existingEntry, onCancel, onSave, onDelete,
}) => {
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
    const [values, setValues] = useState<Record<string, any>>({});

    useEffect(() => {
        setValues(existingEntry?.values || {});
    }, [existingEntry, visible]);

    if (!visible) return null;

    const setField = (key: string, v: any) => setValues(prev => ({ ...prev, [key]: v }));

    const renderField = (field: TrackerField) => {
        const v = values[field.key];
        switch (field.kind) {
            case 'rating':
                return (
                    <div className="flex gap-2 flex-wrap">
                        {(field.choices && field.choices.length > 0
                            ? field.choices
                            : Array.from({ length: (field.max ?? 5) - (field.min ?? 1) + 1 }, (_, i) => ({
                                value: String((field.min ?? 1) + i),
                                label: '',
                                emoji: '★',
                            }))
                        ).map(c => {
                            const active = String(v) === String(c.value);
                            return (
                                <button
                                    key={c.value}
                                    onClick={() => setField(field.key, c.value)}
                                    className="flex flex-col items-center justify-center px-3 py-2 rounded-xl transition active:scale-95"
                                    style={{
                                        background: active ? `${tracker.color}33` : 'rgba(253,246,231,0.6)',
                                        border: `1.5px solid ${active ? tracker.color : PAPER_TONES.spine}`,
                                        minWidth: 56,
                                    }}
                                >
                                    <span className="text-2xl leading-none">{c.emoji || ''}</span>
                                    {c.label && (
                                        <span
                                            className="text-[10px] mt-1"
                                            style={{ ...CUTE_STACK, color: PAPER_TONES.inkSoft }}
                                        >
                                            {c.label}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                );
            case 'number':
                return (
                    <div className="flex items-baseline gap-2">
                        <input
                            type="number"
                            value={v ?? ''}
                            onChange={e => setField(field.key, e.target.value === '' ? undefined : Number(e.target.value))}
                            placeholder={field.placeholder || ''}
                            min={field.min}
                            max={field.max}
                            className="flex-1 outline-none rounded-lg px-3 py-2"
                            style={{
                                ...SERIF_STACK,
                                fontSize: 16,
                                background: 'rgba(253,246,231,0.6)',
                                border: `1.5px solid ${PAPER_TONES.spine}`,
                                color: PAPER_TONES.ink,
                            }}
                        />
                        {field.unit && (
                            <span style={{ ...CUTE_STACK, color: PAPER_TONES.inkSoft, fontSize: 13 }}>
                                {field.unit}
                            </span>
                        )}
                    </div>
                );
            case 'options':
                return (
                    <div className="flex gap-2 flex-wrap">
                        {(field.choices || []).map(c => {
                            const active = v === c.value;
                            return (
                                <button
                                    key={c.value}
                                    onClick={() => setField(field.key, c.value)}
                                    className="px-3 py-1.5 rounded-full transition active:scale-95 flex items-center gap-1"
                                    style={{
                                        background: active ? tracker.color : 'rgba(253,246,231,0.6)',
                                        color: active ? '#fff' : PAPER_TONES.ink,
                                        border: `1px solid ${active ? tracker.color : PAPER_TONES.spine}`,
                                        ...CUTE_STACK,
                                        fontSize: 12,
                                    }}
                                >
                                    {c.emoji && <span>{c.emoji}</span>}
                                    <span>{c.label}</span>
                                </button>
                            );
                        })}
                    </div>
                );
            case 'boolean':
                return (
                    <div className="flex gap-2">
                        {[
                            { val: true, label: '是 ♡', emoji: '✓' },
                            { val: false, label: '没有', emoji: '·' },
                        ].map(opt => {
                            const active = v === opt.val;
                            return (
                                <button
                                    key={String(opt.val)}
                                    onClick={() => setField(field.key, opt.val)}
                                    className="flex-1 py-2 rounded-xl transition active:scale-95"
                                    style={{
                                        background: active ? tracker.color : 'rgba(253,246,231,0.6)',
                                        color: active ? '#fff' : PAPER_TONES.ink,
                                        border: `1.5px solid ${active ? tracker.color : PAPER_TONES.spine}`,
                                        ...CUTE_STACK,
                                        fontSize: 13,
                                    }}
                                >
                                    {opt.label}
                                </button>
                            );
                        })}
                    </div>
                );
            case 'text':
                return (
                    <textarea
                        value={v ?? ''}
                        onChange={e => setField(field.key, e.target.value)}
                        placeholder={field.placeholder || '一句话就好…'}
                        rows={2}
                        className="w-full outline-none resize-none rounded-lg px-3 py-2"
                        style={{
                            ...SERIF_STACK,
                            fontSize: 14,
                            lineHeight: '22px',
                            background: 'rgba(253,246,231,0.6)',
                            border: `1.5px solid ${PAPER_TONES.spine}`,
                            color: PAPER_TONES.ink,
                        }}
                    />
                );
            case 'photo':
                return (
                    <label
                        className="flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer"
                        style={{
                            background: 'rgba(253,246,231,0.6)',
                            border: `1.5px dashed ${PAPER_TONES.spine}`,
                        }}
                    >
                        <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={async e => {
                                const file = e.target.files?.[0];
                                if (!file) return;
                                const reader = new FileReader();
                                reader.onload = ev => setField(field.key, ev.target?.result);
                                reader.readAsDataURL(file);
                            }}
                        />
                        {v
                            ? <img src={v} alt="" className="w-16 h-16 rounded object-cover" />
                            : <div className="w-16 h-16 flex items-center justify-center text-2xl" style={{ color: PAPER_TONES.inkFaint }}>📷</div>
                        }
                        <span className="text-[12px]" style={{ ...CUTE_STACK, color: PAPER_TONES.inkSoft }}>
                            {v ? '换一张' : '点这里拍/选'}
                        </span>
                    </label>
                );
        }
    };

    const handleSave = () => {
        onSave(values);
    };

    return (
        <div
            className="absolute inset-0 z-50 flex items-end justify-center"
            style={{ background: 'rgba(122,90,114,0.4)', backdropFilter: 'blur(6px)' }}
            onClick={onCancel}
        >
            <div
                className="w-full max-h-[88%] overflow-y-auto rounded-t-3xl relative"
                style={{
                    background: PAPER_TONES.paper,
                    boxShadow: '0 -8px 28px rgba(122,90,114,0.25)',
                }}
                onClick={e => e.stopPropagation()}
            >
                {/* 顶部把手 */}
                <div className="flex justify-center pt-3 pb-1">
                    <div style={{ width: 40, height: 4, borderRadius: 2, background: tracker.color, opacity: 0.6 }} />
                </div>

                {/* 装饰贴纸 */}
                <div className="absolute top-4 left-5 pointer-events-none" style={{ transform: 'rotate(-15deg)' }}>
                    <HeartSticker size={18} color={tracker.color} />
                </div>
                <div className="absolute top-5 right-7 pointer-events-none" style={{ transform: 'rotate(20deg)' }}>
                    <StarSticker size={16} color={PAPER_TONES.accentLemon} />
                </div>

                {/* 标题 */}
                <div className="px-5 pt-2 pb-3 text-center">
                    <WashiTape color="rose" pattern="heart" rotate={-1.5}>
                        {tracker.icon ? `${tracker.icon} ` : ''}{tracker.name}
                    </WashiTape>
                    <div
                        className="text-[11px] mt-3"
                        style={{ ...CUTE_STACK, color: PAPER_TONES.inkSoft }}
                    >
                        {date}
                    </div>
                </div>

                {/* 字段表单 */}
                <div className="px-5 py-3 space-y-4 pb-6">
                    {tracker.schema.map(field => (
                        <div key={field.key}>
                            <div
                                className="text-[11px] mb-2 tracking-widest"
                                style={{ ...CUTE_STACK, color: PAPER_TONES.inkSoft }}
                            >
                                {field.required ? '◆ ' : ''}{field.label}
                            </div>
                            {renderField(field)}
                        </div>
                    ))}
                </div>

                {/* 底部操作 */}
                <div
                    className="sticky bottom-0 px-5 py-3 flex gap-2"
                    style={{
                        background: PAPER_TONES.paper,
                        borderTop: `1.5px solid ${tracker.color}`,
                    }}
                >
                    {existingEntry && onDelete && (
                        <button
                            onClick={async () => {
                                const confirmed = await requestConfirm({
                                    title: '删除这天的打卡？',
                                    message: `确定要删除 ${date}「${tracker.name}」的打卡记录吗？`,
                                    confirmText: '删除',
                                    variant: 'danger',
                                });
                                if (confirmed) onDelete();
                            }}
                            className="px-3 py-3 rounded-full active:scale-95 transition"
                            style={{
                                color: '#c4708a',
                                background: '#fff',
                                border: '1.5px solid #f0c0d0',
                            }}
                            aria-label="删除"
                        >
                            <Trash className="w-4 h-4" weight="bold" />
                        </button>
                    )}
                    <button
                        onClick={onCancel}
                        className="px-4 py-3 rounded-full text-[13px] font-bold active:scale-95 transition flex items-center gap-1"
                        style={{
                            ...CUTE_STACK,
                            color: PAPER_TONES.inkSoft,
                            background: '#fff',
                            border: `1.5px solid ${PAPER_TONES.spine}`,
                        }}
                    >
                        <X className="w-3.5 h-3.5" /> 算了
                    </button>
                    <button
                        onClick={handleSave}
                        className="flex-1 flex items-center justify-center gap-2 py-3 rounded-full text-[13px] font-bold active:scale-95 transition"
                        style={{
                            ...CUTE_STACK,
                            background: `linear-gradient(135deg, ${tracker.color} 0%, ${PAPER_TONES.accentBlush} 100%)`,
                            color: '#fff',
                            boxShadow: '0 2px 6px rgba(242,157,176,0.4)',
                        }}
                    >
                        <FloppyDisk weight="fill" className="w-3.5 h-3.5" />
                        {existingEntry ? '更新 ♡' : '收下 ♡'}
                    </button>
                </div>
            </div>
            {confirmDialog}
        </div>
    );
};

export default TrackerEntrySheet;
