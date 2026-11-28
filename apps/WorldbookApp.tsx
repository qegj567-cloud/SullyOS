import React, { useState, useMemo, useRef } from 'react';
import { useOS } from '../context/OSContext';
import { AppID as ShortcutAppID, Worldbook, WorldbookDepthRole, WorldbookPosition, WorldbookSelectiveLogic } from '../types';
import Modal from '../components/os/Modal';
import { Check, DiamondsFour, BookOpen, DownloadSimple, Trash, UploadSimple, WarningCircle, X } from '@phosphor-icons/react';
import {
    buildWorldbookCatalog,
    computeWorldbookGroupMembershipChanges,
    normalizeWorldbookGroup,
    parseStandardWorldbook,
    resolveWorldbookCategoryMeta,
    serializeSullyWorldbook,
    splitWorldbookKeywords,
    WORLDBOOK_DEFAULT_CATEGORY,
    WORLDBOOK_POSITION_DESCRIPTIONS,
    WORLDBOOK_POSITION_LABELS,
    WORLDBOOK_ROLE_LABELS,
    type WorldbookPackage,
} from '../utils/worldbook';
import { confirmExportSafety } from '../utils/exportGuard';
import { shareOrDownloadFile } from '../utils/shareExport';
import { readShareFile } from '../utils/pngShare';
import { trackEvent } from '../utils/analytics';
import { summarizeWorldbookScenes, type WorldbookScenes } from '../utils/worldbookScenes';
import WorldbookSceneEditor from '../components/worldbook/WorldbookSceneEditor';
import { useAppShortcut } from '../utils/appShortcutLaunch';
import { useConfirmDialog } from '../hooks/useConfirmDialog';

const SwitchButton: React.FC<{
    checked: boolean;
    label: string;
    disabled?: boolean;
    size?: 'sm' | 'md';
    onClick: (event: React.MouseEvent) => void;
}> = ({ checked, label, disabled, size = 'md', onClick }) => {
    const trackCls = size === 'sm' ? 'w-9 h-5 p-0.5' : 'w-11 h-6 p-0.5';
    const knobCls = size === 'sm'
        ? `w-4 h-4 ${checked ? 'translate-x-4' : 'translate-x-0'}`
        : `w-5 h-5 ${checked ? 'translate-x-5' : 'translate-x-0'}`;
    return (
        <button
            type="button"
            role="switch"
            aria-label={label}
            aria-checked={checked}
            disabled={disabled}
            onClick={onClick}
            className={`relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:opacity-50 ${trackCls} ${checked ? 'bg-indigo-500' : 'bg-slate-200'}`}
        >
            <span className={`block rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-200 ${knobCls}`} />
        </button>
    );
};

