/**
 * Pixel Home — 资产仓库
 *
 * 分类管理所有像素家具：分类筛选、搜索、重命名、标签、批量操作。
 * 顶部内嵌一个"仓库 / 像素工坊"切换，避免用户在底部 tab 里混淆两者。
 */

import React, { useState, useCallback, useMemo } from 'react';
import type { PixelAsset } from './types';
import type { MemoryRoom } from '../../utils/memoryPalace/types';
import { PixelAssetDB } from './pixelHomeDb';
import PixelAssetGenerator from './PixelAssetGenerator';
import { trackEvent } from '../../utils/analytics';
import { shareOrDownloadBlob } from '../../utils/shareExport';

interface Props {
  assets: PixelAsset[];
  onChanged: () => void;
  onSelectAsset: (assetId: string) => void;
  isSelecting?: boolean;
}

// 预定义分类
const CATEGORIES = [
  { id: 'all',       label: '全部' },
  { id: 'furniture', label: '家具' },
  { id: 'decor',     label: '装饰' },
  { id: 'plant',     label: '植物' },
  { id: 'food',      label: '食物' },
  { id: 'character', label: '角色' },
  { id: 'other',     label: '其他' },
  { id: 'imported',  label: '导入' },
];

// 房间筛选（只是一个分类 tag，资源在其他房间也能看到）
const ROOM_OPTIONS: Array<{ id: MemoryRoom | 'all_rooms'; label: string; tag: string }> = [
  { id: 'all_rooms',   label: '所有房间', tag: '' },
  { id: 'living_room', label: '客厅',     tag: '客厅' },
  { id: 'bedroom',     label: '卧室',     tag: '卧室' },
  { id: 'study',       label: '书房',     tag: '书房' },
  { id: 'attic',       label: '阁楼',     tag: '阁楼' },
  { id: 'self_room',   label: '自我房',   tag: '自我房' },
  { id: 'user_room',   label: '用户房',   tag: '用户房' },
  { id: 'windowsill',  label: '露台',     tag: '露台' },
];

