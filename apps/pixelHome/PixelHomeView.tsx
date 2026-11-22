/**
 * Pixel Home — 像素家园主入口
 *
 * 管理4个子视图：俯瞰地图、单房间编辑、资产生成器、资产仓库
 * 处理资产替换/添加流程
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useOS } from '../../context/OSContext';
import type { PixelHomeState, PixelHomeViewMode, PixelAsset, PlacedFurniture } from './types';
import type { MemoryRoom } from '../../utils/memoryPalace/types';
import { getOrCreateHomeState, PixelLayoutDB, PixelAssetDB } from './pixelHomeDb';
import { ROOM_META } from './roomTemplates';
import { downloadPreset, importPreset, readFileAsText } from './presetManager';
import PixelHomeMap from './PixelHomeMap';
import PixelRoomEditor from './PixelRoomEditor';
import PixelAssetGenerator from './PixelAssetGenerator';
import AssetLibrary from './AssetLibrary';
import PixelCharEditor from './PixelCharEditor';
import MemoryDiveMode from './MemoryDiveMode';
import type { DiveResult } from './memoryDiveTypes';
import type { PixelCharConfig } from './pixelCharGenerator';
import { ensurePixelChar } from './pixelCharGenerator';
import { DB } from '../../utils/db';
import { trackEvent } from '../../utils/analytics';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

// 内置角色的默认像素形象（用户未自定义时使用）
const PIXEL_CHAR_BASE = ((import.meta as any).env?.BASE_URL ?? '/') + 'pixel-char/';
const DEFAULT_CHAR_SPRITES: Record<string, string> = {
  'preset-sully-v2': `${PIXEL_CHAR_BASE}sully.png`,
};

interface Props {
  charId: string;
  charName: string;
  charAvatar?: string;
  userName: string;
  onBack: () => void;
  navigation?: React.ReactNode;
}

const PixelHomeView: React.FC<Props> = ({ charId, charName, charAvatar, userName, onBack, navigation }) => {
  const { addToast, apiConfig, characters, userProfile, remoteVectorConfig } = useOS();
  const { requestConfirm, confirmDialog } = useConfirmDialog({ portal: true });
  const char = characters.find(c => c.id === charId);
  const [viewMode, setViewMode] = useState<PixelHomeViewMode>('map');
  const [homeState, setHomeState] = useState<PixelHomeState | null>(null);
  const [assets, setAssets] = useState<PixelAsset[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<MemoryRoom>('living_room');
  const [loading, setLoading] = useState(true);

  // 资产操作上下文：
  // - null: 仅浏览仓库
  // - '__add__': 添加新家具到房间
  // - 'slot_xxx': 替换某个已有家具
  // 像素小人：角色 和 用户自己 各存一份
  const [pixelCharConfig, setPixelCharConfig] = useState<PixelCharConfig | null>(null);
  const [pixelCharSprite, setPixelCharSprite] = useState<string | null>(null);
  const [pixelUserConfig, setPixelUserConfig] = useState<PixelCharConfig | null>(null);
  const [pixelUserSprite, setPixelUserSprite] = useState<string | null>(null);
  /** 打开捏人界面时编辑的是"角色"还是"用户自己" */
  const [editorTarget, setEditorTarget] = useState<'char' | 'user'>('char');
  const [lastDiveResult, setLastDiveResult] = useState<DiveResult | null>(null);

  const pendingSlotRef = useRef<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [state, allAssets, savedChar, savedUser, savedTheme] = await Promise.all([
          getOrCreateHomeState(charId),
          PixelAssetDB.getAll(),
          DB.getAsset(`pixel_char_${charId}`),
          // 用户自己的像素小人是全局的，所有角色/房间共享
          DB.getAsset(`pixel_char_user`),
          // 家园主题色按角色保存
          DB.getAsset(`pixel_home_theme_${charId}`),
        ]);
        if (!cancelled) {
          if (savedTheme) {
            try { state.theme = JSON.parse(savedTheme); } catch {}
          }
          setHomeState(state);
          setAssets(allAssets);
          if (savedChar) {
            const cfg = JSON.parse(savedChar) as PixelCharConfig;
            setPixelCharConfig(cfg);
            ensurePixelChar(cfg).then(uri => { if (!cancelled) setPixelCharSprite(uri); }).catch(() => {});
          } else {
            // 未保存过 → 尝试加载内置默认像素形象（如 Sully）
            const defaultSprite = DEFAULT_CHAR_SPRITES[charId];
            if (defaultSprite) setPixelCharSprite(defaultSprite);
          }
          if (savedUser) {
            const cfg = JSON.parse(savedUser) as PixelCharConfig;
            setPixelUserConfig(cfg);
            ensurePixelChar(cfg).then(uri => { if (!cancelled) setPixelUserSprite(uri); }).catch(() => {});
          }
        }
      } catch (err) {
        console.error('❌ [PixelHome] Failed to load:', err);
        addToast?.('加载像素家园失败', 'error');
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [charId]);

  // 保存像素小人（按 editorTarget 分别存到角色/用户 key）
  const handleSaveChar = useCallback(async (cfg: PixelCharConfig, imageUri: string) => {
    try {
      if (editorTarget === 'user') {
        await DB.saveAsset(`pixel_char_user`, JSON.stringify(cfg));
        setPixelUserConfig(cfg);
        setPixelUserSprite(imageUri);
        addToast?.('你的像素形象已保存', 'success');
      } else {
        await DB.saveAsset(`pixel_char_${charId}`, JSON.stringify(cfg));
        setPixelCharConfig(cfg);
        setPixelCharSprite(imageUri);
        addToast?.(`${charName}的像素形象已保存`, 'success');
      }
    } catch (err) {
      // 写库失败（多为存储配额不足）如实报错，别让用户以为存上了、下次进来形象又没了
      console.error('❌ [PixelHome] 像素形象保存失败:', err);
      addToast?.('像素形象保存失败，可能是存储空间不足', 'error');
      return;
    }
    setViewMode('map');
  }, [charId, charName, editorTarget, addToast]);

  /**
   * 进入潜行模式前先检查：用户/角色是否还用着默认形象？
   * 用的是默认形象就直接跳到捏人界面——两个人都没像素化的话潜行模式里出现的是
   * 默认绿小人 / 紫小人，看起来两个人都是路人甲。先让用户起码把"你自己"捏好，
   * 顺便提示一下 TA 也可以捏。
   */
  const handleEnterDive = useCallback(() => {
    if (!pixelUserConfig) {
      addToast?.('先捏一下你自己的像素形象，再一起潜入TA的内心', 'info');
      setEditorTarget('user');
      setViewMode('charEditor');
      return;
    }
    if (!pixelCharConfig) {
      addToast?.(`再给${charName}也捏一个像素形象吧，不然TA会以默认形象出现`, 'info');
      setEditorTarget('char');
      setViewMode('charEditor');
      return;
    }
    setViewMode('dive');
    trackEvent('进入记忆潜行模式');
  }, [pixelUserConfig, pixelCharConfig, charName, addToast]);

  // 记忆潜行结束回调
  const handleDiveExit = useCallback((result: DiveResult | null) => {
    setViewMode('map');
    if (result) {
      setLastDiveResult(result);
      const primaryBuff = result.buffs[0];
      if (primaryBuff) {
        addToast?.(`记忆潜行结束！获得「${primaryBuff.label}」+${primaryBuff.value}`, 'success');
      }
    }
  }, [addToast]);

  const handleEnterRoom = useCallback((roomId: MemoryRoom) => {
    setSelectedRoom(roomId); setViewMode('room');
    trackEvent('进入像素家园房间', { room: roomId });
  }, []);

  const handleRoomUpdate = useCallback(async () => {
    setHomeState(await getOrCreateHomeState(charId));
  }, [charId]);

  // 导出预设
  const handleExport = useCallback(async () => {
    if (!homeState) return;
    const name = charName + '的家';
    const result = await downloadPreset(homeState, assets, name, userName);
    if (result === 'cancelled') return;
    addToast?.('预设已导出', 'success');
    trackEvent('导出像素家园预设');
  }, [homeState, assets, charName, userName, addToast]);

  // 导入预设
  const handleImportFile = useCallback(async (file: File) => {
    try {
      const json = await readFileAsText(file);
      let parsed: any;
      try {
        parsed = JSON.parse(json);
      } catch {
        addToast?.('导入失败: 无效的预设文件格式', 'error');
        return;
      }
      if (!parsed?.version || !Array.isArray(parsed?.rooms)) {
        addToast?.('无效的预设文件格式', 'error');
        return;
      }
      const presetTitle = typeof parsed.name === 'string' && parsed.name.trim() ? `「${parsed.name.trim()}」` : '';
      const ok = await requestConfirm({
        title: `导入预设${presetTitle}并覆盖当前角色全部房间布局？`,
        message: `将用预设里的 ${parsed.rooms.length} 个房间布局覆盖 ${charName} 当前所有房间的家具与装修；新增素材会追加到仓库。`,
        confirmText: '确认导入',
        variant: 'warning',
      });
      if (!ok) return;
      const result = await importPreset(json, charId);
      if (result.success) {
        await handleRoomUpdate();
        const allAssets = await PixelAssetDB.getAll();
        setAssets(allAssets);
        addToast?.(`导入成功！${result.roomsImported}个房间，${result.assetsImported}个新资产`, 'success');
        trackEvent('导入像素家园预设');
      } else {
        addToast?.(result.error || '导入失败', 'error');
      }
    } catch (err: any) {
      addToast?.('导入失败: ' + err.message, 'error');
    }
  }, [charId, charName, handleRoomUpdate, addToast, requestConfirm]);

  const handleAssetsChanged = useCallback(async () => {
    setAssets(await PixelAssetDB.getAll());
  }, []);

  const handleOpenLibrary = useCallback((slotId: string | null) => {
    pendingSlotRef.current = slotId;
    setViewMode('library');
  }, []);

  // 从仓库选择资产
  const handleSelectAsset = useCallback(async (assetId: string) => {
    const slotId = pendingSlotRef.current;
    if (!homeState) { setViewMode('room'); return; }

    const roomLayout = homeState.rooms.find(r => r.roomId === selectedRoom);
    if (!roomLayout) { setViewMode('room'); return; }

    if (slotId === '__add__') {
      // 自由添加新家具
      const newF: PlacedFurniture = {
        slotId: `user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        assetId, x: 50, y: 60, scale: 1, rotation: 0,
        placedBy: 'user', isDefault: false,
      };
      const updated = {
        ...roomLayout,
        furniture: [...roomLayout.furniture, newF],
        lastUpdatedAt: Date.now(),
        lastDecoratedBy: 'user' as const,
      };
      await PixelLayoutDB.save(updated);
      await handleRoomUpdate();
      addToast?.('家具已放置', 'success');
      trackEvent('摆放一件像素家具', { action: 'add' });
    } else if (slotId) {
      // 替换已有家具的素材
      const updatedFurniture = roomLayout.furniture.map(f =>
        f.slotId === slotId ? { ...f, assetId, placedBy: 'user' as const } : f
      );
      await PixelLayoutDB.save({
        ...roomLayout, furniture: updatedFurniture,
        lastUpdatedAt: Date.now(), lastDecoratedBy: 'user' as const,
      });
      await handleRoomUpdate();
      addToast?.('家具已替换', 'success');
      trackEvent('摆放一件像素家具', { action: 'replace' });
    }

    pendingSlotRef.current = null;
    setViewMode('room');
  }, [homeState, selectedRoom, handleRoomUpdate, addToast]);

  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-slate-900">
        <div className="text-center space-y-3">
          <div className="text-4xl animate-pulse">🏠</div>
          <p className="text-slate-400 text-sm font-light">正在打开{charName}的像素家园...</p>
        </div>
      </div>
    );
  }
  if (!homeState) return null;

  const getRoomDisplayName = (roomId: MemoryRoom) =>
    roomId === 'user_room' ? `${userName}的房` : ROOM_META[roomId].name;

  return (
    <div className="h-full w-full flex flex-col bg-slate-900 overflow-hidden">
      {/* 顶部导航（潜行模式下隐藏，由 MemoryDiveMode 自带头部） */}
      {viewMode !== 'dive' && <div
        className="shrink-0 flex items-center justify-between px-4 pb-3 bg-slate-800/80 backdrop-blur-sm border-b border-slate-700/50"
        style={{ paddingTop: 'max(3rem, var(--safe-top, 0px))' }}
      >
        <button
          onClick={() => {
            if (viewMode === 'map') { onBack(); return; }
            // 仓库若是从房间中"添加/替换家具"进入的，应回到房间；其它（全局仓库/工坊/捏人/单房间编辑）一律回地图
            if (viewMode === 'library' && pendingSlotRef.current) {
              pendingSlotRef.current = null;
              setViewMode('room');
              return;
            }
            pendingSlotRef.current = null;
            setViewMode('map');
          }}
          aria-label={viewMode === 'map' ? '返回角色房间' : '返回像素地图'}
          className="p-2 -ml-2 rounded-full hover:bg-slate-700 active:scale-90 transition-all">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5 text-slate-300">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
          </svg>
        </button>
        <span className="font-bold text-slate-200 text-sm tracking-wide">
          {viewMode === 'map' && `${charName}的家`}
          {viewMode === 'room' && getRoomDisplayName(selectedRoom)}
          {viewMode === 'generator' && '像素工坊'}
          {viewMode === 'library' && (pendingSlotRef.current === '__add__' ? '选择要放置的家具' : pendingSlotRef.current ? '选择替换素材' : '仓库 / 工坊')}
          {viewMode === 'charEditor' && (editorTarget === 'user' ? '捏我自己' : `捏${charName}`)}
        </span>
        <div className="w-8" />
      </div>}
      {viewMode === 'map' && navigation && <div className="shrink-0 px-4">{navigation}</div>}

      {/* 主内容区 */}
      <div className="flex-1 overflow-hidden relative">
        {viewMode === 'map' && (
          <PixelHomeMap homeState={homeState} assets={assets}
            charSprite={pixelCharSprite || charAvatar} userName={userName} onEnterRoom={handleEnterRoom}
            onUpdateTheme={async theme => {
              setHomeState(prev => prev ? { ...prev, theme } : prev);
              try { await DB.saveAsset(`pixel_home_theme_${charId}`, JSON.stringify(theme)); } catch {}
            }} />
        )}
        {viewMode === 'room' && (
          <PixelRoomEditor charId={charId} charName={charName}
            charSprite={pixelCharSprite || charAvatar} userName={userName}
            roomId={selectedRoom} layout={homeState.rooms.find(r => r.roomId === selectedRoom)!}
            assets={assets} onUpdate={handleRoomUpdate} onOpenLibrary={handleOpenLibrary} />
        )}
        {viewMode === 'charEditor' && (
          <PixelCharEditor
            key={editorTarget}
            target={editorTarget}
            targetLabel={editorTarget === 'user' ? '你自己' : charName}
            initial={editorTarget === 'user' ? pixelUserConfig : pixelCharConfig}
            onSave={handleSaveChar}
            onCancel={() => setViewMode('map')}
          />
        )}
        {viewMode === 'generator' && (
          <PixelAssetGenerator onGenerated={handleAssetsChanged} />
        )}
        {viewMode === 'library' && (
          <AssetLibrary assets={assets} onChanged={handleAssetsChanged}
            onSelectAsset={handleSelectAsset} isSelecting={!!pendingSlotRef.current} />
        )}
        {viewMode === 'dive' && homeState && char && (
          <MemoryDiveMode
            charId={charId} charName={charName}
            charProfile={char}
            userProfile={userProfile}
            charSprite={pixelCharSprite || charAvatar}
            playerSprite={pixelUserSprite || undefined}
            userName={userName}
            homeState={homeState} assets={assets}
            apiConfig={apiConfig}
            remoteVectorConfig={remoteVectorConfig}
            onExit={handleDiveExit}
          />
        )}
      </div>

      {/* 底部工具栏 */}
      {viewMode === 'map' && (
        <div className="shrink-0 bg-slate-800/90 backdrop-blur-sm border-t border-slate-700/50" style={{ paddingBottom: 'var(--safe-bottom, 0px)' }}>
          <div className="flex items-center justify-around px-4 py-2">
            <BottomTab label="家园" active onClick={() => setViewMode('map')} />
            <BottomTab label="🌀潜行" onClick={handleEnterDive} />
            <BottomTab label="仓库/工坊" onClick={() => { pendingSlotRef.current = null; setViewMode('library'); trackEvent('打开像素资产仓库'); }} />
            <BottomTab label="导出" onClick={handleExport} />
            <BottomTab label="捏TA" onClick={() => { setEditorTarget('char'); setViewMode('charEditor'); trackEvent('打开像素捏人器', { target: 'char' }); }} />
            <BottomTab label="捏我" onClick={() => { setEditorTarget('user'); setViewMode('charEditor'); trackEvent('打开像素捏人器', { target: 'user' }); }} />
            <BottomTab label="导入" onClick={() => importInputRef.current?.click()} />
          </div>
          <input ref={importInputRef} type="file" accept=".json,.png,application/json,image/png" className="hidden"
            onChange={e => { if (e.target.files?.[0]) { void handleImportFile(e.target.files[0]); e.target.value = ''; } }} />
        </div>
      )}
      {confirmDialog}
    </div>
  );
};

const BottomTab: React.FC<{ label: string; active?: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
  <button onClick={onClick} className={`px-3 py-2 rounded-xl text-[10px] font-bold transition-all active:scale-90 ${active ? 'text-amber-400 bg-amber-500/10' : 'text-slate-400 hover:text-slate-200'}`}>
    {label}
  </button>
);

export default PixelHomeView;