const WorldbookApp: React.FC = () => {
    const { closeApp, worldbooks, addWorldbook, updateWorldbook, updateWorldbooks, deleteWorldbook, deleteWorldbooks, addToast } = useOS();
    const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });

    // View State
    const [isEditing, setIsEditing] = useState(false);
    const [editingBook, setEditingBook] = useState<Worldbook | null>(null);
    const [expandedCategory, setExpandedCategory] = useState<string | null>(null);
    const [collapsedOuterGroups, setCollapsedOuterGroups] = useState<Set<string>>(new Set());
    const [previewBookId, setPreviewBookId] = useState<string | null>(null);

    useAppShortcut(ShortcutAppID.Worldbook, intent => {
        const target = worldbooks.find(book => book.id === intent.resourceId);
        setIsEditing(false);
        setIsSelecting(false);
        setPreviewBookId(target?.id || null);
        if (target) {
            setExpandedCategory(target.category || WORLDBOOK_DEFAULT_CATEGORY);
            const g = normalizeWorldbookGroup(target.group);
            if (g) {
                setCollapsedOuterGroups(prev => {
                    const next = new Set(prev);
                    next.delete(`group:${g}`);
                    return next;
                });
            }
        }
        if (intent.resourceId && !target) addToast('这条世界书已不存在，请重新设置槽位', 'error');
    });

    const [categoryPages, setCategoryPages] = useState<Record<string, number>>({});
    const [isSelecting, setIsSelecting] = useState(false);
    const [selectedBookIds, setSelectedBookIds] = useState<Set<string>>(new Set());
    const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);

    // 整本世界书编辑弹窗
    const [groupEditor, setGroupEditor] = useState<{
        category: string;
        name: string;
        outerGroup: string;
        mode: 'keep' | 'constant' | 'keyword';
        scenesMode: 'keep' | 'set';
        scenes: WorldbookScenes;
    } | null>(null);
    const [savingGroup, setSavingGroup] = useState(false);

    // 外层分组（将多本世界书归入一组）编辑弹窗
    const [folderEditor, setFolderEditor] = useState<{
        mode: 'create' | 'edit';
        previousName?: string;
        name: string;
        selectedCategories: Set<string>;
    } | null>(null);
    const [savingFolder, setSavingFolder] = useState(false);

    const [togglingBusy, setTogglingBusy] = useState(false);
    const [deletingBooks, setDeletingBooks] = useState(false);
    const PAGE_SIZE = 12;

    // Edit Form State
    const [tempTitle, setTempTitle] = useState('');
    const [tempContent, setTempContent] = useState('');
    const [tempCategory, setTempCategory] = useState('');
    const [showCategoryPicker, setShowCategoryPicker] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showImportConfirm, setShowImportConfirm] = useState(false);
    const importRef = useRef<HTMLInputElement>(null);
    const [tempEnabled, setTempEnabled] = useState(true);
    const [tempConstant, setTempConstant] = useState(true);
    const [tempKeywords, setTempKeywords] = useState('');
    const [tempSecondaryKeywords, setTempSecondaryKeywords] = useState('');
    const [tempSelectiveLogic, setTempSelectiveLogic] = useState<WorldbookSelectiveLogic>(0);
    const [tempPosition, setTempPosition] = useState<WorldbookPosition>(1);
    const [tempDepth, setTempDepth] = useState(4);
    const [tempRole, setTempRole] = useState<WorldbookDepthRole>(0);
    const [tempOrder, setTempOrder] = useState(100);
    const [tempScanDepth, setTempScanDepth] = useState(4);
    const [tempUseProbability, setTempUseProbability] = useState(false);
    const [tempProbability, setTempProbability] = useState(100);
    const [tempCaseSensitive, setTempCaseSensitive] = useState(false);
    const [tempWholeWords, setTempWholeWords] = useState(false);
    const [tempScenes, setTempScenes] = useState<WorldbookScenes>(undefined);

    const catalog = useMemo(() => buildWorldbookCatalog(worldbooks), [worldbooks]);
    const categoryNames = useMemo(() => catalog.packages.map(pkg => pkg.category), [catalog.packages]);
    const outerGroupNames = catalog.groupNames;

    // 编辑页「已有世界书」建议列表：随输入实时过滤。
    // 不能用原生 datalist —— 候选一多，移动端 WebView 会把候选渲染成撑爆屏幕、无法滚动的巨型下拉。
    const filteredCategorySuggestions = useMemo(() => {
        const query = tempCategory.trim().toLowerCase();
        if (!query) return categoryNames;
        return categoryNames.filter(cat => cat.toLowerCase().includes(query));
    }, [categoryNames, tempCategory]);

    const handleCreate = () => {
        setEditingBook(null);
        setTempTitle('');
        setTempContent('');
        setTempCategory('');
        setTempEnabled(true);
        setTempConstant(true);
        setTempKeywords('');
        setTempSecondaryKeywords('');
        setTempSelectiveLogic(0);
        setTempPosition(1);
        setTempDepth(4);
        setTempRole(0);
        setTempOrder(100);
        setTempScanDepth(4);
        setTempUseProbability(false);
        setTempProbability(100);
        setTempCaseSensitive(false);
        setTempWholeWords(false);
        setTempScenes(undefined);
        setShowCategoryPicker(false);
        setIsEditing(true);
        trackEvent('打开世界书编辑页', { mode: 'create' });
    };

    const handleEdit = (book: Worldbook) => {
        setEditingBook(book);
        setTempTitle(book.title);
        setTempContent(book.content);
        setTempCategory(book.category || '');
        setTempEnabled(!book.disable);
        setTempConstant(book.constant ?? !(book.key && book.key.length > 0));
        setTempKeywords((book.key || []).join(', '));
        setTempSecondaryKeywords((book.keysecondary || []).join(', '));
        setTempSelectiveLogic(book.selectiveLogic ?? 0);
        setTempPosition(book.position ?? 1);
        setTempDepth(book.depth ?? 4);
        setTempRole(book.role ?? 0);
        setTempOrder(book.order ?? 100);
        setTempScanDepth(book.scanDepth ?? 4);
        setTempUseProbability(book.useProbability === true);
        setTempProbability(book.probability ?? 100);
        setTempCaseSensitive(book.caseSensitive === true);
        setTempWholeWords(book.matchWholeWords === true);
        setTempScenes(book.scenes);
        setShowCategoryPicker(false);
        setIsEditing(true);
        trackEvent('打开世界书编辑页', { mode: 'edit' });
    };

    const handleSave = async () => {
        if (!tempTitle.trim()) {
            addToast('请输入标题', 'error');
            return;
        }

        const category = tempCategory.trim() || WORLDBOOK_DEFAULT_CATEGORY;
        const primaryKeywords = splitWorldbookKeywords(tempKeywords);
        const secondaryKeywords = splitWorldbookKeywords(tempSecondaryKeywords);
        if (!tempConstant && primaryKeywords.length === 0) {
            addToast('关键词触发模式至少需要一个主要关键词', 'error');
            return;
        }
        const entryConfig = {
            disable: !tempEnabled,
            constant: tempConstant,
            key: primaryKeywords,
            keysecondary: secondaryKeywords,
            selective: secondaryKeywords.length > 0,
            selectiveLogic: tempSelectiveLogic,
            position: tempPosition,
            depth: Math.max(0, Math.floor(tempDepth || 0)),
            role: tempRole,
            order: Number.isFinite(tempOrder) ? tempOrder : 100,
            scanDepth: Math.max(0, Math.floor(tempScanDepth || 0)),
            useProbability: tempUseProbability,
            probability: Math.max(0, Math.min(100, tempProbability || 0)),
            caseSensitive: tempCaseSensitive,
            matchWholeWords: tempWholeWords,
            scenes: tempScenes,
        };
        const targetMeta = resolveWorldbookCategoryMeta(worldbooks, category);

        if (editingBook) {
            const movedBook = (editingBook.category || WORLDBOOK_DEFAULT_CATEGORY) !== category;
            await updateWorldbook(editingBook.id, {
                title: tempTitle,
                content: tempContent,
                category,
                ...entryConfig,
                ...(movedBook ? { group: targetMeta.group, bookDisabled: targetMeta.bookDisabled ?? false } : {}),
            });
            addToast('已保存 (同步至相关角色)', 'success');
        } else {
            const newBook: Worldbook = {
                id: `wb-${Date.now()}`,
                title: tempTitle,
                content: tempContent,
                category,
                ...targetMeta,
                ...entryConfig,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            addWorldbook(newBook);
            addToast('新词条已创建', 'success');
        }
        setIsEditing(false);
    };

    const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const source = await readShareFile(file, 'worldbook');
            const text = await source.text();
            const category = source.name.replace(/\.json$/i, '').trim() || '导入世界书';
            const targetMeta = resolveWorldbookCategoryMeta(worldbooks, category);
            const imported = parseStandardWorldbook(text, category).map(book => ({ ...book, ...targetMeta }));
            for (const book of imported) await addWorldbook(book);
            trackEvent('导入世界书文件');
            addToast(`已导入 ${imported.length} 条世界书词条`, 'success');
            setExpandedCategory(category);
        } catch (error: any) {
            addToast(error?.message || '世界书导入失败', 'error');
        } finally {
            if (importRef.current) importRef.current.value = '';
        }
    };

    const confirmImport = () => {
        setShowImportConfirm(false);
        importRef.current?.click();
    };

    const handleExportGroup = async (event: React.MouseEvent, category: string, books: Worldbook[]) => {
        event.stopPropagation();
        const json = serializeSullyWorldbook(books);
        // 导出前明文密钥体检 + 二次确认（世界书正常不含密钥 → 提示「安全，可分享」）。
        if (!(await confirmExportSafety(JSON.parse(json)))) return;
        const safeName = category.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim() || 'worldbook';
        // 原生 / WebView 壳里 `<a download>` 常常点了没反应，强制先拉起分享面板，兜底才走下载。
        const result = await shareOrDownloadFile({
            card: { kind: 'worldbook', title: category },
            content: json,
            fileName: `${safeName}.json`,
            mimeType: 'application/json;charset=utf-8',
            shareTitle: `导出世界书「${category}」`,
        });
        if (result === 'cancelled') return;
        const verb = result === 'shared' ? '已调起分享' : '已导出';
        addToast(`${verb}「${category}」共 ${books.length} 条`, 'success');
        trackEvent('导出分组为标准世界书', { 格式: '糯米机 v1' });
    };

    const requestDelete = (e: React.MouseEvent, book: Worldbook) => {
        e.stopPropagation();
        setEditingBook(book);
        setShowDeleteConfirm(true);
    };

    const confirmDelete = async () => {
        if (editingBook) {
            await deleteWorldbook(editingBook.id);
            setShowDeleteConfirm(false);
            setEditingBook(null);
            setIsEditing(false);
        }
    };

    const leaveSelectionMode = () => {
        setIsSelecting(false);
        setSelectedBookIds(new Set());
    };

    const toggleBookSelection = (id: string) => {
        setSelectedBookIds(current => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleSelectAll = () => {
        setSelectedBookIds(current => current.size === worldbooks.length
            ? new Set()
            : new Set(worldbooks.map(book => book.id)));
    };

    const closeBulkDelete = () => {
        if (deletingBooks) return;
        setShowBulkDeleteConfirm(false);
        if (!isSelecting) setSelectedBookIds(new Set());
    };

    const confirmBulkDelete = async () => {
        const ids = [...selectedBookIds];
        if (ids.length === 0) return;
        if (deletingBooks) return;
        setDeletingBooks(true);
        try {
            await deleteWorldbooks(ids);
        } catch (error: any) {
            addToast(error?.message || '删除失败，未更改世界书', 'error');
            return;
        } finally { setDeletingBooks(false); }
        setShowBulkDeleteConfirm(false);
        leaveSelectionMode();
        addToast(`已删除 ${ids.length} 条世界书词条`, 'success');
    };

    const saveGroup = async () => {
        if (!groupEditor || savingGroup) return;
        const name = groupEditor.name.trim();
        if (!name) { addToast('请填写世界书名称', 'error'); return; }
        if (name !== groupEditor.category && categoryNames.includes(name)) {
            addToast('已有同名世界书，请换一个名称，避免意外合并', 'error'); return;
        }
        const pkg = catalog.packages.find(item => item.category === groupEditor.category);
        const books = pkg?.books || [];
        if (groupEditor.mode === 'keyword' && books.some(book => !book.key?.length)) {
            addToast('有词条尚未设置主要关键词，请先补齐；本次未修改', 'error'); return;
        }
        const nextOuterGroup = normalizeWorldbookGroup(groupEditor.outerGroup);
        setSavingGroup(true);
        try {
            await updateWorldbooks(books.map(book => book.id), {
                category: name,
                group: nextOuterGroup,
                ...(groupEditor.mode === 'keep' ? {} : { constant: groupEditor.mode === 'constant' }),
                ...(groupEditor.scenesMode === 'keep' ? {} : { scenes: groupEditor.scenes }),
            });
            setExpandedCategory(name);
            setGroupEditor(null);
            addToast('整本世界书已保存，原有角色挂载保持不变', 'success');
        } catch (error: any) { addToast(error?.message || '保存失败', 'error'); }
        finally { setSavingGroup(false); }
    };

    const openCreateFolderModal = () => {
        setFolderEditor({
            mode: 'create',
            name: '',
            selectedCategories: new Set(),
        });
    };

    const openEditFolderModal = (groupName: string) => {
        const selected = new Set(
            catalog.packages.filter(pkg => pkg.group === groupName).map(pkg => pkg.category),
        );
        setFolderEditor({
            mode: 'edit',
            previousName: groupName,
            name: groupName,
            selectedCategories: selected,
        });
    };

    const toggleFolderCategory = (category: string) => {
        setFolderEditor(current => {
            if (!current) return null;
            const next = new Set(current.selectedCategories);
            if (next.has(category)) next.delete(category);
            else next.add(category);
            return { ...current, selectedCategories: next };
        });
    };

    const saveFolder = async () => {
        if (!folderEditor || savingFolder) return;
        const name = folderEditor.name.trim();
        if (!name) {
            addToast('请填写分组名称', 'error');
            return;
        }
        if ((folderEditor.mode === 'create' || name !== folderEditor.previousName) && outerGroupNames.includes(name)) {
            addToast('已有同名分组，请换一个名称', 'error');
            return;
        }
        if (folderEditor.selectedCategories.size === 0) {
            addToast('请至少勾选一本世界书归入该分组', 'error');
            return;
        }
        const changes = computeWorldbookGroupMembershipChanges(
            catalog.packages,
            name,
            folderEditor.selectedCategories,
            folderEditor.previousName,
        );
        setSavingFolder(true);
        try {
            for (const change of changes) {
                await updateWorldbooks(change.ids, { group: change.group });
            }
            trackEvent('保存世界书分组', { 动作: folderEditor.mode === 'create' ? '新建' : '编辑' });
            setFolderEditor(null);
            addToast(`已保存分组「${name}」`, 'success');
        } catch (error: any) {
            addToast(error?.message || '分组保存失败', 'error');
        } finally {
            setSavingFolder(false);
        }
    };

    const handleDissolveGroup = async (event: React.MouseEvent, groupName: string, packageCount: number) => {
        event.stopPropagation();
        const ok = await requestConfirm({
            title: `解散分组「${groupName}」？`,
            message: `组内的 ${packageCount} 本世界书将退回「未分组」，世界书内容、开关状态和角色挂载都会保留。`,
            confirmText: '确认解散',
            variant: 'warning',
        });
        if (!ok) return;
        const changes = computeWorldbookGroupMembershipChanges(catalog.packages, '', [], groupName);
        setSavingFolder(true);
        try {
            for (const change of changes) {
                await updateWorldbooks(change.ids, { group: change.group });
            }
            if (folderEditor?.previousName === groupName) setFolderEditor(null);
            trackEvent('保存世界书分组', { 动作: '解散' });
            addToast(`已解散分组「${groupName}」`, 'success');
        } catch (error: any) {
            addToast(error?.message || '解散分组失败', 'error');
        } finally {
            setSavingFolder(false);
        }
    };

    const handleToggleOuterGroup = async (
        event: React.MouseEvent,
        packages: WorldbookPackage<Worldbook>[],
        currentlyAnyEnabled: boolean,
    ) => {
        event.stopPropagation();
        if (togglingBusy) return;
        const ids = packages.flatMap(pkg => pkg.books.map(book => book.id));
        if (ids.length === 0) return;
        const nextBookDisabled = currentlyAnyEnabled;
        setTogglingBusy(true);
        try {
            await updateWorldbooks(ids, { bookDisabled: nextBookDisabled });
            trackEvent('切换世界书启用状态', { 范围: '分组', 状态: nextBookDisabled ? '关' : '开' });
        } catch (error: any) {
            addToast(error?.message || '切换分组状态失败', 'error');
        } finally {
            setTogglingBusy(false);
        }
    };

    const handleTogglePackage = async (event: React.MouseEvent, pkg: WorldbookPackage<Worldbook>) => {
        event.stopPropagation();
        if (togglingBusy) return;
        const ids = pkg.books.map(book => book.id);
        if (ids.length === 0) return;
        const nextBookDisabled = !pkg.bookDisabled;
        setTogglingBusy(true);
        try {
            await updateWorldbooks(ids, { bookDisabled: nextBookDisabled });
            trackEvent('切换世界书启用状态', { 范围: '整本', 状态: nextBookDisabled ? '关' : '开' });
        } catch (error: any) {
            addToast(error?.message || '切换世界书状态失败', 'error');
        } finally {
            setTogglingBusy(false);
        }
    };

    const handleToggleEntry = async (event: React.MouseEvent, book: Worldbook) => {
        event.stopPropagation();
        if (togglingBusy) return;
        const nextDisable = !book.disable;
        setTogglingBusy(true);
        try {
            await updateWorldbook(book.id, { disable: nextDisable });
            trackEvent('切换世界书启用状态', { 范围: '单条', 状态: nextDisable ? '关' : '开' });
        } catch (error: any) {
            addToast(error?.message || '切换词条状态失败', 'error');
        } finally {
            setTogglingBusy(false);
        }
    };

    const toggleOuterGroupCollapse = (sectionKey: string) => {
        setCollapsedOuterGroups(prev => {
            const next = new Set(prev);
            if (next.has(sectionKey)) next.delete(sectionKey);
            else next.add(sectionKey);
            return next;
        });
    };

    const toggleCategory = (cat: string) => {
        setExpandedCategory(expandedCategory === cat ? null : cat);
    };

    const setCategoryPage = (cat: string, page: number) => {
        setCategoryPages(prev => ({ ...prev, [cat]: page }));
    };

    const togglePreview = (id: string) => {
        setPreviewBookId(previewBookId === id ? null : id);
    };

    const renderWorldbookPackage = (pkg: WorldbookPackage<Worldbook>) => {
        const { category, books, bookDisabled } = pkg;
        const totalPages = Math.max(1, Math.ceil(books.length / PAGE_SIZE));
        const currentPage = Math.min(categoryPages[category] || 1, totalPages);
        const pagedBooks = books.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
        const isExpanded = expandedCategory === category;

        return (
            <div key={category} className={`animate-slide-up rounded-2xl border p-3 transition-colors ${bookDisabled ? 'bg-white/40 border-slate-200/60' : 'bg-white/75 border-white/80 shadow-sm'}`}>
                {/* Worldbook Header */}
                <div
                    onClick={() => toggleCategory(category)}
                    className="flex items-center gap-2 py-1 px-1 cursor-pointer select-none group"
                >
                    <div className={`transition-transform duration-300 ${isExpanded ? 'rotate-90' : ''}`}>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-slate-400 group-hover:text-indigo-500"><path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" /></svg>
                    </div>
                    <h3 className={`min-w-0 flex-1 break-words text-xs font-bold tracking-wider transition-colors ${bookDisabled ? 'text-slate-400' : 'text-slate-700 group-hover:text-indigo-600'}`}>{category}</h3>
                    {bookDisabled && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-200/80 text-slate-500 font-bold shrink-0">已停用</span>
                    )}
                    <span className="text-[9px] bg-slate-100/80 px-1.5 py-0.5 rounded text-slate-400 shrink-0">{books.length} 条</span>
                    <button
                        type="button"
                        onClick={(event) => handleExportGroup(event, category, books)}
                        className="p-1.5 -my-1 rounded-full text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 active:scale-90 transition-all shrink-0"
                        title="导出该本世界书"
                    >
                        <DownloadSimple size={15} weight="bold" />
                    </button>
                    {!isSelecting && (
                        <SwitchButton
                            size="sm"
                            checked={!bookDisabled}
                            disabled={togglingBusy}
                            label={`启用世界书 ${category}`}
                            onClick={(event) => void handleTogglePackage(event, pkg)}
                        />
                    )}
                </div>

                {!isSelecting && (
                    <div className="flex justify-end gap-3 px-2 pt-1">
                        <button
                            type="button"
                            className="text-[11px] text-indigo-500 py-0.5"
                            onClick={() => setGroupEditor({
                                category,
                                name: category,
                                outerGroup: pkg.group || '',
                                mode: 'keep',
                                scenesMode: 'keep',
                                scenes: undefined,
                            })}
                        >
                            编辑整本
                        </button>
                        <button
                            type="button"
                            className="text-[11px] text-slate-400 py-0.5"
                            onClick={() => {
                                setSelectedBookIds(new Set(books.map(book => book.id)));
                                setShowBulkDeleteConfirm(true);
                            }}
                        >
                            删除整本
                        </button>
                    </div>
                )}

                {/* Entries inside this Worldbook */}
                <div className={`space-y-2.5 pl-1 transition-all duration-300 ${isExpanded ? 'opacity-100 mt-2.5' : 'max-h-0 opacity-0 overflow-hidden'}`}>
                    {pagedBooks.map(book => (
                        <div key={book.id} className={`backdrop-blur-md rounded-2xl border shadow-sm transition-all group relative overflow-hidden ${book.disable || bookDisabled ? 'bg-slate-50/70 border-slate-200/60' : 'bg-white/85 border-slate-100 hover:shadow-md'}`}>
                            <div
                                onClick={() => isSelecting ? toggleBookSelection(book.id) : togglePreview(book.id)}
                                className="p-3.5 cursor-pointer flex justify-between items-start gap-2"
                            >
                                {isSelecting && (
                                    <span className={`w-5 h-5 mt-0.5 mr-1 shrink-0 rounded-md border flex items-center justify-center transition-colors ${selectedBookIds.has(book.id) ? 'bg-indigo-500 border-indigo-500 text-white' : 'bg-white border-slate-300 text-transparent'}`}>
                                        <Check size={13} weight="bold" />
                                    </span>
                                )}
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 mb-1">
                                        <div className={`w-1.5 h-1.5 rounded-full ${previewBookId === book.id ? 'bg-indigo-400' : 'bg-slate-300'}`} />
                                        <h4 className={`text-sm font-bold truncate transition-colors ${book.disable || bookDisabled ? 'text-slate-400' : previewBookId === book.id ? 'text-indigo-700' : 'text-slate-700'}`}>{book.title}</h4>
                                    </div>
                                    <div className="text-[10px] text-slate-400 font-mono pl-3.5">
                                        Updated: {new Date(book.updatedAt).toLocaleDateString()}
                                    </div>
                                    <div className="flex flex-wrap gap-1.5 mt-2 pl-3.5">
                                        <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold ${book.disable ? 'bg-slate-200 text-slate-500' : bookDisabled ? 'bg-amber-50 text-amber-600' : 'bg-indigo-50 text-indigo-500'}`}>
                                            {book.disable ? '词条停用' : bookDisabled ? '整本已停用' : (book.constant ?? !(book.key && book.key.length > 0)) ? '常驻' : '关键词'}
                                        </span>
                                        <span className="text-[9px] px-2 py-0.5 rounded-full bg-slate-100/80 text-slate-400">
                                            {WORLDBOOK_POSITION_LABELS[book.position ?? 1]}
                                        </span>
                                        {(() => {
                                            const sceneKind = summarizeWorldbookScenes(book.scenes).kind;
                                            if (sceneKind === 'all') return null;
                                            return sceneKind === 'none'
                                                ? <span className="text-[9px] px-2 py-0.5 rounded-full font-bold bg-amber-50 text-amber-600">未启用场景</span>
                                                : <span className="text-[9px] px-2 py-0.5 rounded-full bg-slate-100/80 text-slate-400">限定场景</span>;
                                        })()}
                                    </div>
                                </div>

                                {!isSelecting && (
                                    <div className="flex items-center gap-1.5 shrink-0">
                                        <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); handleEdit(book); }}
                                            className="p-1.5 rounded-full hover:bg-slate-100 text-slate-400 hover:text-indigo-600 transition-colors"
                                            title="编辑"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" /></svg>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={(e) => requestDelete(e, book)}
                                            className="p-1.5 rounded-full hover:bg-red-50 text-slate-300 hover:text-red-500 transition-colors"
                                            title="删除"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-4 h-4"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                                        </button>
                                        <SwitchButton
                                            size="sm"
                                            checked={!book.disable}
                                            disabled={togglingBusy}
                                            label={`启用词条 ${book.title}`}
                                            onClick={(e) => void handleToggleEntry(e, book)}
                                        />
                                    </div>
                                )}
                            </div>

                            {previewBookId === book.id && (
                                <div className="px-4 pb-4 pt-0 animate-fade-in">
                                    <div className="h-px w-full bg-gradient-to-r from-transparent via-slate-200 to-transparent mb-3" />
                                    <p className="text-xs text-slate-600 leading-relaxed whitespace-pre-wrap font-light select-text">
                                        {book.content || <span className="italic text-slate-400">暂无内容...</span>}
                                    </p>
                                </div>
                            )}
                        </div>
                    ))}

                    {totalPages > 1 && (
                        <div className="flex items-center justify-center gap-2 pt-1 pb-1 select-none">
                            <button
                                type="button"
                                onClick={() => setCategoryPage(category, currentPage - 1)}
                                disabled={currentPage <= 1}
                                className="px-3 py-1.5 rounded-full text-xs font-bold bg-white/80 border border-slate-200/70 text-slate-500 shadow-sm active:scale-95 transition-transform disabled:opacity-40 disabled:active:scale-100"
                            >
                                上一页
                            </button>
                            <span className="text-[11px] font-mono text-slate-400 min-w-[3rem] text-center">{currentPage} / {totalPages}</span>
                            <button
                                type="button"
                                onClick={() => setCategoryPage(category, currentPage + 1)}
                                disabled={currentPage >= totalPages}
                                className="px-3 py-1.5 rounded-full text-xs font-bold bg-white/80 border border-slate-200/70 text-slate-500 shadow-sm active:scale-95 transition-transform disabled:opacity-40 disabled:active:scale-100"
                            >
                                下一页
                            </button>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    // EDIT MODAL (Full Screen Overlay Style)
    if (isEditing) {
        return (
            <div className="h-full w-full bg-[#f5f6fa] flex flex-col font-sans animate-fade-in">
                <div className="bg-white/90 backdrop-blur-xl border-b border-slate-200/70 shrink-0 z-20" style={{ paddingTop: 'var(--safe-top)' }}>
                    <div className="h-16 max-w-2xl mx-auto w-full flex items-center justify-between px-5">
                        <button onClick={() => setIsEditing(false)} className="px-3 py-2 -ml-3 rounded-xl text-slate-500 font-semibold text-sm hover:bg-slate-100 active:scale-95 transition-all">取消</button>
                        <div className="text-center">
                            <div className="text-[10px] font-bold tracking-[0.16em] text-indigo-400 uppercase">Worldbook</div>
                            <div className="text-sm font-bold text-slate-800 mt-0.5">{editingBook ? '编辑词条' : '新建词条'}</div>
                        </div>
                        <button onClick={handleSave} className="px-4 py-2 -mr-1 bg-indigo-500 text-white rounded-xl text-xs font-bold shadow-sm shadow-indigo-200 active:scale-95 transition-all hover:bg-indigo-600">保存</button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto">
                    <div className="w-full max-w-2xl mx-auto px-5 py-5 pb-10 space-y-4">
                        <div className="bg-white rounded-[1.5rem] border border-slate-200/70 p-5 shadow-sm shadow-slate-200/40 space-y-4">
                            <div>
                                <div className="text-[11px] font-bold tracking-[0.14em] text-indigo-500 uppercase">基础信息</div>
                                <p className="text-[10px] text-slate-400 mt-1">用于识别、整理和挂载这条世界书词条。</p>
                            </div>
                            <div>
                                <label className="text-xs font-bold text-slate-500 mb-2 block">标题</label>
                                <input
                                    value={tempTitle}
                                    onChange={e => setTempTitle(e.target.value)}
                                    placeholder="例如: 魔法体系、公司背景..."
                                    className="w-full text-base font-bold text-slate-800 bg-slate-50/80 border border-slate-200 rounded-xl px-4 py-3 outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all"
                                />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-slate-500 mb-2 block">所属世界书</label>
                                <input
                                    value={tempCategory}
                                    onChange={e => setTempCategory(e.target.value)}
                                    placeholder="例如: 赛博世界观、人物设定..."
                                    className="w-full text-sm text-slate-700 bg-slate-50/80 border border-slate-200 rounded-xl px-4 py-3 outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all"
                                />
                                {categoryNames.length > 0 && (
                                    <div className="mt-2">
                                        <button
                                            type="button"
                                            onClick={() => setShowCategoryPicker(v => !v)}
                                            className="flex items-center gap-1.5 text-[11px] font-bold text-indigo-500 px-1 py-1 active:scale-95 transition-transform"
                                        >
                                            <span className={`transition-transform duration-200 inline-block ${showCategoryPicker ? 'rotate-90' : ''}`}>
                                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3"><path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" /></svg>
                                            </span>
                                            选择已有世界书 ({categoryNames.length})
                                        </button>
                                        {showCategoryPicker && (
                                            <div className="mt-1.5 max-h-36 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50/60 p-2 flex flex-wrap gap-1.5 overscroll-contain">
                                                {filteredCategorySuggestions.length === 0 ? (
                                                    <span className="text-[10px] text-slate-400 px-1 py-0.5">没有匹配「{tempCategory.trim()}」的世界书，保存后将新建。</span>
                                                ) : (
                                                    filteredCategorySuggestions.map(cat => (
                                                        <button
                                                            key={cat}
                                                            type="button"
                                                            onClick={() => { setTempCategory(cat); setShowCategoryPicker(false); }}
                                                            className={`max-w-full truncate text-[11px] px-2.5 py-1 rounded-full border transition-colors active:scale-95 ${tempCategory.trim() === cat ? 'bg-indigo-500 text-white border-indigo-500' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'}`}
                                                        >
                                                            {cat}
                                                        </button>
                                                    ))
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                                <p className="text-[10px] text-slate-400 mt-1.5 px-1">填相同书名的词条会归进同一本世界书；输入文字可过滤上方候选。</p>
                            </div>
                        </div>

                        <div className="bg-white rounded-[1.5rem] border border-slate-200/70 p-5 shadow-sm shadow-slate-200/40 space-y-5">
                            <div className="flex items-center justify-between gap-4">
                                <div>
                                    <div className="text-xs font-bold text-slate-700">启用词条</div>
                                    <p className="text-[10px] text-slate-400 mt-1">关闭后保留内容，但不会注入提示词。</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setTempEnabled(value => !value)}
                                    className={`relative inline-flex w-12 h-7 shrink-0 items-center rounded-full p-1 transition-colors duration-200 focus:outline-none focus:ring-4 focus:ring-indigo-100 ${tempEnabled ? 'bg-indigo-500' : 'bg-slate-200'}`}
                                    aria-pressed={tempEnabled}
                                >
                                    <span className={`block w-5 h-5 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-transform duration-200 ${tempEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                </button>
                            </div>

                            <div className="border-t border-slate-100 pt-4">
                                <WorldbookSceneEditor value={tempScenes} onChange={setTempScenes} />
                            </div>

                            <div className="border-t border-slate-100 pt-4">
                                <label className="text-[11px] font-bold text-slate-400 uppercase mb-2 block tracking-[0.12em]">触发方式</label>
                                <label className="flex items-center gap-3 py-2 cursor-pointer select-none">
                                    <input
                                        type="checkbox"
                                        checked={!tempConstant}
                                        onChange={e => setTempConstant(!e.target.checked)}
                                        className="w-4 h-4 accent-indigo-500"
                                    />
                                    <span><span className="block text-sm font-semibold text-slate-700">启用关键词触发</span>
                                    <span className="block mt-1 text-[10px] text-slate-400">关闭后改为常驻，已填关键词会保留。</span></span>
                                </label>
                                <p className={`text-[10px] leading-relaxed mt-1 pl-7 ${tempConstant ? 'text-slate-400' : 'text-indigo-500'}`}>
                                    {tempConstant
                                        ? '未勾选：不检查关键词，这条词条会始终生效。'
                                        : '已勾选：只有主要关键词命中时才生效；未填写关键词将无法保存。'}
                                </p>
                            </div>

                            {!tempConstant && (
                                <div className="space-y-4 animate-fade-in">
                                    <div>
                                        <label className="text-xs font-bold text-slate-400 mb-2 block">主要关键词</label>
                                        <input
                                            value={tempKeywords}
                                            onChange={e => setTempKeywords(e.target.value)}
                                            placeholder="多个关键词用逗号或换行分隔"
                                            className="w-full text-sm text-slate-700 bg-slate-50/80 border border-slate-200 rounded-xl px-4 py-3 outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-slate-400 mb-2 block">辅助关键词（可选）</label>
                                        <input
                                            value={tempSecondaryKeywords}
                                            onChange={e => setTempSecondaryKeywords(e.target.value)}
                                            placeholder="用于进一步限制触发条件"
                                            className="w-full text-sm text-slate-700 bg-slate-50/80 border border-slate-200 rounded-xl px-4 py-3 outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all"
                                        />
                                    </div>
                                    {splitWorldbookKeywords(tempSecondaryKeywords).length > 0 && (
                                        <div>
                                            <label className="text-xs font-bold text-slate-400 mb-2 block">辅助关键词条件</label>
                                            <select
                                                value={tempSelectiveLogic}
                                                onChange={e => setTempSelectiveLogic(Number(e.target.value) as WorldbookSelectiveLogic)}
                                                className="w-full text-sm text-slate-700 bg-slate-50/80 border border-slate-200 rounded-xl px-4 py-3 outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all"
                                            >
                                                <option value={0}>至少匹配一个</option>
                                                <option value={3}>全部匹配</option>
                                                <option value={2}>全部不能匹配</option>
                                                <option value={1}>不能全部匹配</option>
                                            </select>
                                        </div>
                                    )}
                                    <div className="grid grid-cols-2 gap-3">
                                        <label className="flex items-center gap-2 text-xs text-slate-600">
                                            <input type="checkbox" checked={tempCaseSensitive} onChange={e => setTempCaseSensitive(e.target.checked)} className="accent-indigo-500" />
                                            区分大小写
                                        </label>
                                        <label className="flex items-center gap-2 text-xs text-slate-600">
                                            <input type="checkbox" checked={tempWholeWords} onChange={e => setTempWholeWords(e.target.checked)} className="accent-indigo-500" />
                                            完整词匹配
                                        </label>
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-slate-400 mb-2 block">扫描最近消息数</label>
                                        <input
                                            type="number"
                                            min={0}
                                            value={tempScanDepth}
                                            onChange={e => setTempScanDepth(Number(e.target.value))}
                                            className="w-full text-sm text-slate-700 bg-slate-50/80 border border-slate-200 rounded-xl px-4 py-3 outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all"
                                        />
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="bg-white rounded-[1.5rem] border border-slate-200/70 p-5 shadow-sm shadow-slate-200/40 space-y-4">
                            <div>
                                <div className="text-[11px] font-bold tracking-[0.14em] text-indigo-500 uppercase">注入设置</div>
                                <p className="text-[10px] text-slate-400 mt-1">控制词条在提示词中的位置和优先级。</p>
                            </div>
                            <div>
                                <label className="text-xs font-bold text-slate-500 mb-2 block">注入位置</label>
                                <select
                                    value={tempPosition}
                                    onChange={e => {
                                        const nextPosition = Number(e.target.value) as WorldbookPosition;
                                        setTempPosition(nextPosition);
                                        trackEvent('切换世界书注入位置', { position: nextPosition });
                                    }}
                                    className="w-full text-sm text-slate-700 bg-slate-50/80 border border-slate-200 rounded-xl px-4 py-3 outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all"
                                >
                                    {(Object.entries(WORLDBOOK_POSITION_LABELS) as [string, string][]).map(([value, label]) => (
                                        <option key={value} value={value}>
                                            {label}{value === '1' ? '（默认 · 旧版位置）' : ''}
                                        </option>
                                    ))}
                                </select>
                                <p className="text-[10px] leading-relaxed text-slate-400 mt-2 px-1">
                                    {WORLDBOOK_POSITION_DESCRIPTIONS[tempPosition]}
                                </p>
                            </div>

                            {tempPosition === 4 && (
                                <div className="grid grid-cols-2 gap-3 animate-fade-in">
                                    <div>
                                        <label className="text-xs font-bold text-slate-400 mb-2 block">消息深度</label>
                                        <input
                                            type="number"
                                            min={0}
                                            value={tempDepth}
                                            onChange={e => setTempDepth(Number(e.target.value))}
                                            className="w-full text-sm text-slate-700 bg-slate-50/80 border border-slate-200 rounded-xl px-4 py-3 outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all"
                                        />
                                        <p className="text-[10px] text-slate-400 mt-1 px-1">0 最靠近最新消息，数字越大越往前。</p>
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-slate-400 mb-2 block">消息角色</label>
                                        <select
                                            value={tempRole}
                                            onChange={e => setTempRole(Number(e.target.value) as WorldbookDepthRole)}
                                            className="w-full text-sm text-slate-700 bg-slate-50/80 border border-slate-200 rounded-xl px-4 py-3 outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all"
                                        >
                                            {(Object.entries(WORLDBOOK_ROLE_LABELS) as [string, string][]).map(([value, label]) => (
                                                <option key={value} value={value}>{label}</option>
                                            ))}
                                        </select>
                                    </div>
                                </div>
                            )}

                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="text-xs font-bold text-slate-400 mb-2 block">插入顺序</label>
                                    <input
                                        type="number"
                                        value={tempOrder}
                                        onChange={e => setTempOrder(Number(e.target.value))}
                                        className="w-full text-sm text-slate-700 bg-slate-50/80 border border-slate-200 rounded-xl px-4 py-3 outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all"
                                    />
                                </div>
                                <div>
                                    <label className="flex items-center gap-2 text-xs font-bold text-slate-400 mb-2">
                                        <input type="checkbox" checked={tempUseProbability} onChange={e => setTempUseProbability(e.target.checked)} className="accent-indigo-500" />
                                        启用随机概率
                                    </label>
                                    <input
                                        type="number"
                                        min={0}
                                        max={100}
                                        disabled={!tempUseProbability}
                                        value={tempProbability}
                                        onChange={e => setTempProbability(Number(e.target.value))}
                                        className="w-full text-sm text-slate-700 bg-slate-50/80 border border-slate-200 rounded-xl px-4 py-3 outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all disabled:opacity-40"
                                    />
                                </div>
                            </div>
                            <div className="rounded-xl border border-indigo-100 bg-indigo-50/70 px-4 py-3 text-[10px] leading-relaxed text-indigo-700">
                                <span className="font-bold">未勾选“启用随机概率”不代表词条没有激活。</span>
                                未勾选时会跳过随机判定：只要词条与所属世界书已启用且满足常驻／关键词条件，就会按 100% 通过；勾选后，才会在条件满足时按上方百分比再次随机判断。
                            </div>
                        </div>

                        <div className="bg-white rounded-[1.5rem] border border-slate-200/70 p-5 shadow-sm shadow-slate-200/40">
                            <div className="text-[11px] font-bold tracking-[0.14em] text-indigo-500 uppercase">设定内容</div>
                            <p className="text-[10px] text-slate-400 mt-1 mb-3">支持 Markdown；这里只填写实际需要注入模型的内容。</p>
                            <textarea
                                value={tempContent}
                                onChange={e => setTempContent(e.target.value)}
                                placeholder="在此输入详细的设定内容，支持 Markdown 格式..."
                                className="w-full h-80 bg-slate-50/80 border border-slate-200 rounded-2xl p-4 text-sm text-slate-700 leading-relaxed resize-none outline-none focus:bg-white focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50 transition-all font-mono"
                            />
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // LIST VIEW
    return (
        <div className="h-full w-full relative overflow-hidden font-sans bg-slate-100 flex flex-col">
            {confirmDialog}

            {/* Background Atmosphere */}
            <div className="absolute inset-0 bg-gradient-to-br from-indigo-50 via-slate-100 to-violet-50 pointer-events-none" />
            <div className="absolute -top-20 -right-20 w-64 h-64 bg-indigo-200/20 rounded-full blur-3xl pointer-events-none" />
            <div className="absolute bottom-0 left-0 w-full h-32 bg-gradient-to-t from-white/80 to-transparent pointer-events-none z-10" />

            {/* Header */}
            <div className="bg-white/70 backdrop-blur-xl border-b border-white/40 shrink-0 sticky top-0 z-20 shadow-sm" style={{ paddingTop: 'var(--safe-top)' }}>
                <div className="flex items-center px-5 py-3">
                    <div className="flex justify-between items-center w-full gap-2">
                        <button onClick={closeApp} className="p-2 -ml-2 rounded-full hover:bg-black/5 active:scale-90 transition-transform shrink-0">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6 text-slate-600"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
                        </button>
                        <span className="font-bold text-slate-700 text-lg tracking-wide flex items-center gap-2 shrink-0">
                            <DiamondsFour size={18} className="text-indigo-500" /> 世界书
                        </span>
                        <div className="flex items-center gap-1.5">
                            {worldbooks.length > 0 && !isSelecting && (
                                <button
                                    type="button"
                                    onClick={openCreateFolderModal}
                                    className="h-9 px-3 rounded-full border bg-white/80 text-indigo-600 border-white text-xs font-bold shadow-sm flex items-center gap-1 active:scale-90 transition-all"
                                    title="新建分组归类多本世界书"
                                >
                                    分组
                                </button>
                            )}
                            {worldbooks.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (isSelecting) { leaveSelectionMode(); return; }
                                        setSelectedBookIds(new Set());
                                        setIsSelecting(true);
                                        trackEvent('进入批量管理模式');
                                    }}
                                    className={`h-9 px-3 rounded-full border text-xs font-bold shadow-sm flex items-center gap-1.5 active:scale-90 transition-all ${isSelecting ? 'bg-slate-100 text-slate-600 border-slate-200' : 'bg-white/80 text-indigo-500 border-white'}`}
                                    title={isSelecting ? '退出批量管理' : '批量管理世界书'}
                                >
                                    {isSelecting ? <X size={15} weight="bold" /> : <Check size={15} weight="bold" />}
                                    {isSelecting ? '取消' : '管理'}
                                </button>
                            )}
                            <input ref={importRef} type="file" accept=".json,.png,application/json,image/png" className="hidden" onChange={handleImport} />
                            <button
                                type="button"
                                onClick={() => { setShowImportConfirm(true); trackEvent('打开导入世界书弹窗'); }}
                                className="w-9 h-9 bg-white/80 text-indigo-500 border border-white rounded-full shadow-sm flex items-center justify-center active:scale-90 transition-transform"
                                title="导入糯米机、旧版或酒馆世界书"
                            >
                                <UploadSimple size={18} weight="bold" />
                            </button>
                            <button
                                type="button"
                                onClick={handleCreate}
                                className="w-9 h-9 bg-indigo-500 text-white rounded-full shadow-lg shadow-indigo-200 flex items-center justify-center active:scale-90 transition-transform hover:bg-indigo-600"
                                title="新建词条"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {isSelecting && (
                <div className="relative z-10 shrink-0 bg-white/90 backdrop-blur-xl border-b border-indigo-100 px-5 py-2.5 flex items-center gap-3 shadow-sm">
                    <button
                        type="button"
                        onClick={toggleSelectAll}
                        className="flex items-center gap-2 text-xs font-bold text-indigo-600 active:scale-95 transition-transform"
                    >
                        <span className={`w-5 h-5 rounded-md border flex items-center justify-center ${selectedBookIds.size === worldbooks.length ? 'bg-indigo-500 border-indigo-500 text-white' : 'bg-white border-slate-300 text-transparent'}`}>
                            <Check size={13} weight="bold" />
                        </span>
                        {selectedBookIds.size === worldbooks.length ? '取消全选' : '全选'}
                    </button>
                    <span className="text-[11px] text-slate-400">已选 {selectedBookIds.size} / {worldbooks.length}</span>
                    <button
                        type="button"
                        onClick={() => setShowBulkDeleteConfirm(true)}
                        disabled={selectedBookIds.size === 0}
                        className="ml-auto px-3 py-1.5 rounded-full bg-red-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm shadow-red-200 active:scale-95 transition-all disabled:opacity-40 disabled:shadow-none"
                    >
                        <Trash size={14} weight="bold" /> 删除
                    </button>
                </div>
            )}

            {/* Content List */}
            <div className="flex-1 overflow-y-auto p-5 pb-24 space-y-4 no-scrollbar relative z-0">
                <div className="rounded-2xl border border-indigo-100/80 bg-white/75 backdrop-blur-md p-4 shadow-sm text-slate-600">
                    <div className="flex items-center gap-2 text-xs font-bold text-indigo-600">
                        <BookOpen size={16} weight="bold" /> 世界书是做什么的？
                    </div>
                    <p className="mt-2 text-[11px] leading-relaxed">
                        世界书是一组按条件提供给 AI 的补充设定，可用于世界观、人物关系、地点和规则等内容。它不会自己发消息，也不等同于角色记忆。
                    </p>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                        可点击顶部「分组」将多本世界书归入同一组一键全开或全关，也可在组内单独开关某一本。创建或导入后需在角色编辑页“扩展设定”中挂载才对该角色生效。
                    </p>
                    <p className="mt-2 rounded-xl bg-indigo-50 px-3 py-2 text-[10px] leading-relaxed text-indigo-700">
                        注意：“启用随机概率”未点亮 = 不使用随机抽取，条件满足时按 100% 通过；并不是“未激活”。
                    </p>
                </div>

                {catalog.packages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-64 text-slate-400 gap-4 opacity-60">
                        <BookOpen size={48} className="text-slate-400" />
                        <span className="text-xs font-medium">世界还是空白的...</span>
                    </div>
                )}

                {catalog.packages.length > 0 && !catalog.hasNamedGroups && (
                    <div className="space-y-3">
                        {catalog.packages.map(pkg => renderWorldbookPackage(pkg))}
                    </div>
                )}

                {catalog.packages.length > 0 && catalog.hasNamedGroups && (
                    <div className="space-y-4">
                        {catalog.groups.map(section => {
                            const isGroupCollapsed = collapsedOuterGroups.has(section.key);
                            return (
                                <section
                                    key={section.key}
                                    data-worldbook-outer-group={section.name}
                                    className="rounded-[1.4rem] border border-indigo-100/90 bg-white/55 backdrop-blur-md p-3.5 shadow-sm space-y-3"
                                >
                                    <div
                                        onClick={() => toggleOuterGroupCollapse(section.key)}
                                        className="flex items-center gap-2 px-1 cursor-pointer select-none"
                                    >
                                        <span className={`transition-transform duration-200 text-indigo-400 ${isGroupCollapsed ? '' : 'rotate-90'}`}>
                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4"><path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" /></svg>
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <h2 className="text-sm font-bold text-slate-800 break-words">{section.name}</h2>
                                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 font-semibold">
                                                    {section.enabledPackageCount}/{section.packages.length} 本启用
                                                </span>
                                            </div>
                                        </div>
                                        {!isSelecting && !section.isUngrouped && (
                                            <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                                                <button
                                                    type="button"
                                                    onClick={() => openEditFolderModal(section.name)}
                                                    className="text-[11px] font-semibold text-indigo-500 hover:text-indigo-700 px-1.5 py-1"
                                                >
                                                    编辑分组
                                                </button>
                                                <button
                                                    type="button"
                                                    data-dissolve-group={section.name}
                                                    onClick={(e) => void handleDissolveGroup(e, section.name, section.packages.length)}
                                                    className="text-[11px] text-slate-400 hover:text-slate-600 px-1 py-1"
                                                >
                                                    解散
                                                </button>
                                                <SwitchButton
                                                    checked={section.anyEnabled}
                                                    disabled={togglingBusy}
                                                    label={`启用分组 ${section.name}`}
                                                    onClick={(e) => void handleToggleOuterGroup(e, section.packages, section.anyEnabled)}
                                                />
                                            </div>
                                        )}
                                    </div>

                                    {!isGroupCollapsed && (
                                        <div className="space-y-3 pt-0.5">
                                            {section.packages.map(pkg => renderWorldbookPackage(pkg))}
                                        </div>
                                    )}
                                </section>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Import Notice Modal */}
            <Modal
                isOpen={showImportConfirm}
                title="导入世界书"
                onClose={() => setShowImportConfirm(false)}
                footer={
                    <div className="flex gap-3 w-full">
                        <button
                            type="button"
                            onClick={() => setShowImportConfirm(false)}
                            className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform"
                        >
                            取消
                        </button>
                        <button
                            type="button"
                            onClick={confirmImport}
                            className="flex-1 py-3 bg-indigo-500 text-white font-bold rounded-2xl shadow-lg shadow-indigo-200 active:scale-95 transition-transform hover:bg-indigo-600"
                        >
                            选择文件
                        </button>
                    </div>
                }
            >
                <div className="py-3 text-sm text-slate-600 flex flex-col items-center gap-4">
                    <div className="w-14 h-14 bg-amber-50 rounded-full flex items-center justify-center text-amber-500 ring-8 ring-amber-50/50">
                        <WarningCircle size={28} weight="fill" />
                    </div>
                    <p className="text-center leading-6">
                        请注意，如果导入的不是您的作品，请确定该世界书的作者允许该世界书用于免费小手机。
                    </p>
                    <p className="text-center text-xs leading-5">支持糯米机新版和旧版世界书 JSON、酒馆世界书 JSON，以及糯米机世界书分享图。</p>
                </div>
            </Modal>

            {/* 新建 / 编辑外层分组 Modal */}
            <Modal
                isOpen={!!folderEditor}
                title={folderEditor?.mode === 'edit' ? '编辑世界书分组' : '新建世界书分组'}
                onClose={() => { if (!savingFolder) setFolderEditor(null); }}
                footer={
                    <div className="flex gap-3 w-full">
                        <button
                            type="button"
                            disabled={savingFolder}
                            onClick={() => setFolderEditor(null)}
                            className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50"
                        >
                            取消
                        </button>
                        <button
                            type="button"
                            disabled={savingFolder}
                            onClick={() => void saveFolder()}
                            className="flex-1 py-3 rounded-2xl bg-indigo-500 text-white font-bold shadow-lg shadow-indigo-200 active:scale-95 transition-transform disabled:opacity-50"
                        >
                            {savingFolder ? '保存中…' : '保存分组'}
                        </button>
                    </div>
                }
            >
                {folderEditor && (
                    <div className="space-y-4 text-sm text-slate-600">
                        <label className="block">
                            <span className="text-xs font-bold text-slate-500">分组名称</span>
                            <input
                                aria-label="外层分组名称"
                                value={folderEditor.name}
                                onChange={event => setFolderEditor({ ...folderEditor, name: event.target.value })}
                                placeholder="例如：现代日常、奇幻跑团…"
                                className="mt-2 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm outline-none focus:border-indigo-400"
                            />
                        </label>
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-xs font-bold text-slate-500">勾选归入本组的世界书</span>
                                <span className="text-[11px] text-slate-400">已选 {folderEditor.selectedCategories.size} 本</span>
                            </div>
                            <div className="max-h-60 overflow-y-auto rounded-2xl border border-slate-200/80 divide-y divide-slate-100 bg-slate-50/50">
                                {catalog.packages.map(pkg => {
                                    const checked = folderEditor.selectedCategories.has(pkg.category);
                                    const inOtherGroup = pkg.group && pkg.group !== folderEditor.previousName;
                                    return (
                                        <button
                                            key={pkg.category}
                                            type="button"
                                            data-group-pick-book={pkg.category}
                                            onClick={() => toggleFolderCategory(pkg.category)}
                                            className="w-full px-3.5 py-2.5 flex items-center gap-3 text-left hover:bg-white transition-colors"
                                        >
                                            <span className={`w-5 h-5 shrink-0 rounded-md border flex items-center justify-center transition-colors ${checked ? 'bg-indigo-500 border-indigo-500 text-white' : 'bg-white border-slate-300 text-transparent'}`}>
                                                <Check size={13} weight="bold" />
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block text-xs font-bold text-slate-700 truncate">{pkg.category}</span>
                                                <span className="block text-[10px] text-slate-400">
                                                    {pkg.books.length} 条词条{inOtherGroup ? ` · 当前在「${pkg.group}」` : ''}
                                                </span>
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                        <p className="text-xs leading-relaxed text-slate-400">
                            分组用于把多本世界书归在一起一键全开或全关，组内也可以单独调整某一本世界书。取消勾选或解散分组只会退回「未分组」，不会删除任何内容。
                        </p>
                    </div>
                )}
            </Modal>

            {/* 编辑整本世界书 Modal */}
            <Modal
                isOpen={!!groupEditor}
                title="编辑整本世界书"
                onClose={() => { if (!savingGroup) setGroupEditor(null); }}
                footer={
                    <button
                        type="button"
                        disabled={savingGroup}
                        onClick={() => void saveGroup()}
                        className="w-full py-3 rounded-2xl bg-indigo-500 text-white font-bold disabled:opacity-50"
                    >
                        {savingGroup ? '保存中…' : '保存整本'}
                    </button>
                }
            >
                {groupEditor && (
                    <div className="space-y-4 text-sm text-slate-600">
                        <label className="block">
                            世界书名称
                            <input
                                aria-label="世界书名称"
                                value={groupEditor.name}
                                onChange={event => setGroupEditor({ ...groupEditor, name: event.target.value })}
                                className="mt-2 w-full rounded-xl border border-slate-200 p-3"
                            />
                        </label>
                        <div>
                            <label className="block">
                                所属分组（可选）
                                <input
                                    aria-label="所属分组"
                                    value={groupEditor.outerGroup}
                                    onChange={event => setGroupEditor({ ...groupEditor, outerGroup: event.target.value })}
                                    placeholder="留空则归入未分组"
                                    className="mt-2 w-full rounded-xl border border-slate-200 p-3"
                                />
                            </label>
                            {(outerGroupNames.length > 0 || groupEditor.outerGroup.trim()) && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {outerGroupNames.map(gName => (
                                        <button
                                            key={gName}
                                            type="button"
                                            onClick={() => setGroupEditor({ ...groupEditor, outerGroup: gName })}
                                            className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${groupEditor.outerGroup.trim() === gName ? 'bg-indigo-500 text-white border-indigo-500' : 'bg-slate-50 text-slate-600 border-slate-200 hover:border-indigo-300'}`}
                                        >
                                            {gName}
                                        </button>
                                    ))}
                                    {groupEditor.outerGroup.trim() && (
                                        <button
                                            type="button"
                                            onClick={() => setGroupEditor({ ...groupEditor, outerGroup: '' })}
                                            className="text-[11px] px-2.5 py-1 rounded-full border border-slate-200 bg-white text-slate-400 hover:text-slate-600"
                                        >
                                            移出分组
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                        <label className="block">
                            整本触发方式
                            <select
                                aria-label="整本触发方式"
                                value={groupEditor.mode}
                                onChange={event => setGroupEditor({ ...groupEditor, mode: event.target.value as 'keep' | 'constant' | 'keyword' })}
                                className="mt-2 w-full rounded-xl border border-slate-200 p-3"
                            >
                                <option value="keep">保持各词条原设置</option>
                                <option value="constant">全部常驻</option>
                                <option value="keyword">全部关键词触发</option>
                            </select>
                        </label>
                        <label className="block">
                            整本启用场景
                            <select
                                aria-label="整本启用场景"
                                value={groupEditor.scenesMode}
                                onChange={event => setGroupEditor({ ...groupEditor, scenesMode: event.target.value as 'keep' | 'set' })}
                                className="mt-2 w-full rounded-xl border border-slate-200 p-3"
                            >
                                <option value="keep">保持各条原设置</option>
                                <option value="set">统一设为…</option>
                            </select>
                        </label>
                        {groupEditor.scenesMode === 'set' && (
                            <WorldbookSceneEditor label="统一设为" value={groupEditor.scenes} onChange={scenes => setGroupEditor({ ...groupEditor, scenes })} />
                        )}
                        <p className="text-xs leading-relaxed text-slate-400">
                            修改本书全部 {catalog.packages.find(item => item.category === groupEditor.category)?.books.length || 0} 条词条，并同步到已经挂载它们的角色。保留原有词条、关键词和挂载关系；不会给其他角色新增挂载。停用的词条仍保持停用。
                        </p>
                    </div>
                )}
            </Modal>

            <Modal
                isOpen={showBulkDeleteConfirm}
                title="批量删除确认"
                onClose={closeBulkDelete}
                footer={
                    <div className="flex gap-3 w-full">
                        <button type="button" onClick={closeBulkDelete} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform">取消</button>
                        <button type="button" onClick={() => void confirmBulkDelete()} disabled={deletingBooks} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200 active:scale-95 transition-transform">删除 {selectedBookIds.size} 条</button>
                    </div>
                }
            >
                <div className="text-center py-4 text-sm text-slate-600 flex flex-col items-center gap-3">
                    <div className="w-12 h-12 bg-red-50 rounded-full flex items-center justify-center text-red-500 mb-1">
                        <Trash size={24} weight="bold" />
                    </div>
                    <div>
                        确定要删除选中的 <span className="font-bold text-slate-900">{selectedBookIds.size}</span> 条世界书词条吗？
                        <br /><span className="text-xs text-red-400 opacity-80 mt-1 block">将同时从已挂载的角色中移除，且无法撤销。</span>
                    </div>
                </div>
            </Modal>

            {/* Delete Confirmation Modal */}
            <Modal
                isOpen={showDeleteConfirm}
                title="删除确认"
                onClose={() => setShowDeleteConfirm(false)}
                footer={
                    <div className="flex gap-3 w-full">
                        <button type="button" onClick={() => setShowDeleteConfirm(false)} className="flex-1 py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform">取消</button>
                        <button type="button" onClick={() => void confirmDelete()} className="flex-1 py-3 bg-red-500 text-white font-bold rounded-2xl shadow-lg shadow-red-200 active:scale-95 transition-transform">确认删除</button>
                    </div>
                }
            >
                <div className="text-center py-4 text-sm text-slate-600 flex flex-col items-center gap-3">
                    <div className="w-12 h-12 bg-red-50 rounded-full flex items-center justify-center text-red-500 mb-1">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-6 h-6"><path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
                    </div>
                    <div>
                        确定要删除 <span className="font-bold text-slate-900">"{editingBook?.title}"</span> 吗？
                        <br /><span className="text-xs text-red-400 opacity-80 mt-1 block">此操作无法撤销。</span>
                    </div>
                </div>
            </Modal>
        </div>
    );
};

export default WorldbookApp;
