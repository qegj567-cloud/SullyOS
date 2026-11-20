import React, { useEffect, useRef, useState } from 'react';
import type { APIConfig, Emoji } from '../../types';
import { DB } from '../../utils/db';
import { planStickerName, suggestStickerNames } from '../../utils/emojiLibrary';
import { trackEvent } from '../../utils/analytics';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import EmojiImage from './EmojiImage';

export default function StickerNames({
    items,
    library,
    api,
    onChange,
    onClose,
}: {
    items: Emoji[];
    library: Emoji[];
    api: Pick<APIConfig, 'apiKey' | 'baseUrl' | 'model' | 'apiType'>;
    onChange: () => Promise<void>;
    onClose: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [review, setReview] = useState(false);
    const [progress, setProgress] = useState('');
    const [names, setNames] = useState(new Map<string, string>());
    const [errors, setErrors] = useState(new Map<string, string>());
    const [saved, setSaved] = useState(new Set<string>());
    const active = useRef<AbortController | null>(null);
    useEffect(() => () => active.current?.abort(), []);
    const back = () => {
        if (active.current) active.current.abort();
        else onClose();
        return true;
    };
    useLocalBackHandler(back, 45);
    const remaining = items.filter((row) => !names.has(row.name) && !saved.has(row.name));

    async function recognize() {
        if (active.current || !remaining.length) return;
        const controller = new AbortController();
        active.current = controller;
        setBusy(true);
        setProgress('正在为 ' + remaining.length + ' 张表情一起起名…');
        let outcome: '完成' | '部分完成' | '失败' | '停止' = '失败';
        try {
            const result = await suggestStickerNames(remaining, api, controller.signal);
            if (controller.signal.aborted) return;
            const occupied = new Map(library.map((row) => [row.name, row.name]));
            for (const [old, name] of names) if (name) occupied.set(name, old);
            const next = new Map(names);
            const nextErrors = new Map(errors);
            // Assign collisions in library order even when the model returns IDs out of order.
            for (const row of remaining) {
                const suggestion = result.names.get(row.name);
                if (!suggestion) {
                    nextErrors.set(row.name, result.errors.get(row.name) || '未取得名称');
                    continue;
                }
                const { name } = planStickerName(suggestion, row.name, occupied);
                occupied.set(name, row.name);
                next.set(row.name, name);
                nextErrors.delete(row.name);
            }
            setNames(next);
            setErrors(nextErrors);
            outcome = result.errors.size ? (result.names.size ? '部分完成' : '失败') : '完成';
            setProgress(
                '已取得 ' +
                    result.names.size +
                    ' 个名称' +
                    (result.errors.size ? '，' + result.errors.size + ' 张待处理。' : '。')
            );
        } catch (error) {
            if (!controller.signal.aborted)
                setProgress(error instanceof Error ? error.message : '主 API 请求失败，请重试。');
        } finally {
            if (controller.signal.aborted) {
                outcome = '停止';
                setProgress('已停止本次起名。');
            }
            trackEvent('表情看图起名', { 结果: outcome });
            active.current = null;
            setBusy(false);
            setReview(true);
        }
    }

    async function apply() {
        if (active.current) return;
        const controller = new AbortController();
        active.current = controller;
        setBusy(true);
        setProgress('正在保存名称…');
        const finished = new Set(saved);
        const nextErrors = new Map(errors);
        let count = 0,
            failed = 0;
        try {
            for (const row of items) {
                if (controller.signal.aborted) break;
                const name = names.get(row.name)?.trim();
                if (!name || finished.has(row.name)) continue;
                try {
                    await DB.renameEmoji(row.name, name, row.url);
                    finished.add(row.name);
                    nextErrors.delete(row.name);
                    if (name !== row.name) count++;
                } catch (error) {
                    failed++;
                    nextErrors.set(row.name, error instanceof Error ? error.message : '保存失败');
                }
            }
            setSaved(finished);
            setErrors(nextErrors);
            if (count) {
                trackEvent('采纳表情识图命名');
                await onChange();
            }
            if (!failed && !controller.signal.aborted) onClose();
            else setProgress('已保存 ' + count + ' 个名称' + (failed ? '，' + failed + ' 个需要修改。' : '。'));
        } catch (error) {
            setProgress(error instanceof Error ? error.message : '刷新表情库失败');
        } finally {
            active.current = null;
            setBusy(false);
        }
    }

    return (
        <section className="st-work">
            <header className="st-heading">
                <button onClick={back}>{busy ? '停止' : '返回'}</button>
                <h2>看图起名</h2>
            </header>
            <p>
                将选中的 {items.length} 张表情一起发给主 API「{api.model || '尚未配置'}」，按图片内容起 2～5
                个字的名字。你可以直接整批保存，也可以先改几个。
            </p>
            {!api.baseUrl || !api.model ? (
                <p>请先在设置中配置支持多图输入的主 API。</p>
            ) : (
                !review && (
                    <button className="st-primary" disabled={busy} onClick={() => void recognize()}>
                        一键起名
                    </button>
                )
            )}
            <p role="status">{progress}</p>
            {review &&
                items.map((row) => (
                    <label className="st-import-row" key={row.name}>
                        <EmojiImage value={row.url} loading="lazy" alt="" />
                        <div>
                            <small>{row.name}</small>
                            <input
                                aria-label={row.name + '的新名称'}
                                value={names.get(row.name) || ''}
                                disabled={busy || saved.has(row.name)}
                                onChange={(e) => {
                                    const value = e.currentTarget.value;
                                    setNames((prev) => new Map(prev).set(row.name, value));
                                }}
                            />
                            {errors.get(row.name) && <small>{errors.get(row.name)}</small>}
                        </div>
                    </label>
                ))}
            {review && remaining.length > 0 && (
                <button disabled={busy} onClick={() => void recognize()}>
                    重试剩余 {remaining.length} 张
                </button>
            )}
            {review && (
                <div className="st-commit">
                    <button
                        className="st-primary"
                        disabled={
                            busy || !items.some((row) => names.get(row.name)?.trim() && !saved.has(row.name))
                        }
                        onClick={() => void apply()}
                    >
                        保存选定名称
                    </button>
                </div>
            )}
        </section>
    );
}
