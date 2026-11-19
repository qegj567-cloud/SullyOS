import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    ArrowLeft,
    Check,
    CheckSquare,
    MagnifyingGlass,
    Plus,
    SlidersHorizontal,
    X,
} from '@phosphor-icons/react';
import type { APIConfig, CharacterGroup, CharacterProfile, Emoji, EmojiCategory } from '../../types';
import { DB } from '../../utils/db';
import { resolveDialogueApi } from '../../utils/characterApi';
import { measureStickerStorage, moveStickers, newPersonalGroup, stickerBytes as bytes } from '../../utils/emojiLibrary';
import { trackEvent } from '../../utils/analytics';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import EmojiImage from './EmojiImage';
import EmojiExportDialog from './EmojiExportDialog';
import EmojiHealthDialog from './EmojiHealthDialog';
import StickerImportPanel from './StickerImportPanel';
import StickerPicker from './StickerPicker';
import { GROUP_FILTER_UNGROUPED, sortCharacterGroups } from '../character/CharacterGroupFilter';
import StickerNames from './StickerNames';
import './StickerLibrary.css';

type Props = {
    emojis: Emoji[];
    groups: EmojiCategory[];
    characters: CharacterProfile[];
    characterGroups: CharacterGroup[];
    characterId: string;
    api: APIConfig;
    startImport?: string;
    onClose: () => void;
    onChange: () => Promise<void>;
    onVision: (id: string, enabled: boolean) => Promise<void>;
};
const tabs = ['表情库', '角色分配', '本机空间'] as const;
type Tab = (typeof tabs)[number];
const visible = (g: EmojiCategory, id: string) =>
    !g.personalOnly && (!g.allowedCharacterIds?.length || g.allowedCharacterIds.includes(id));
const pageSize = 48;

