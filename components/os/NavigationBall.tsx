import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { NAVIGATION_SLOT_APPS, NAVIGATION_BALL_POSITION_KEY, subscribeNavigationBallPositionReset, useNavigationBallEnabled, useNavigationBallSlots, useNavigationPickerOpen } from '../../utils/navigationBall';
import { AppID } from '../../types';
import { Icons } from '../../constants';
import { ArrowUUpLeft, GearSix, House, PlugsConnected, Plus, SlidersHorizontal, X } from '@phosphor-icons/react';
import { requestSettingsFocus } from '../../utils/settingsNavigation';
import { describeNavigationShortcut, type NavigationShortcut, type ShortcutCharacter } from '../../utils/navigationShortcuts';
import { launchNavigationShortcut } from '../../utils/navigationShortcutLaunch';
import { clampBubblePos, resolveSafeTopInset } from '../../utils/floatingBallBounds';
import { isIOSStandaloneWebApp, readSafeAreaInsets } from '../../utils/iosStandalone';
import './NavigationBall.css';

const POSITION_KEY = NAVIGATION_BALL_POSITION_KEY;
const SIZE = 44;
type Position = { x: number; y: number };
function readPosition(): Position | null {
  try {
    const value = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) return value;
  } catch { /* Use the default position. */ }
  return null;
}
function measure(parent: HTMLElement) {
  const rect = parent.getBoundingClientRect(), style = getComputedStyle(parent), safe = readSafeAreaInsets();
  const top = resolveSafeTopInset({
    standaloneSafeTop: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--standalone-safe-area-top')) || 0,
    probedSafeTop: safe.top, isIOSStandalone: isIOSStandaloneWebApp(),
  });
  return { rect, bounds: { parentW: rect.width, parentH: rect.height, bubble: SIZE,
    insetTop: Math.max(parseFloat(style.paddingTop) || 0, top),
    insetBottom: Math.max(parseFloat(style.paddingBottom) || 0, safe.bottom) } };
}
type NavigationActions = {
  onBack: () => void; onHome: () => void; onApi: () => void;
  onShortcut: (shortcut: NavigationShortcut) => void; onConfigure: () => void;
  characters?: readonly ShortcutCharacter[];
};
export function DraggableNavigationBall({ onBack, onHome, onApi, onShortcut, onConfigure, characters = [] }: NavigationActions) {
  const slots = useNavigationBallSlots();
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position | null>(readPosition);
  const [open, setOpen] = useState(false);
  const [parentSize, setParentSize] = useState({ width: 0, height: 0, top: 0, bottom: 0 });
  const latest = useRef(position); latest.current = position;
  const suppressClick = useRef(false);
  const drag = useRef<{ pointerId: number; startX: number; startY: number; origin: Position;
    bounds: ReturnType<typeof measure>['bounds']; moved: boolean } | null>(null);
  useLayoutEffect(() => {
    const parent = root.current?.parentElement;
    if (!parent) return;
    const constrain = () => {
      const { bounds } = measure(parent);
      setParentSize({ width: bounds.parentW, height: bounds.parentH, top: bounds.insetTop, bottom: bounds.insetBottom });
      const value = latest.current || { x: bounds.parentW - SIZE - 12, y: bounds.parentH - SIZE - 96 };
      const next = clampBubblePos(value.x, value.y, bounds);
      latest.current = next; setPosition(next);
    };
    constrain();
    const unsubscribeReset = subscribeNavigationBallPositionReset(() => {
      drag.current = null; suppressClick.current = false; setOpen(false);
      latest.current = null; constrain();
    });
    const observer = new ResizeObserver(constrain); observer.observe(parent);
    return () => { observer.disconnect(); unsubscribeReset(); };
  }, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
  }, [open]);
  const finish = (event: React.PointerEvent<HTMLButtonElement>, cancelled = false) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    suppressClick.current = cancelled || drag.current.moved;
    if (drag.current.moved && latest.current) {
      try { localStorage.setItem(POSITION_KEY, JSON.stringify(latest.current)); } catch { /* Keep the current position. */ }
    }
    drag.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
  };
  const run = (action: () => void) => { setOpen(false); action(); };
  const panelWidth = Math.min(288, Math.max(144, parentSize.width - 24));
  const panelHeight = 288;
  const availableHeight = Math.max(44, parentSize.height - parentSize.top - parentSize.bottom - 24);
  const panelLeft = (parentSize.width - panelWidth) / 2 - (position?.x || 0);
  const panelTop = parentSize.top + 12 + Math.max(0, (availableHeight - panelHeight) / 2) - (position?.y || 0);
  const slotButton = (index: number) => {
    const shortcut = slots[index];
    const app = NAVIGATION_SLOT_APPS.find(item => item.id === shortcut?.appId);
    const label = describeNavigationShortcut(shortcut, characters);
    const Icon = app ? Icons[app.icon] || GearSix : Plus;
    return <button type="button" key={index} aria-label={app ? `打开${label.detail}` : `设置 App 槽位 ${index + 1}`} title={label.detail}
      onClick={() => run(() => shortcut ? onShortcut(shortcut) : onConfigure())}>
      <Icon className="navigation-ball-action-icon" /><span>{app ? label.name : `槽位 ${index + 1}`}
        {(shortcut?.characterId || shortcut?.worldId) && <small className="navigation-ball-target-kind">{label.detail.split(' › ').slice(0, -1).pop()}</small>}
      </span>
    </button>;
  };
  return <div ref={root} className="navigation-ball" style={position ? { left: position.x, top: position.y } : { right: 12, bottom: 96 }}>
    <button type="button" className="navigation-ball-toggle" aria-label="快捷导航悬浮球" aria-expanded={open}
      onPointerDown={event => {
        if (event.button !== 0 || !root.current?.parentElement || !latest.current) return;
        const { bounds } = measure(root.current.parentElement);
        suppressClick.current = false;
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: latest.current, bounds, moved: false };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* Pointer events remain usable. */ }
      }}
      onPointerMove={event => {
        const state = drag.current;
        if (!state || state.pointerId !== event.pointerId) return;
        const dx = event.clientX - state.startX, dy = event.clientY - state.startY;
        if (!state.moved && Math.hypot(dx, dy) <= 4) return;
        state.moved = true; setOpen(false);
        const next = clampBubblePos(state.origin.x + dx, state.origin.y + dy, state.bounds);
        latest.current = next; setPosition(next);
      }} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
      onClick={event => { if (event.detail !== 0 && suppressClick.current) { suppressClick.current = false; return; } setOpen(value => !value); }}>
      <span aria-hidden="true" />
    </button>
    {open && <div className="navigation-ball-panel" role="group" aria-label="快捷导航"
      style={{ left: panelLeft, top: panelTop, width: panelWidth, maxHeight: availableHeight, overflowY: 'auto' }}>
      {slotButton(0)}
      <button type="button" onClick={() => run(onApi)}><PlugsConnected className="navigation-ball-action-icon" /><span>API 配置</span></button>
      <button type="button" aria-label="返回上一级" onClick={() => run(onBack)}><ArrowUUpLeft className="navigation-ball-action-icon" /><span>上一级</span></button>
      {slotButton(1)}
      <button type="button" aria-label="回到桌面" onClick={() => run(onHome)}><House className="navigation-ball-action-icon" /><span>桌面</span></button>
      {slotButton(2)}
      {slotButton(3)}
      <button type="button" onClick={() => run(onConfigure)}><SlidersHorizontal className="navigation-ball-action-icon" /><span>自定义</span></button>
      <button type="button" onClick={() => setOpen(false)}><X className="navigation-ball-action-icon" /><span>收起</span></button>
    </div>}
  </div>;
}
export default function NavigationBall() {
  const enabled = useNavigationBallEnabled();
  const pickerOpen = useNavigationPickerOpen();
  const { isLocked, handleBack, closeApp, openApp, characters = [], setActiveCharacterId, addToast } = useOS();
  const openSettingsAt = (target: 'api' | 'navigation') => { requestSettingsFocus(target); openApp(AppID.Settings); };
  return enabled && !isLocked && !pickerOpen ? <DraggableNavigationBall onBack={handleBack} onHome={closeApp}
    onApi={() => openSettingsAt('api')} characters={characters}
    onShortcut={shortcut => launchNavigationShortcut(shortcut, { characters, openApp, setActiveCharacterId,
      onMissingTarget: () => { addToast('这个角色已不存在，请重新设置槽位', 'error'); openSettingsAt('navigation'); } })}
    onConfigure={() => openSettingsAt('navigation')} /> : null;
}
