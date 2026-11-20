import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DB } from '../../utils/db';
import { isRemoteEmoji, stickerLink } from '../../utils/emojiOriginals';
import { migrateDataUrlToRef } from '../../utils/blobRef';
import type { Emoji, EmojiCategory } from '../../types';
import { trackEvent } from '../../utils/analytics';
import {
    importSticker,
    newPersonalGroup,
    openStickerFiles,
    planStickerName,
    prepareStickerImport,
    stickerBytes,
    stickerNameIndex,
    type ImportSticker,
    type StickerFiles,
} from '../../utils/emojiLibrary';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';

type Draft = ImportSticker & { hash: string; size: number; compact?: { blob: Blob; hash: string }; error?: string; done?: boolean; savedName?: string; savedHash?: string };
const createFolder = '__new_sticker_folder__';
type Props = {
    emojis: Emoji[];
    groups: EmojiCategory[];
    target?: string;
    onChange: () => Promise<void>;
    onClose: () => void;
    onLinksSaved: (group: string, message: string) => void;
    onNameImported: (items: Emoji[]) => void;
};

function FilePreview({ item }: { item: Draft }) {
    const [src, setSrc] = useState('');
    useEffect(() => {
        let active = true,
            url = '';
        if (!item.read) return;
        item.read()
            .then((blob) => {
                if (active) {
                    url = URL.createObjectURL(blob);
                    setSrc(url);
                }
            })
            .catch(() => {});
        return () => {
            active = false;
            if (url) URL.revokeObjectURL(url);
        };
    }, [item.read]);
    if (item.url) return <span className="st-link-preview">链接</span>;
    return src ? <img src={src} alt="" /> : <span />;
}