export default function StickerLibrary({
    emojis,
    groups,
    characters,
    characterId,
    api,
    startImport,
    onClose,
    onChange,
    onVision,
    characterGroups,
}: Props) {
    const [tab, setTab] = useState<Tab>('表情库'),
        [group, setGroup] = useState(''),
        [query, setQuery] = useState('');
    const [page, setPage] = useState(0),
        [selecting, setSelecting] = useState(false),
        [selected, setSelected] = useState(new Set<string>());
    const [importing, setImporting] = useState(startImport !== undefined),
        [target, setTarget] = useState(startImport);
    const [inspect, setInspect] = useState<Emoji>(),
        [edit, setEdit] = useState('');
    const [action, setAction] = useState<'delete' | 'move' | 'group' | 'remove-group' | 'create' | null>(null);
    const [exportItems, setExportItems] = useState<Emoji[]>(),
        [nameItems, setNameItems] = useState<Emoji[]>(),
        [scan, setScan] = useState<Emoji[]>();
    const [roleId, setRoleId] = useState(characterId),
        [status, setStatus] = useState(''),
        [busy, setBusy] = useState(false);
    const [measure, setMeasure] = useState<Awaited<ReturnType<typeof measureStickerStorage>>>(),
        [revision, setRevision] = useState(0);
    const locked = useRef(false);
    const opened = useRef(false);
    useEffect(() => {
        if (opened.current) return;
        opened.current = true;
        trackEvent('打开表情管理');
    }, []);
    const refreshScan = useCallback(() => setRevision((n) => n + 1), []);
    const role = characters.find((c) => c.id === roleId),
        activeGroup = groups.find((g) => g.id === group);
    const visionApi = api.visionApi?.enabled ? api.visionApi : undefined;
    const roleApi = visionApi ?? resolveDialogueApi(api, role);
    const results = useMemo(
        () =>
            emojis.filter(
                (row) =>
                    (!group || (row.categoryId || 'default') === group) &&
                    row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
            ),
        [emojis, group, query]
    );
    const counts = useMemo(() => {
        const map = new Map<string, number>();
        for (const e of emojis)
            map.set(e.categoryId || 'default', (map.get(e.categoryId || 'default') || 0) + 1);
        return map;
    }, [emojis]);
    const folderOptions = useMemo(() => [
        { id: '', name: '全部表情', detail: emojis.length + ' 张' },
        ...groups.map(g => ({ id: g.id, name: g.name, detail: (counts.get(g.id) || 0) + ' 张' })),
    ], [groups, counts, emojis.length]);
    const roleFilters = useMemo(() => [
        { id: '', name: '全部角色' },
        ...sortCharacterGroups(characterGroups),
        { id: GROUP_FILTER_UNGROUPED, name: '未分组' },
    ], [characterGroups]);
    const roleOptions = useMemo(() => {
        const names = new Map(characterGroups.map(g => [g.id, g.name]));
        return characters.map(c => {
            const groupId = c.groupId && names.has(c.groupId) ? c.groupId : GROUP_FILTER_UNGROUPED;
            return { id: c.id, name: c.name, groupId, detail: names.get(groupId) || '未分组' };
        });
    }, [characters, characterGroups]);
    const picked = useMemo(() => emojis.filter((row) => selected.has(row.name)), [emojis, selected]);
    const currentPage = Math.min(page, Math.max(0, Math.ceil(results.length / pageSize) - 1));
    const chooseGroup = (id: string) => {
        setGroup(id);
        setPage(0);
        setSelected(new Set());
        setStatus('');
    };
    const resetSelection = () => {
        setSelecting(false);
        setSelected(new Set());
    };
    const back = () => {
        if (locked.current) return true;
        if (exportItems) setExportItems(undefined);
        else if (scan) setScan(undefined);
        else if (action) setAction(null);
        else if (inspect) setInspect(undefined);
        else if (importing) setImporting(false);
        else if (nameItems) setNameItems(undefined);
        else if (selecting) resetSelection();
        else onClose();
        return true;
    };
    useLocalBackHandler(back, 35);
    useEffect(() => {
        if (tab !== '本机空间') return;
        let active = true;
        setMeasure(undefined);
        measureStickerStorage(emojis)
            .then((value) => {
                if (active) setMeasure(value);
            })
            .catch(() => {
                if (active) setStatus('读取表情图片占用失败');
            });
        return () => {
            active = false;
        };
    }, [tab, emojis, revision]);
    async function change(work: () => Promise<string | void>) {
        if (locked.current) return;
        locked.current = true;
        setBusy(true);
        setStatus('');
        try {
            const message = await work();
            await onChange();
            setStatus(message || '已保存');
        } catch (error) {
            setStatus(error instanceof Error ? error.message : '操作失败，请重试');
        } finally {
            locked.current = false;
            setBusy(false);
        }
    }
    const toggle = (name: string) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    const beginImport = () => {
        setTarget(group || undefined);
        setImporting(true);
        setStatus('');
    };
    const editGroup = (g: EmojiCategory) => {
        chooseGroup(g.id);
        setEdit(g.name);
        setAction('group');
    };
    const setRoleGroup = (g: EmojiCategory, checked: boolean) =>
        change(async () => {
            const list = g.personalOnly
                ? []
                : g.allowedCharacterIds?.length
                  ? g.allowedCharacterIds
                  : characters.map((c) => c.id);
            const ids = checked ? [...new Set([...list, roleId])] : list.filter((id) => id !== roleId);
            await DB.saveEmojiCategory({ ...g, personalOnly: !ids.length, allowedCharacterIds: ids });
        });
    return createPortal(
        <div className="st-library" role="dialog" aria-modal="true" aria-label="表情管理">
            {importing ? (
                <StickerImportPanel
                    emojis={emojis}
                    groups={groups}
                    target={target}
                    onChange={onChange}
                    onClose={() => setImporting(false)}
                    onLinksSaved={(id, message) => {
                        chooseGroup(groups.some(g => g.id === id) ? id : '');
                        setQuery('');
                        resetSelection();
                        setTab('表情库');
                        setImporting(false);
                        setStatus(message);
                    }}
                    onNameImported={(items) => {
                        setImporting(false);
                        setNameItems(items);
                    }}
                />
            ) : nameItems ? (
                <StickerNames
                    items={nameItems}
                    api={api}
                    library={emojis}
                    onClose={() => {
                        setNameItems(undefined);
                        resetSelection();
                    }}
                    onChange={onChange}
                />
            ) : (
                <>
                    <header className="st-top">
                        <button aria-label="返回聊天" onClick={back}>
                            <ArrowLeft size={20} />
                        </button>
                        <h1>表情管理</h1>
                        <button className="st-primary" onClick={beginImport}>
                            <Plus />
                            导入
                        </button>
                    </header>
                    <nav className="st-tabs" aria-label="管理栏目">
                        {tabs.map((t) => (
                            <button
                                key={t}
                                aria-current={tab === t ? 'page' : undefined}
                                onClick={() => {
                                    setTab(t);
                                    setStatus('');
                                    resetSelection();
                                    setAction(null);
                                    setInspect(undefined);
                                }}
                            >
                                {t}
                            </button>
                        ))}
                    </nav>
                    <main className="st-main">
                        <p className="st-status" role="status">
                            {status}
                        </p>
                        {tab === '表情库' && (
                            <div className="st-layout">
                                <aside className="st-groups">
                                    <StickerPicker label="选择表情分组" searchLabel="搜索表情分组" options={folderOptions}
                                        value={group} onChange={chooseGroup} />
                                    <button
                                        aria-label="新建分组"
                                        onClick={() => {
                                            setEdit('');
                                            setAction('create');
                                        }}
                                    >
                                        <Plus size={16} /> 新建分组
                                    </button>
                                </aside>
                                <section className="st-content">
                                    <div className="st-search">
                                        <MagnifyingGlass />
                                        <input
                                            placeholder="搜索表情名称"
                                            aria-label="搜索表情名称"
                                            value={query}
                                            onChange={(e) => {
                                                setQuery(e.target.value);
                                                setPage(0);
                                                setSelected(new Set());
                                            }}
                                        />
                                    </div>
                                    <div className="st-heading">
                                        <h2>
                                            {activeGroup?.name || '全部表情'} <small>{results.length}</small>
                                        </h2>
                                        {activeGroup && (
                                            <button
                                                aria-label="管理当前分组"
                                                onClick={() => editGroup(activeGroup)}
                                            >
                                                <SlidersHorizontal />
                                            </button>
                                        )}
                                        <button
                                            onClick={() => (selecting ? resetSelection() : setSelecting(true))}
                                        >
                                            {selecting ? '取消选择' : '选择'}
                                        </button>
                                    </div>
                                    {selecting && (
                                        <button
                                            className="st-text"
                                            onClick={() =>
                                                setSelected(
                                                    selected.size === results.length
                                                        ? new Set()
                                                        : new Set(results.map((e) => e.name))
                                                )
                                            }
                                        >
                                            {selected.size === results.length ? '取消全选' : '全选当前结果'}
                                        </button>
                                    )}
                                    {!results.length && (
                                        <p className="st-empty">
                                            {query ? '没有找到这个名字' : '这个分组还没有表情'}
                                            {!query && <button onClick={beginImport}>导入图片</button>}
                                        </p>
                                    )}
                                    <div className="st-grid">
                                        {results
                                            .slice(currentPage * pageSize, (currentPage + 1) * pageSize)
                                            .map((row) => (
                                                <button
                                                    key={row.name}
                                                    className="st-tile"
                                                    aria-label={row.name}
                                                    aria-pressed={
                                                        selecting ? selected.has(row.name) : undefined
                                                    }
                                                    onClick={() => {
                                                        if (selecting) toggle(row.name);
                                                        else {
                                                            setInspect(row);
                                                            setEdit(row.name);
                                                            setStatus('');
                                                        }
                                                    }}
                                                >
                                                    <span className="st-photo">
                                                        <EmojiImage value={row.url} loading="lazy" alt="" />
                                                        {selecting && (
                                                            <i>
                                                                {selected.has(row.name) && (
                                                                    <Check weight="bold" />
                                                                )}
                                                            </i>
                                                        )}
                                                    </span>
                                                    <span>{row.name}</span>
                                                </button>
                                            ))}
                                    </div>
                                    {results.length > pageSize && (
                                        <div className="st-foot">
                                            <button
                                                disabled={currentPage === 0}
                                                onClick={() => setPage(currentPage - 1)}
                                            >
                                                上一页
                                            </button>
                                            <span>
                                                {currentPage + 1} / {Math.ceil(results.length / pageSize)}
                                            </span>
                                            <button
                                                disabled={(currentPage + 1) * pageSize >= results.length}
                                                onClick={() => setPage(currentPage + 1)}
                                            >
                                                下一页
                                            </button>
                                        </div>
                                    )}
                                </section>
                            </div>
                        )}
                        {tab === '角色分配' && (
                            <section className="st-settings">
                                <StickerPicker label="选择角色" searchLabel="搜索角色名或分组" options={roleOptions}
                                    groups={characterGroups.length ? roleFilters : undefined} value={roleId} disabled={busy}
                                    onChange={id => { setRoleId(id); setStatus(''); }} />
                                <h2>
                                    可用表情组{' '}
                                    <small>
                                        {groups
                                            .filter((g) => visible(g, roleId))
                                            .reduce((sum, g) => sum + (counts.get(g.id) || 0), 0)}{' '}
                                        张
                                    </small>
                                </h2>
                                <p>
                                    分给 TA
                                    的表情名称会进入聊天上下文。组越多，留给聊天记录和设定的空间就越少。建议只分配常用组。
                                </p>
                                {groups.map((g) => (
                                    <label className="st-check" key={g.id}>
                                        <span>
                                            {g.name} <small>{counts.get(g.id) || 0} 张</small>
                                        </span>
                                        <input
                                            type="checkbox"
                                            checked={visible(g, roleId)}
                                            disabled={busy || !role}
                                            onChange={(e) => void setRoleGroup(g, e.target.checked)}
                                        />
                                    </label>
                                ))}
                                <h2>私聊看图</h2>
                                <label className="st-check">
                                    <span>让 TA 看懂我发的表情图片</span>
                                    <input
                                        type="checkbox"
                                        checked={!!role?.stickerVision}
                                        disabled={
                                            !role ||
                                            busy ||
                                            (!role.stickerVision && (!roleApi.baseUrl || !roleApi.model))
                                        }
                                        onChange={(e) => {
                                            const checked = e.target.checked;
                                            void change(() => onVision(roleId, checked));
                                        }}
                                    />
                                </label>
                                <p>
                                    {api.visionApi?.enabled
                                        ? '独立识图 API 会把已发送的表情转成描述。'
                                        : '已发送的表情将交给当前对话模型，请确认它支持图片。'}{' '}
                                    当前模型：{roleApi.model || '请先在设置中配置'}
                                    。开启会增加用量，图库里的其他图片不会发送。
                                </p>
                            </section>
                        )}
                        {tab === '本机空间' && (
                            <section className="st-settings">
                                <h2>表情图片在本机的占用</h2>
                                <strong className="st-size">
                                    {measure
                                        ? bytes(measure.local + measure.cached + measure.builtIn)
                                        : '统计中…'}
                                </strong>
                                <p>这里统计当前表情库保存的图片和图床缓存，同一份图片只计算一次。</p>
                                {measure && (
                                    <>
                                        <dl>
                                            {[
                                                ['本地图片文件', bytes(measure.local)],
                                                ['内置表情的图床缓存', bytes(measure.builtIn)],
                                                ['其他图床缓存', bytes(measure.cached)],
                                                ['尚未缓存的链接', measure.remoteOnly + ' 条'],
                                            ].map(([k, v]) => (
                                                <div key={k}>
                                                    <dt>{k}</dt>
                                                    <dd>{v}</dd>
                                                </div>
                                            ))}
                                        </dl>
                                        <p>导出时，{measure.files} 张本地图片随包保存；{measure.links} 条图床表情只带链接。换设备后，链接图片会在查看时重新加载。</p>
                                        <h2>按分组查看</h2>
                                        {groups
                                            .slice()
                                            .sort(
                                                (a, b) =>
                                                    (measure.groups.get(b.id) || 0) -
                                                    (measure.groups.get(a.id) || 0)
                                            )
                                            .map((g) => (
                                                <button
                                                    className="st-check"
                                                    key={g.id}
                                                    onClick={() => {
                                                        chooseGroup(g.id);
                                                        setTab('表情库');
                                                    }}
                                                >
                                                    {g.name}
                                                    <small>{bytes(measure.groups.get(g.id) || 0)}</small>
                                                </button>
                                            ))}
                                    </>
                                )}
                                <button
                                    onClick={() => {
                                        trackEvent('刷新排查表情包');
                                        setScan(emojis.slice());
                                    }}
                                >
                                    刷新排查全部表情
                                </button>
                            </section>
                        )}
                    </main>
                    {selecting && tab === '表情库' && (
                        <footer className="st-bulk">
                            <b>
                                <CheckSquare />
                                {picked.length}
                            </b>
                            <button
                                disabled={!picked.length}
                                onClick={() => {
                                    setEdit(group || groups[0]?.id || 'default');
                                    setAction('move');
                                }}
                            >
                                移组
                            </button>
                            <button disabled={!picked.length} onClick={() => setNameItems(picked)}>
                                看图起名
                            </button>
                            <button disabled={!picked.length} onClick={() => setExportItems(picked)}>
                                导出
                            </button>
                            <button
                                className="st-danger"
                                disabled={!picked.length}
                                onClick={() => setAction('delete')}
                            >
                                删除
                            </button>
                        </footer>
                    )}
                    {(inspect || action) && (
                        <div className="st-shade">
                            <section className="st-sheet" aria-label="编辑表情">
                                <button
                                    className="st-dismiss"
                                    aria-label="关闭编辑"
                                    onClick={() => {
                                        setInspect(undefined);
                                        setAction(null);
                                    }}
                                >
                                    <X />
                                </button>
                                {inspect && !action && (
                                    <>
                                        <EmojiImage
                                            value={inspect.url}
                                            alt={inspect.name}
                                            className="st-large"
                                        />
                                        <label className="st-field">
                                            表情名称
                                            <input value={edit} onChange={(e) => setEdit(e.target.value)} />
                                        </label>
                                        <div className="st-actions">
                                            <button
                                                disabled={busy || !edit.trim()}
                                                className="st-primary"
                                                onClick={() =>
                                                    void change(async () => {
                                                        await DB.renameEmoji(inspect.name, edit, inspect.url);
                                                        setInspect(undefined);
                                                    })
                                                }
                                            >
                                                保存名称
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setExportItems([inspect]);
                                                    setInspect(undefined);
                                                }}
                                            >
                                                导出表情
                                            </button>
                                        </div>
                                    </>
                                )}
                                {action === 'delete' && (
                                    <>
                                        <h2>删除选中的 {picked.length} 张表情？</h2>
                                        <p>从表情库移除。已经发出的聊天图片会保留。</p>
                                        <button
                                            className="st-danger"
                                            disabled={busy}
                                            onClick={() =>
                                                void change(async () => {
                                                    const n = await DB.deleteScannedEmojis(picked);
                                                    if (n) trackEvent('批量删除表情');
                                                    resetSelection();
                                                    setAction(null);
                                                    return '已删除 ' + n + ' 张';
                                                })
                                            }
                                        >
                                            确认删除
                                        </button>
                                    </>
                                )}
                                {action === 'move' && (
                                    <>
                                        <label className="st-field">
                                            移动到分组
                                            <select value={edit} onChange={(e) => setEdit(e.target.value)}>
                                                {groups.map((g) => (
                                                    <option key={g.id} value={g.id}>
                                                        {g.name}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                        <button
                                            disabled={busy}
                                            onClick={() =>
                                                void change(async () => {
                                                    const n = await moveStickers(picked, edit);
                                                    setAction(null);
                                                    resetSelection();
                                                    return '已移动 ' + n + ' 张';
                                                })
                                            }
                                        >
                                            确认移动
                                        </button>
                                    </>
                                )}
                                {(action === 'group' || action === 'create') && (
                                    <>
                                        <h2>{action === 'create' ? '新建分组' : '管理分组'}</h2>
                                        <label className="st-field">
                                            分组名称
                                            <input value={edit} onChange={(e) => setEdit(e.target.value)} />
                                        </label>
                                        {activeGroup && action === 'group' && (
                                            <>
                                                <p>
                                                    {activeGroup.personalOnly
                                                        ? '仅自己使用'
                                                        : activeGroup.allowedCharacterIds?.length
                                                          ? '分配给 ' +
                                                            characters
                                                                .filter((c) =>
                                                                    activeGroup.allowedCharacterIds?.includes(
                                                                        c.id
                                                                    )
                                                                )
                                                                .map((c) => c.name)
                                                                .join('、')
                                                          : '所有角色可用'}
                                                </p>
                                                <div className="st-actions">
                                                    <button
                                                        disabled={busy}
                                                        onClick={() =>
                                                            void change(() =>
                                                                DB.saveEmojiCategory({
                                                                    ...activeGroup,
                                                                    personalOnly: true,
                                                                    allowedCharacterIds: [],
                                                                })
                                                            )
                                                        }
                                                    >
                                                        仅自己使用
                                                    </button>
                                                    <button
                                                        disabled={busy}
                                                        onClick={() =>
                                                            void change(() =>
                                                                DB.saveEmojiCategory({
                                                                    ...activeGroup,
                                                                    personalOnly: false,
                                                                    allowedCharacterIds: [],
                                                                })
                                                            )
                                                        }
                                                    >
                                                        所有角色可用
                                                    </button>
                                                </div>
                                            </>
                                        )}
                                        <div className="st-actions">
                                            <button
                                                className="st-primary"
                                                disabled={busy || !edit.trim()}
                                                onClick={() =>
                                                    void change(async () => {
                                                        const g =
                                                            action === 'create'
                                                                ? newPersonalGroup(edit)
                                                                : { ...activeGroup!, name: edit.trim() };
                                                        await DB.saveEmojiCategory(g);
                                                        chooseGroup(g.id);
                                                        setAction(null);
                                                    })
                                                }
                                            >
                                                保存分组
                                            </button>
                                            {action === 'group' && !activeGroup?.isSystem && (
                                                <button
                                                    className="st-danger"
                                                    onClick={() => setAction('remove-group')}
                                                >
                                                    删除分组
                                                </button>
                                            )}
                                        </div>
                                    </>
                                )}
                                {action === 'remove-group' && activeGroup && (
                                    <>
                                        <h2>
                                            删除「{activeGroup.name}」和组内 {counts.get(group) || 0} 张表情？
                                        </h2>
                                        <button
                                            className="st-danger"
                                            disabled={busy}
                                            onClick={() =>
                                                void change(async () => {
                                                    await DB.deleteEmojiCategory(group);
                                                    chooseGroup('');
                                                    setAction(null);
                                                })
                                            }
                                        >
                                            确认删除分组
                                        </button>
                                    </>
                                )}
                                {status && <p role="status">{status}</p>}
                            </section>
                        </div>
                    )}
                </>
            )}
            {exportItems && (
                <EmojiExportDialog
                    emojis={exportItems}
                    groups={groups}
                    onClose={() => setExportItems(undefined)}
                />
            )}
            {scan && (
                <EmojiHealthDialog
                    emojis={scan}
                    onClose={() => setScan(undefined)}
                    onRefreshed={refreshScan}
                    onRemove={async (rows) => {
                        const n = await DB.deleteScannedEmojis(rows);
                        await onChange();
                        return n;
                    }}
                />
            )}
        </div>,
        document.body
    );
}
