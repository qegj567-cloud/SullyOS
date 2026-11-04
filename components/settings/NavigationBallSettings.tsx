import React, { useEffect, useId, useRef, useState } from 'react';
import { resetNavigationBallPosition, setNavigationBallEnabled, setNavigationBallSlot, useNavigationBallEnabled, useNavigationBallSlots } from '../../utils/navigationBall';
import { describeNavigationShortcut, type ShortcutCharacter, type ShortcutWorld, type ShortcutResources } from '../../utils/navigationShortcuts';
import { useSettingsFocus } from '../../utils/settingsNavigation';
import { useOS } from '../../context/OSContext';
import { AppID } from '../../types';
const NavigationSlotPicker = React.lazy(() => import('./NavigationSlotPicker'));
// Only mounted when a slot is being edited. Project titles, never message/book bodies.
function SlotPickerWithResources(props: React.ComponentProps<typeof NavigationSlotPicker>) {
  const { groups = [], novels = [], songs = [], worldbooks = [] } = useOS();
  const resources = React.useMemo(() => ({
    [AppID.GroupChat]: groups.map(item => ({ id: item.id, name: item.name })),
    [AppID.Novel]: novels.map(item => ({ id: item.id, name: item.title })),
    [AppID.Songwriting]: songs.map(item => ({ id: item.id, name: item.title })),
    [AppID.Worldbook]: worldbooks.map(item => ({ id: item.id, name: item.title })),
  }), [groups, novels, songs, worldbooks]);
  return <NavigationSlotPicker {...props} resources={props.resources || resources} />;
}
export default function NavigationBallSettings({ characters = [], loadWorlds, resources }: { characters?: readonly ShortcutCharacter[]; loadWorlds?: () => Promise<ShortcutWorld[]>; resources?: ShortcutResources }) {
  const enabled = useNavigationBallEnabled();
  const slots = useNavigationBallSlots();
  const section = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const contentId = useId();
  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [positionReset, setPositionReset] = useState(false);
  useSettingsFocus('navigation', () => { setExpanded(true); setFocusRequest(value => value + 1); });
  useEffect(() => {
    if (focusRequest) section.current?.scrollIntoView({ block: 'start' });
  }, [focusRequest]);
  return <section ref={section} className="bg-[#fffefe] rounded-3xl p-5 shadow-[0_8px_24px_rgba(15,23,42,0.05)] border border-slate-200/80">
    <button type="button" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}
      className={`flex items-center gap-2 w-full text-left ${expanded ? 'mb-4' : ''}`}>
      <div className="p-2 bg-slate-100 rounded-xl text-slate-600">
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} className="w-4 h-4">
          <rect x="3" y="3" width="18" height="18" rx="6" /><circle cx="12" cy="12" r="4" />
        </svg>
      </div>
      <h2 className="text-sm font-semibold text-slate-600 tracking-wider">悬浮球设置</h2>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}
        className={`w-3 h-3 text-slate-300 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
      </svg>
    </button>
    {expanded && <div id={contentId}>
    <div className="flex items-center justify-between gap-4">
      <div><h3 className="text-xs font-medium text-slate-600">开启快捷导航悬浮球</h3>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">拖动调整位置，点开可返回、回桌面或打开快捷入口。</p></div>
      <button type="button" role="switch" aria-label="开启快捷导航悬浮球" aria-checked={enabled}
        onClick={() => setNavigationBallEnabled(!enabled)}
        className={`h-7 w-12 shrink-0 rounded-full p-1 transition-colors ${enabled ? 'bg-primary' : 'bg-slate-200'}`}>
        <span className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${enabled ? 'translate-x-5' : ''}`} />
      </button>
    </div>
    <div className="mt-4 border-t border-slate-100 pt-4">
      <button type="button" onClick={() => { resetNavigationBallPosition(); setPositionReset(true); }}
        className="rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-medium text-slate-600 hover:bg-slate-200">悬浮球复位抢救</button>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400" role="status">{positionReset ? '位置已复位，开关和快捷入口均已保留。' : '找不到悬浮球或位置不顺手时，可恢复默认位置。快捷入口会保留。'}</p>
    </div>
    {enabled && <div className="mt-5 border-t border-slate-100 pt-4">
      <p className="mb-3 text-xs text-slate-500">自定义 App 槽位 · 仅保存在本机</p>
      {slots.map((shortcut, index) => {
        const label = describeNavigationShortcut(shortcut, characters);
        return <button type="button" key={index} aria-label={`配置悬浮球槽位 ${index + 1}`} onClick={() => setEditingSlot(index)}
          className="mb-2 flex w-full items-center gap-3 rounded-2xl bg-slate-50 px-3 py-3 text-left hover:bg-slate-100">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-white text-xs text-slate-400">{index + 1}</span>
          <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium text-slate-600">{label.name}</span><span className="mt-1 block truncate text-[10px] text-slate-400">{label.detail}</span></span>
          <span className="text-slate-400" aria-hidden="true">›</span>
        </button>;
      })}
    </div>}
    {editingSlot !== null && <React.Suspense fallback={<p role="status" className="mt-3 text-xs text-slate-400">正在打开入口选择…</p>}>
      <SlotPickerWithResources slot={editingSlot} characters={characters} loadWorlds={loadWorlds} resources={resources}
        onSelect={shortcut => { setNavigationBallSlot(editingSlot, shortcut); setEditingSlot(null); }} onClose={() => setEditingSlot(null)} />
    </React.Suspense>}
    </div>}
  </section>;
}
