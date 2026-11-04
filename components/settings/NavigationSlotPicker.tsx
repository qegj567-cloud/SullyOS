import React, { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CaretDown, CaretRight, MagnifyingGlass, X } from '@phosphor-icons/react';
import { Icons } from '../../constants';
import { AppID } from '../../types';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';
import { normalizeShortcutSearchText, shortcutSearchTerms, NAVIGATION_SLOT_APPS, ROOM_SHORTCUT_MODES, APP_SHORTCUT_ENTRIES, RESOURCE_SHORTCUT_APPS, hasShortcutChildren, getShortcutEntry, type NavigationShortcut, type ShortcutCharacter, type ShortcutWorld, type ShortcutResources } from '../../utils/navigationShortcuts';
import './NavigationSlotPicker.css';
import { setNavigationPickerOpen } from '../../utils/navigationBall';

type Option = { id: string; name: string; detail: string; icon?: string; aliases?: string; onChoose: () => void };
const EMPTY_RESOURCES: ShortcutResources = {};
const APP_SEARCH_ALIASES: Partial<Record<AppID, string>> = {
  [AppID.Room]: '小屋 家园 拜访 3D', [AppID.Chat]: '消息 聊天 私聊', [AppID.Character]: '角色 设定',
};
/** Fixed-height rows keep large character libraries bounded without mounting every avatar. */
function OptionList({ options }: { options: Option[] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(320), [top, setTop] = useState(0);
  useLayoutEffect(() => {
    const node = viewport.current; if (!node) return;
    const measure = () => setHeight(node.clientHeight || 320);
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const rowHeight = 68, start = Math.max(0, Math.floor(top / rowHeight) - 3);
  const visible = options.slice(start, start + Math.ceil(height / rowHeight) + 6);
  return <div ref={viewport} className="navigation-picker-list" role="list" aria-label="快捷入口选项" style={{ height: Math.min(options.length * rowHeight, 340), maxHeight: '40dvh' }} onScroll={event => setTop(event.currentTarget.scrollTop)}>
    <div style={{ height: options.length * rowHeight, position: 'relative' }}>
      {visible.map((option, index) => {
        const Icon = option.icon ? Icons[option.icon] : null;
        return <div key={option.id} role="listitem" aria-posinset={start + index + 1} aria-setsize={options.length}
          style={{ position: 'absolute', top: (start + index) * rowHeight, left: 0, right: 0, height: rowHeight }}>
          <button type="button" className="navigation-picker-option" onClick={option.onChoose}>
            <span className="navigation-picker-symbol" aria-hidden="true">{Icon ? <Icon /> : option.name.slice(0, 1)}</span>
            <span className="navigation-picker-option-copy"><strong>{option.name}</strong><small>{option.detail}</small></span>
            <CaretRight size={16} aria-hidden="true" />
          </button>
        </div>;
      })}
    </div>
  </div>;
}
export default function NavigationSlotPicker({ slot, characters, loadWorlds, resources = EMPTY_RESOURCES, onSelect, onClose }: {
  slot: number; characters: readonly ShortcutCharacter[]; loadWorlds?: () => Promise<ShortcutWorld[]>;
  resources?: ShortcutResources;
  onSelect: (shortcut: NavigationShortcut | null) => void; onClose: () => void;
}) {
  const [appId, setAppId] = useState<AppID | null>(null);
  const [roomTab, setRoomTab] = useState<NavigationShortcut['roomTab']>();
  const [entryId, setEntryId] = useState<string>();
  const [query, setQuery] = useState(''), deferredQuery = useDeferredValue(query);
  const [worlds, setWorlds] = useState<ShortcutWorld[]>([]), [worldStatus, setWorldStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [retry, setRetry] = useState(0);
  const panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const titleId = useId();
  useLayoutEffect(() => { setNavigationPickerOpen(true); return () => setNavigationPickerOpen(false); }, []);
  const worldLoader = useRef(loadWorlds); worldLoader.current = loadWorlds;
  const isWorld = appId === AppID.Room && roomTab === 'worldHome';
  const isRoomMode = appId === AppID.Room && !roomTab;
  const entry = appId ? getShortcutEntry(appId, entryId) : undefined;
  const isAppMode = !!appId && !!APP_SHORTCUT_ENTRIES[appId] && !entryId;
  const isResource = !!appId && (entry?.target === 'resources' || RESOURCE_SHORTCUT_APPS.includes(appId));
  const stage = !appId ? 'apps' : isRoomMode || isAppMode ? 'modes' : isWorld ? 'worlds' : isResource ? 'resources' : 'characters';
  const closeRef = useRef(onClose);
  useLayoutEffect(() => { closeRef.current = onClose; });
  const dismissSearch = () => { search.current?.blur(); panel.current?.focus({ preventScroll: true }); };
  // Focus the dialog, never an editable field: mobile Chrome otherwise opens the keyboard.
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected && !opener.matches('input,textarea') && !opener.isContentEditable) opener.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => { dismissSearch(); }, [stage, roomTab, entryId]);
  const back = () => { setQuery(''); if (roomTab) setRoomTab(undefined); else if (entryId) setEntryId(undefined); else if (appId) setAppId(null); else onClose(); };
  useLocalBackHandler(() => {
    if (document.activeElement === search.current) dismissSearch(); else back();
    return true;
  }, 80);
  useEffect(() => {
    if (!isWorld || worldStatus === 'ready') return;
    let alive = true; setWorldStatus('loading');
    Promise.resolve().then(() => worldLoader.current ? worldLoader.current() : []).then(items => {
      if (alive) { setWorlds(items.map(item => ({ id: item.id, name: item.name }))); setWorldStatus('ready'); }
    }).catch(() => { if (alive) setWorldStatus('error'); });
    return () => { alive = false; };
  }, [isWorld, retry]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (document.activeElement === search.current) dismissSearch(); else closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = panel.current?.querySelectorAll<HTMLElement>('button,input,[tabindex="0"]');
      if (!nodes?.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, []);
  const chooseApp = (id: AppID) => {
    setQuery('');
    if (hasShortcutChildren(id)) setAppId(id);
    else onSelect({ appId: id });
  };
  const appName = NAVIGATION_SLOT_APPS.find(app => app.id === appId)?.name;
  const modeName = ROOM_SHORTCUT_MODES.find(mode => mode.id === roomTab)?.name || entry?.name;
  const destination = () => ({ appId: appId!, ...(roomTab ? { roomTab } : {}), ...(entryId ? { entryId } : {}) });
  const options = useMemo<Option[]>(() => {
    if (!appId) return NAVIGATION_SLOT_APPS.map(app => ({ id: app.id, name: app.name, detail: hasShortcutChildren(app.id) ? '可选择具体入口' : '打开 App', icon: app.icon, aliases: APP_SEARCH_ALIASES[app.id], onChoose: () => chooseApp(app.id) }));
    if (isRoomMode) return ROOM_SHORTCUT_MODES.map(mode => ({ id: mode.id, name: mode.name, detail: mode.detail, icon: 'Room', onChoose: () => { setRoomTab(mode.id); setQuery(''); } }));
    if (isAppMode) return APP_SHORTCUT_ENTRIES[appId]!.map(mode => ({ ...mode, onChoose: () => { if (mode.target) { setEntryId(mode.id); setQuery(''); } else onSelect({ appId, entryId: mode.id }); } }));
    if (isWorld) return worlds.map(world => ({ id: world.id, name: world.name, detail: '进入这个家园世界', icon: 'WorldHome', onChoose: () => onSelect({ appId, roomTab, worldId: world.id, targetName: world.name }) }));
    if (isResource) return (resources[appId] || []).map(item => ({ id: item.id, name: item.name, detail: `打开${modeName || appName}中的这项内容`, onChoose: () => onSelect({ ...destination(), resourceId: item.id, targetName: item.name }) }));
    return characters.map(character => ({ id: character.id, name: character.name,
      detail: appId === AppID.Chat ? '进入与 ta 的聊天' : `打开 ta 的${modeName || appName}`,
      onChoose: () => onSelect({ appId, roomTab, ...(entryId ? { entryId } : {}), characterId: character.id, targetName: character.name }) }));
  }, [appId, roomTab, entryId, characters, worlds, resources, onSelect]);
  const searchKeys = useMemo(() => options.map(option => normalizeShortcutSearchText(`${option.name} ${option.detail} ${option.id} ${option.aliases || ''}`)), [options]);
  const filtered = useMemo(() => {
    const terms = shortcutSearchTerms(deferredQuery);
    return terms.length ? options.filter((_, index) => terms.every(term => searchKeys[index].includes(term))) : options;
  }, [options, searchKeys, deferredQuery]);
  return <div className="navigation-picker-overlay" onClickCapture={event => {
    // Click (rather than pointerdown) avoids moving the dialog between press and release.
    if (document.activeElement === search.current && event.target instanceof Element && !event.target.closest('.navigation-picker-search')) dismissSearch();
  }}>
    <div className="navigation-picker-backdrop" onClick={onClose} />
    <div ref={panel} className="navigation-picker" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header><button type="button" aria-label="返回选择上一级" onClick={back}><ArrowLeft size={20} /></button>
        <div><small>槽位 {slot + 1}</small><h3 id={titleId}>{!appId ? '选择快捷入口' : isRoomMode ? '选择小屋分区' : isAppMode ? '选择 App 分区' : isWorld ? '选择家园世界' : isResource ? '选择具体内容' : '选择角色'}</h3></div>
        <button type="button" aria-label="关闭快捷入口选择" onClick={onClose}><X size={20} /></button></header>
      {appId && <p className="navigation-picker-path">{[appName, modeName].filter(Boolean).join(' / ')}</p>}
      <label className="navigation-picker-search"><MagnifyingGlass size={18} aria-hidden="true" />
        <input ref={search} type="search" enterKeyHint="done" onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); dismissSearch(); } }} value={query} aria-label="搜索快捷入口" placeholder={stage === 'apps' ? '搜索 App 名称' : isWorld ? '搜索世界名称' : stage === 'modes' ? '搜索分区' : isResource ? '搜索内容名称' : '搜索角色名称'} onChange={event => setQuery(event.target.value)} />
        <button type="button" aria-label="收起键盘" title="收起键盘" onClick={dismissSearch}><CaretDown size={18} aria-hidden="true" /></button>
        {query && <button type="button" aria-label="清空搜索" onClick={() => { setQuery(''); search.current?.focus(); }}><X size={16} /></button>}
      </label>
      {appId && <button type="button" className="navigation-picker-main-entry" onClick={() => onSelect(entry?.target === 'characters' ? { appId } : destination())}>只打开{entry?.target === 'characters' ? appName : modeName || appName}{stage === 'modes' || entry?.target === 'characters' ? '首页' : '列表'}<CaretRight size={16} /></button>}
      <p className="navigation-picker-count" role="status">{worldStatus === 'loading' && isWorld ? '正在读取世界列表…' : `${filtered.length} 个${stage === 'apps' ? 'App' : stage === 'modes' ? '分区' : isWorld ? '世界' : isResource ? '内容' : '角色'}`}</p>
      {isWorld && worldStatus === 'error' ? <div className="navigation-picker-empty">读取失败，未更改槽位。<button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></div>
        : filtered.length ? <OptionList key={`${stage}:${deferredQuery}`} options={filtered} />
        : <div className="navigation-picker-empty">{query ? '没有匹配结果，试试其他关键词' : isWorld ? '还没有家园世界，可以先打开列表创建' : isResource ? '暂无内容，可以先打开 App 添加' : '暂无可选角色'}</div>}
      <footer><button type="button" onClick={() => onSelect(null)}>清空槽位</button><button type="button" onClick={onClose}>取消</button></footer>
    </div>
  </div>;
}