export default function StickerImportPanel({
    emojis,
    groups,
    target,
    onChange,
    onClose,
    onLinksSaved,
    onNameImported,
}: Props) {
    const pictures = useRef<HTMLInputElement>(null),
        zip = useRef<HTMLInputElement>(null);
    const source = useRef<StickerFiles>(),
        stopped = useRef(false),
        alive = useRef(true),
        working = useRef(false);
    const [rows, setRows] = useState<Draft[]>([]),
        [index, setIndex] = useState(new Map<string, string>());
    const [destination, setDestination] = useState(target || ''),
        [page, setPage] = useState(0);
    const [creating, setCreating] = useState(false), [folderName, setFolderName] = useState('');
    const [compress, setCompress] = useState(true);
    const [pasting, setPasting] = useState(false), [links, setLinks] = useState('');
    const [busy, setBusy] = useState(false),
        [summary, setSummary] = useState(''),
        [progress, setProgress] = useState('');
    const kind = useRef<'本地选图' | 'ZIP'>('本地选图');
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
            stopped.current = true;
            void source.current?.close();
        };
    }, []);
    const back = () => {
        if (working.current) stopped.current = true;
        else if (pasting) { setPasting(false); setSummary(''); }
        else onClose();
        return true;
    };
    useLocalBackHandler(back, 45);
    const preview = useMemo(() => {
        const taken = new Map(index);
        return rows.map((item) => {
            const hash = compress && item.compact ? item.compact.hash : item.hash;
            const next = planStickerName(item.name, hash, taken);
            taken.set(next.name, hash);
            return next;
        });
    }, [rows, index, compress]);
    const imported = useMemo(() => {
        const saved = new Map(rows.filter((row) => row.savedName).map((row) => [row.savedName, row.savedHash]));
        return emojis.filter((row) => saved.has(row.name) && saved.get(row.name) === (stickerLink(row) || row.contentHash));
    }, [rows, emojis]);
    async function select(files: File[], mode: '本地选图' | 'ZIP') {
        if (!files.length || working.current) return;
        working.current = true;
        stopped.current = false;
        setBusy(true);
        setRows([]);
        setPage(0);
        setSummary('');
        kind.current = mode;
        let opened: StickerFiles | undefined;
        try {
            await source.current?.close();
            setProgress('正在读取文件…');
            opened = await openStickerFiles(files);
            if (!alive.current) {
                await opened.close();
                return;
            }
            source.current = opened;
            if (!opened.items.length) throw new Error('没有找到可导入的图片');
            const drafts: Draft[] = [];
            for (const [i, item] of opened.items.entries()) {
                if (stopped.current) break;
                setProgress('正在核对图片 ' + (i + 1) + ' / ' + opened.items.length);
                try {
                    drafts.push({ ...item, ...await prepareStickerImport(item) });
                } catch {
                    drafts.push({ ...item, hash: '', size: 0, error: '读取失败' });
                }
            }
            if (!alive.current) return;
            setIndex(
                await stickerNameIndex(
                    emojis,
                    drafts.map((r) => r.name)
                )
            );
            setRows(drafts);
            setSummary(
                (stopped.current ? '已停止读取。' : '') +
                    (opened.ignored ? '已略过 ' + opened.ignored + ' 个非图片或加密文件。' : '')
            );
        } catch (e) {
            if (alive.current) setSummary(e instanceof Error ? e.message : '无法读取文件');
            trackEvent('批量导入表情', { 方式: mode, 结果: '失败' });
        } finally {
            working.current = false;
            if (alive.current) {
                setBusy(false);
                setProgress('');
            }
        }
    }
    async function addFolder() {
        const name = folderName.trim();
        if (!name || working.current) return;
        if (groups.some((g) => g.name === name)) { setSummary('已有同名文件夹，请在「导入到」中选择。'); return; }
        working.current = true;
        setBusy(true);
        try {
            const folder = newPersonalGroup(name);
            await DB.saveEmojiCategory(folder);
            await onChange();
            if (alive.current) {
                setDestination(folder.id);
                setCreating(false);
                setFolderName('');
                setSummary('');
            }
        } catch {
            if (alive.current) setSummary('文件夹创建失败，请重试。');
        } finally {
            working.current = false;
            if (alive.current) setBusy(false);
        }
    }
    async function saveLinks() {
        if (working.current || !links.trim() || creating) return;
        const lines = links.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const remaining: string[] = [];
        let saved = 0, invalid = 0, failed = 0;
        working.current = true;
        stopped.current = false;
        setBusy(true);
        setSummary('');
        try {
            for (const [i, line] of lines.entries()) {
                if (stopped.current) { remaining.push(...lines.slice(i)); break; }
                const separator = line.indexOf('--');
                const name = line.slice(0, separator).trim(), url = line.slice(separator + 2).trim();
                if (separator < 1 || !name || !(isRemoteEmoji(url) || url.startsWith('data:image/'))) {
                    invalid++; remaining.push(line); continue;
                }
                try {
                    const stored = url.startsWith('data:') ? await migrateDataUrlToRef(url) : url;
                    await DB.saveEmoji(name, stored, destination && destination !== 'default' ? destination : undefined);
                    saved++;
                } catch {
                    failed++; remaining.push(line);
                }
            }
            const result = !remaining.length ? '完成' : saved ? '部分完成' : stopped.current ? '取消' : '失败';
            trackEvent('批量导入表情', { 方式: '粘贴链接', 结果: result });
            const message = '已导入 ' + saved + ' 条表情链接。' +
                (invalid ? invalid + ' 行格式有误，请按「名称--图片链接」填写。' : '') +
                (failed ? failed + ' 行保存失败，可重试。' : '') + (stopped.current ? '已停止。' : '');
            if (alive.current) { setLinks(remaining.join('\n')); setSummary(message); }
            if (saved) await onChange();
            if (alive.current && !remaining.length && !rows.length) onLinksSaved(destination || 'default', message);
        } catch {
            if (alive.current) setSummary('表情列表刷新失败，重新打开表情库可查看已保存的链接。');
        } finally {
            working.current = false;
            if (alive.current) setBusy(false);
        }
    }
    async function save() {
        if (working.current) return;
        working.current = true;
        stopped.current = false;
        setBusy(true);
        setSummary('');
        const next = rows.slice();
        let saved = 0,
            skipped = 0,
            failed = 0;
        const personal = new Map(groups.filter((g) => g.personalOnly).map((g) => [g.name, g]));
        try {
            const live = await stickerNameIndex(
                emojis,
                rows.map((r) => r.name)
            );
            const known = new Map(emojis.map((e) => [e.name, { url: e.url, hash: live.get(e.name) || '' }]));
            for (const [i, row] of rows.entries()) {
                if (stopped.current) break;
                if (row.done) continue;
                setProgress('正在导入 ' + (i + 1) + ' / ' + rows.length);
                try {
                    let group = groups.find((g) => g.id === destination);
                    if (destination && !group) throw new Error('目标分组已删除');
                    if (!group) {
                        group = personal.get(row.group) || newPersonalGroup(row.group);
                        personal.set(row.group, group);
                    }
                    const compact = compress && row.compact ? row.compact : undefined;
                    const item = compact ? { name: row.name, group: row.group, read: async () => compact.blob } : row;
                    const result = await importSticker(
                        item,
                        group,
                        !groups.some((existing) => existing.id === group.id),
                        known
                    );
                    if (result.duplicate) skipped++;
                    else saved++;
                    next[i] = {
                        ...row,
                        done: true,
                        error: undefined,
                        savedName: result.duplicate ? undefined : result.name,
                        savedHash: compact?.hash || row.hash,
                    };
                } catch (error) {
                    failed++;
                    next[i] = { ...row, error: error instanceof Error ? error.message : '写入失败' };
                    if ((error as Error)?.name === 'QuotaExceededError') {
                        stopped.current = true;
                        break;
                    }
                }
            }
            const result = stopped.current
                ? saved || skipped
                    ? '部分完成'
                    : '取消'
                : failed
                  ? saved || skipped
                      ? '部分完成'
                      : '失败'
                  : '完成';
            trackEvent('批量导入表情', { 方式: kind.current, 结果: result });
            if (alive.current) {
                setRows(next);
                setSummary(
                    '已导入 ' +
                        saved +
                        ' 张，跳过重复 ' +
                        skipped +
                        ' 张，失败 ' +
                        failed +
                        ' 张。' +
                        (stopped.current ? '已停止。' : '')
                );
            }
        } catch (e) {
            trackEvent('批量导入表情', { 方式: kind.current, 结果: '失败' });
            if (alive.current) setSummary(e instanceof Error ? e.message : '导入失败');
        } finally {
            try {
                await onChange();
            } finally {
                working.current = false;
                if (alive.current) {
                    setBusy(false);
                    setProgress('');
                }
            }
        }
    }
    return (
        <section className="st-work">
            <header className="st-heading">
                <button onClick={back}>{busy ? '停止' : '返回'}</button>
                <h2>{pasting ? '粘贴表情链接' : '导入表情'}</h2>
            </header>
            <input
                hidden
                type="file"
                accept="image/*"
                multiple
                ref={pictures}
                onChange={(e) => {
                    const files = Array.from(e.currentTarget.files || []);
                    e.currentTarget.value = '';
                    void select(files, '本地选图');
                }}
            />
            <input
                hidden
                type="file"
                accept=".zip,application/zip"
                multiple
                ref={zip}
                onChange={(e) => {
                    const files = Array.from(e.currentTarget.files || []);
                    e.currentTarget.value = '';
                    void select(files, 'ZIP');
                }}
            />
            {!pasting && <div className="st-actions">
                <button className="st-primary" disabled={busy} onClick={() => pictures.current?.click()}>
                    本地选图
                </button>
                <button disabled={busy} onClick={() => zip.current?.click()}>
                    打开 ZIP
                </button>
                <button disabled={busy || creating} onClick={() => { setPasting(true); setSummary(''); }}>
                    粘贴链接
                </button>
            </div>}
            <label className="st-field">
                导入到
                <select value={creating ? createFolder : destination} disabled={busy} onChange={(e) => {
                    const value = e.target.value;
                    setCreating(value === createFolder);
                    if (value !== createFolder) setDestination(value);
                    setSummary('');
                }}>
                    <option value="">{pasting ? '默认分组' : '按文件夹分组 · 仅自己使用'}</option>
                    <option value={createFolder}>＋ 新建文件夹…</option>
                    {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                            {g.name}
                        </option>
                    ))}
                </select>
            </label>
            {creating && <div className="st-new-folder">
                <label className="st-field">新文件夹名称
                    <input autoFocus value={folderName} disabled={busy} onChange={e => setFolderName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); void addFolder(); } }} />
                </label>
                <button type="button" disabled={busy || !folderName.trim()} onClick={() => void addFolder()}>创建并选用</button>
            </div>}
            {pasting ? <>
                <label className="st-field">表情名称和图片链接
                    <textarea autoFocus rows={6} value={links} disabled={busy}
                        placeholder={'开心--https://example.com/happy.gif\n抱抱--https://example.com/hug.png'}
                        onChange={e => setLinks(e.target.value)} />
                </label>
                <p>每行一个「名称--图片链接」。同名表情会被覆盖。</p>
                <p role="status">{summary}</p>
                <div className="st-actions">
                    <button disabled={busy} onClick={back}>返回导入</button>
                    <button className="st-primary" disabled={busy || creating || !links.trim()}
                        onClick={() => void saveLinks()}>导入链接</button>
                </div>
            </> : <>
            <label className="st-check">
                <span>压缩较大的静态图片</span>
                <input type="checkbox" checked={compress} disabled={busy || rows.some(r => r.done)} onChange={e => setCompress(e.target.checked)} />
            </label>
            <p>省空间模式会缩小较大的静态照片和 PNG，保留透明背景。动图和从糯米机导出的 ZIP 会保留原文件。</p>
            {!rows.length && !busy && (
                <p>可以一次选择多张。默认沿用文件名，导入后仍可改名或选择「看图起名」。</p>
            )}
            <p role="status">{progress || summary}</p>
            {!!rows.length && (
                <>
                    <div className="st-heading">
                        <strong>{rows.length} 张图片</strong>
                        <span>{preview.filter((r) => r.duplicate).length} 张同名同图</span>
                    </div>
                    <p>本批图片文件 {stickerBytes(rows.reduce((sum, row, i) => sum + (preview[i].duplicate ? 0 : (compress ? row.compact?.blob.size : undefined) ?? row.size), 0))}，外链仅保存链接。</p>
                    {rows.slice(page * 24, (page + 1) * 24).map((item, n) => {
                        const i = page * 24 + n,
                            plan = preview[i];
                        return (
                            <label className="st-import-row" key={i}>
                                <FilePreview item={item} />
                                <div>
                                    <input
                                        aria-label={'表情名称 ' + (i + 1)}
                                        disabled={busy || item.done}
                                        value={item.name}
                                        onChange={(e) =>
                                            setRows((old) =>
                                                old.map((r, j) =>
                                                    j === i ? { ...r, name: e.target.value } : r
                                                )
                                            )
                                        }
                                    />
                                    <small>
                                        {item.done
                                            ? '已处理'
                                            : item.error ||
                                              (plan.duplicate
                                                  ? '同名同图 · 跳过'
                                                  : plan.name !== item.name
                                                    ? '保存为 ' + plan.name
                                                    : destination
                                                      ? ''
                                                      : item.group)}
                                    </small>
                                </div>
                            </label>
                        );
                    })}
                    <div className="st-foot">
                        <button disabled={!page} onClick={() => setPage(page - 1)}>
                            上一页
                        </button>
                        <span>
                            {page + 1} / {Math.ceil(rows.length / 24)}
                        </span>
                        <button disabled={(page + 1) * 24 >= rows.length} onClick={() => setPage(page + 1)}>
                            下一页
                        </button>
                    </div>
                    <div className="st-commit">
                        {!busy && imported.length > 0 && (
                            <button onClick={() => onNameImported(imported)}>
                                为新导入的 {imported.length} 张看图起名
                            </button>
                        )}
                        <button
                            className="st-primary"
                            disabled={busy || creating}
                            onClick={() => (rows.every((r) => r.done) ? onClose() : void save())}
                        >
                            {rows.every((r) => r.done)
                                ? '完成'
                                : rows.some((r) => r.done)
                                  ? '继续导入剩余图片'
                                  : '确认导入'}
                        </button>
                    </div>
                </>
            )}
            </>}
        </section>
    );
}