const AssetLibrary: React.FC<Props> = ({ assets, onChanged, onSelectAsset, isSelecting }) => {
  /** 顶部大 tab：仓库浏览 vs 像素工坊（合并自底部入口，避免混淆） */
  const [subView, setSubView] = useState<'library' | 'workshop'>('library');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [roomFilter, setRoomFilter] = useState<string>('all_rooms');
  const [sortBy, setSortBy] = useState<'newest' | 'name'>('newest');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [showTagInput, setShowTagInput] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');

  // 筛选 + 排序
  const filtered = useMemo(() => {
    let list = [...assets];

    // 分类筛选
    if (category !== 'all') {
      list = list.filter(a => a.tags.includes(category));
    }

    // 房间筛选（按房间 label tag 匹配，资源本身没房间属性 = 只是个过滤视图）
    if (roomFilter !== 'all_rooms') {
      const roomOpt = ROOM_OPTIONS.find(r => r.id === roomFilter);
      const tag = roomOpt?.tag;
      if (tag) list = list.filter(a => a.tags.includes(tag));
    }

    // 搜索
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.tags.some(t => t.toLowerCase().includes(q))
      );
    }

    // 排序
    if (sortBy === 'newest') {
      list.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }

    return list;
  }, [assets, category, roomFilter, search, sortBy]);

  // 点击
  const handleClick = useCallback((id: string) => {
    if (selectMode) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    } else {
      onSelectAsset(id);
    }
  }, [selectMode, onSelectAsset]);

  // 重命名
  const startRename = useCallback((asset: PixelAsset) => {
    setEditingId(asset.id);
    setEditName(asset.name);
  }, []);

  const saveRename = useCallback(async () => {
    if (!editingId || !editName.trim()) return;
    const asset = assets.find(a => a.id === editingId);
    if (asset) {
      await PixelAssetDB.save({ ...asset, name: editName.trim() });
      onChanged();
    }
    setEditingId(null);
  }, [editingId, editName, assets, onChanged]);

  // 添加标签
  const addTag = useCallback(async (assetId: string, tag: string) => {
    const asset = assets.find(a => a.id === assetId);
    if (!asset || !tag.trim()) return;
    const t = tag.trim().toLowerCase();
    if (asset.tags.includes(t)) return;
    await PixelAssetDB.save({ ...asset, tags: [...asset.tags, t] });
    onChanged();
    setTagInput('');
    trackEvent('给像素素材加标签');
  }, [assets, onChanged]);

  // 移除标签
  const removeTag = useCallback(async (assetId: string, tag: string) => {
    const asset = assets.find(a => a.id === assetId);
    if (!asset) return;
    await PixelAssetDB.save({ ...asset, tags: asset.tags.filter(t => t !== tag) });
    onChanged();
  }, [assets, onChanged]);

  // 批量加标签
  const batchAddTag = useCallback(async (tag: string) => {
    if (!tag.trim()) return;
    const t = tag.trim().toLowerCase();
    for (const id of selectedIds) {
      const asset = assets.find(a => a.id === id);
      if (asset && !asset.tags.includes(t)) {
        await PixelAssetDB.save({ ...asset, tags: [...asset.tags, t] });
      }
    }
    onChanged();
  }, [selectedIds, assets, onChanged]);

  // 删除选中
  const handleDeleteSelected = useCallback(async () => {
    for (const id of selectedIds) await PixelAssetDB.delete(id);
    setSelectedIds(new Set());
    setSelectMode(false);
    onChanged();
    trackEvent('批量删除像素素材');
  }, [selectedIds, onChanged]);

  // 导出
  const handleExportZip = useCallback(async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    const toExport = selectMode ? assets.filter(a => selectedIds.has(a.id)) : filtered;
    for (const asset of toExport) {
      const resp = await fetch(asset.pixelImage);
      const blob = await resp.blob();
      zip.file(`${asset.name}_${asset.pixelSize}px.png`, blob);
    }
    const content = await zip.generateAsync({ type: 'blob' });
    const result = await shareOrDownloadBlob({
      blob: content,
      fileName: `pixel_assets_${Date.now()}.zip`,
      shareTitle: 'SullyOS·糯米机 像素素材包',
    });
    if (result === 'cancelled') return;
    trackEvent('导出像素素材包');
  }, [assets, selectedIds, selectMode, filtered]);

  // 顶部大 tab
  const SubTabs = (
    <div className="shrink-0 flex gap-1 bg-slate-800/80 mx-3 mt-2 p-1 rounded-xl">
      <button onClick={() => { setSubView('library'); trackEvent('切换仓库与工坊分区', { subView: 'library' }); }}
        className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-all ${subView === 'library' ? 'bg-amber-500 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
        仓库 ({assets.length})
      </button>
      <button onClick={() => { setSubView('workshop'); trackEvent('切换仓库与工坊分区', { subView: 'workshop' }); }}
        className={`flex-1 py-1.5 rounded-lg text-[11px] font-bold transition-all ${subView === 'workshop' ? 'bg-amber-500 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
        像素工坊
      </button>
    </div>
  );

  // 工坊 tab：直接嵌 PixelAssetGenerator
  if (subView === 'workshop') {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        {SubTabs}
        <div className="flex-1 overflow-hidden">
          <PixelAssetGenerator onGenerated={onChanged} />
        </div>
      </div>
    );
  }

  if (assets.length === 0) {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        {SubTabs}
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
          <div className="w-16 h-16 rounded-2xl bg-slate-800 flex items-center justify-center">
            <span className="text-2xl text-slate-600">0</span>
          </div>
          <p className="text-sm text-slate-400 text-center">仓库是空的</p>
          <button onClick={() => setSubView('workshop')}
            className="text-xs text-amber-400 underline hover:text-amber-300">
            去像素工坊上传图片生成家具
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {SubTabs}
      {/* 选择提示 */}
      {isSelecting && (
        <div className="shrink-0 px-4 py-2 bg-amber-600/20 border-b border-amber-600/30 text-center">
          <span className="text-xs text-amber-400 font-bold">点击素材来放置或替换</span>
        </div>
      )}

      {/* 搜索栏 */}
      <div className="shrink-0 px-3 pt-2 pb-1">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="搜索名称或标签..."
          className="w-full px-3 py-1.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-200 placeholder-slate-500 outline-none focus:border-amber-500/50"
        />
      </div>

      {/* 分类 Tab */}
      <div className="shrink-0 px-3 py-1.5 flex gap-1 overflow-x-auto no-scrollbar">
        {CATEGORIES.map(cat => {
          const count = cat.id === 'all' ? assets.length : assets.filter(a => a.tags.includes(cat.id)).length;
          if (cat.id !== 'all' && count === 0) return null;
          return (
            <button key={cat.id} onClick={() => setCategory(cat.id)}
              className={`shrink-0 px-2 py-1 rounded-md text-[10px] font-bold transition-all ${
                category === cat.id ? 'bg-amber-500 text-white' : 'bg-slate-800 text-slate-400'
              }`}>
              {cat.label}{count > 0 ? ` ${count}` : ''}
            </button>
          );
        })}
      </div>

      {/* 房间 Tab（只是筛选，不代表别的房间就看不到） */}
      <div className="shrink-0 px-3 py-1 flex gap-1 overflow-x-auto no-scrollbar">
        <span className="shrink-0 text-[9px] text-slate-500 self-center mr-1">按房间</span>
        {ROOM_OPTIONS.map(r => {
          const count = r.id === 'all_rooms' ? assets.length : assets.filter(a => a.tags.includes(r.tag)).length;
          if (r.id !== 'all_rooms' && count === 0) return null;
          return (
            <button key={r.id} onClick={() => setRoomFilter(r.id)}
              className={`shrink-0 px-2 py-1 rounded-md text-[10px] font-bold transition-all ${
                roomFilter === r.id ? 'bg-emerald-500 text-white' : 'bg-slate-800 text-slate-400'
              }`}>
              {r.label}{count > 0 ? ` ${count}` : ''}
            </button>
          );
        })}
      </div>

      {/* 操作栏 */}
      <div className="shrink-0 flex items-center justify-between px-3 py-1 border-b border-slate-700/50">
        <div className="flex gap-1.5 items-center">
          <button onClick={() => { setSelectMode(!selectMode); setSelectedIds(new Set()); }}
            className={`px-2 py-1 rounded text-[10px] font-bold ${selectMode ? 'bg-amber-500 text-white' : 'bg-slate-700 text-slate-300'}`}>
            {selectMode ? `已选 ${selectedIds.size}` : '多选'}
          </button>
          <button onClick={() => setSortBy(sortBy === 'newest' ? 'name' : 'newest')}
            className="px-2 py-1 rounded text-[10px] font-bold bg-slate-700 text-slate-300">
            {sortBy === 'newest' ? '按时间' : '按名称'}
          </button>
        </div>
        <div className="flex gap-1.5">
          {selectMode && selectedIds.size > 0 && (
            <>
              <BatchTagBtn onAdd={batchAddTag} />
              <button onClick={handleDeleteSelected}
                className="px-2 py-1 rounded text-[10px] font-bold bg-red-700 text-white active:scale-95">删除</button>
            </>
          )}
          <button onClick={handleExportZip}
            className="px-2 py-1 rounded text-[10px] font-bold bg-indigo-700 text-white active:scale-95">导出</button>
        </div>
      </div>

      {/* 计数 */}
      <div className="shrink-0 px-3 py-1">
        <span className="text-[9px] text-slate-500">{filtered.length} 件素材</span>
      </div>

      {/* 网格 */}
      <div className="flex-1 overflow-y-auto px-3 no-scrollbar" style={{ paddingBottom: 'calc(0.75rem + var(--safe-bottom, 0px))' }}>
        <div className="grid grid-cols-3 gap-2">
          {filtered.map(asset => {
            const isSelected = selectedIds.has(asset.id);
            const isEditing = editingId === asset.id;
            const isTagging = showTagInput === asset.id;
            return (
              <div key={asset.id} className={`relative bg-slate-800 rounded-xl overflow-hidden border-2 transition-all ${
                isSelected ? 'border-amber-500' : 'border-transparent'
              }`}>
                {/* 图片 */}
                <button onClick={() => handleClick(asset.id)}
                  className="w-full aspect-square flex items-center justify-center p-2 active:scale-95 transition-transform">
                  <img src={asset.pixelImage} alt={asset.name}
                    className="max-w-full max-h-full object-contain"
                    style={{ imageRendering: 'pixelated' }} draggable={false} />
                </button>

                {/* 尺寸标签 */}
                <span className="absolute top-1 right-1 text-[8px] bg-black/60 text-slate-300 px-1 rounded">
                  {asset.pixelSize}px
                </span>

                {/* 多选勾 */}
                {selectMode && (
                  <div className={`absolute top-1 left-1 w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                    isSelected ? 'bg-amber-500 border-amber-500' : 'border-slate-500 bg-black/30'
                  }`}>
                    {isSelected && <span className="text-white text-[8px]">✓</span>}
                  </div>
                )}

                {/* 底部信息区 */}
                <div className="px-1.5 pb-1.5 space-y-1">
                  {/* 名称（可编辑） */}
                  {isEditing ? (
                    <input value={editName} onChange={e => setEditName(e.target.value)}
                      onBlur={saveRename} onKeyDown={e => e.key === 'Enter' && saveRename()}
                      autoFocus className="w-full bg-slate-700 text-[9px] text-white px-1 py-0.5 rounded outline-none" />
                  ) : (
                    <div className="flex items-center gap-1">
                      <span className="text-[9px] text-slate-300 font-medium truncate flex-1">{asset.name}</span>
                      {!selectMode && (
                        <button onClick={() => startRename(asset)}
                          className="text-[8px] text-slate-500 hover:text-slate-300 shrink-0">改名</button>
                      )}
                    </div>
                  )}

                  {/* 标签 */}
                  <div className="flex flex-wrap gap-0.5 items-center">
                    {asset.tags.map(t => (
                      <span key={t} className="inline-flex items-center gap-px text-[8px] bg-slate-700 text-slate-400 px-1 rounded group">
                        {t}
                        {!selectMode && (
                          <button onClick={() => removeTag(asset.id, t)}
                            className="text-slate-600 hover:text-red-400 hidden group-hover:inline ml-0.5">x</button>
                        )}
                      </span>
                    ))}
                    {!selectMode && !isTagging && (
                      <button onClick={() => { setShowTagInput(asset.id); setTagInput(''); }}
                        className="text-[8px] text-slate-600 hover:text-slate-300">+标签</button>
                    )}
                    {isTagging && (
                      <input value={tagInput} onChange={e => setTagInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { addTag(asset.id, tagInput); setShowTagInput(null); }
                          if (e.key === 'Escape') setShowTagInput(null);
                        }}
                        onBlur={() => { if (tagInput.trim()) addTag(asset.id, tagInput); setShowTagInput(null); }}
                        autoFocus placeholder="输入标签"
                        className="w-12 bg-slate-700 text-[8px] text-white px-1 py-0.5 rounded outline-none" />
                    )}
                  </div>

                  {/* 调色板 */}
                  <div className="flex h-1 rounded-full overflow-hidden">
                    {asset.palette.slice(0, 6).map((c, i) => (
                      <div key={i} className="flex-1" style={{ backgroundColor: c }} />
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// 批量加标签按钮（带输入框）
const BatchTagBtn: React.FC<{ onAdd: (tag: string) => void }> = ({ onAdd }) => {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="px-2 py-1 rounded text-[10px] font-bold bg-slate-700 text-slate-300 active:scale-95">
        加标签
      </button>
    );
  }

  return (
    <div className="flex gap-1 items-center">
      <input value={value} onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && value.trim()) { onAdd(value); setOpen(false); setValue(''); } }}
        autoFocus placeholder="标签名"
        className="w-14 bg-slate-700 text-[10px] text-white px-1.5 py-1 rounded outline-none" />
      <button onClick={() => { if (value.trim()) { onAdd(value); setOpen(false); setValue(''); } }}
        className="px-1.5 py-1 rounded text-[10px] font-bold bg-amber-600 text-white">确定</button>
    </div>
  );
};

export default AssetLibrary;
