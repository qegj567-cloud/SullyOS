import React, { useRef, useState } from 'react';
import type { CallRolePlacement } from '../../types';
import { transformAroundFingers, type CameraPoint } from '../../utils/cameraStickerGesture';
import { DEFAULT_PLACEMENT, normalizePlacement, OFFSET_LIMIT, SCALE_MIN, SCALE_MAX } from '../../utils/callRolePlacement';
import { trackEvent } from '../../utils/analytics';
import './rolePlacement.css';

export interface RolePlacementControl {
  value: CallRolePlacement;
  save(value: CallRolePlacement): void;
}

function commit(control: RolePlacementControl, draft: CallRolePlacement) {
  const value = normalizePlacement(draft);
  const previous = control.value;
  if (value.x === previous.x && value.y === previous.y && value.angle === previous.angle && value.scale === previous.scale) return;
  control.save(value);
  trackEvent('调整角色构图');
}

// Portrait taps finish on pointerup, before the corresponding touchend.
export const RolePlacementTouchLock = React.createContext<React.RefObject<boolean> | null>(null);

type Pair = {
  ids: number[];
  points: CameraPoint[];
  pivot: CameraPoint;
  width: number;
  height: number;
  initial: CallRolePlacement;
};

/** The touch surface stays fixed while only its character layer moves. */
export function RolePlacementLayer({ control, children, className = '', view, label }: {
  control: RolePlacementControl; children: React.ReactNode; className?: string; view?: string; label?: string;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const pair = useRef<Pair>();
  const latest = useRef<CallRolePlacement>();
  const multiTouch = useRef(false);
  const [draft, setDraft] = useState<CallRolePlacement>();
  const value = draft ?? control.value;
  const cancel = () => { pair.current = undefined; latest.current = undefined; setDraft(undefined); };
  const sceneTouches = (event: React.TouchEvent<HTMLDivElement>) => Array.from(event.touches).filter(touch =>
    touch.target instanceof Element && event.currentTarget.contains(touch.target) && !touch.target.closest('button,input,select,summary,a'));
  const begin = (event: React.TouchEvent<HTMLDivElement>) => {
    if (pair.current || !layer.current) return;
    const touches = sceneTouches(event);
    if (touches.length === 1) multiTouch.current = false;
    if (touches.length !== 2) return;
    multiTouch.current = true;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const item = layer.current;
    pair.current = {
      ids: touches.map(t => t.identifier), points: touches.map(t => ({ x: t.clientX, y: t.clientY })),
      pivot: { x: rect.left + item.offsetLeft + item.offsetWidth / 2 + value.x * rect.width / 100,
        y: rect.top + item.offsetTop + item.offsetHeight / 2 + value.y * rect.height / 100 },
      initial: value, width: rect.width, height: rect.height,
    };
  };
  const move = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = pair.current;
    if (!start) return;
    const touches = Array.from(event.touches);
    const [a, b] = start.ids.map(id => touches.find(t => t.identifier === id));
    if (!a || !b) return;
    const points = [a, b].map(t => ({ x: t.clientX, y: t.clientY }));
    const result = transformAroundFingers(start.points, points, start.pivot, start.initial.scale, start.initial.angle, SCALE_MIN, SCALE_MAX);
    if (!result) {
      if (Math.hypot(start.points[0].x - start.points[1].x, start.points[0].y - start.points[1].y) < 2) start.points = points;
      return;
    }
    const next = normalizePlacement({ scale: result.size, angle: result.angle,
      x: start.initial.x + (result.x - start.pivot.x) * 100 / start.width,
      y: start.initial.y + (result.y - start.pivot.y) * 100 / start.height });
    latest.current = next;
    setDraft(next);
  };
  const end = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = pair.current;
    if (!start || !Array.from(event.changedTouches).some(t => start.ids.includes(t.identifier))) return;
    if (latest.current) commit(control, latest.current);
    cancel();
  };
  return <div className="call-placement-host" onTouchStartCapture={begin} onTouchMoveCapture={move} onTouchEndCapture={end} onTouchCancelCapture={cancel}>
    <div className={'call-placement-content ' + className} data-view={view} aria-label={label} ref={layer}
      style={{ transform: `translate(${value.x}cqw, ${value.y}cqh) rotate(${value.angle}deg) scale(${value.scale})` }}>
      <RolePlacementTouchLock.Provider value={multiTouch}>{children}</RolePlacementTouchLock.Provider>
    </div>
  </div>;
}

const fields = [
  { key: 'scale', label: '大小', unit: '%', factor: 100, min: SCALE_MIN * 100, max: SCALE_MAX * 100 },
  { key: 'x', label: '水平位置', unit: '%', factor: 1, min: -OFFSET_LIMIT, max: OFFSET_LIMIT },
  { key: 'y', label: '垂直位置', unit: '%', factor: 1, min: -OFFSET_LIMIT, max: OFFSET_LIMIT },
  { key: 'angle', label: '旋转', unit: '°', factor: 1, min: -180, max: 180 },
] as const;

export function RolePlacementSettings({ control, expanded }: { control: RolePlacementControl; expanded?: boolean }) {
  const [draft, setDraft] = useState<CallRolePlacement>();
  const value = draft ?? control.value;
  return <details className="call-placement-settings" open={expanded || undefined} onToggle={event => {
    if (event.currentTarget.open) trackEvent('打开角色构图');
    else setDraft(undefined);
  }}>
    <summary>角色构图</summary>
    <p>两指一起移动角色，捏合调大小，转动调角度。</p>
    {fields.map(field => {
      const current = Math.round(value[field.key] * field.factor);
      return <label key={field.key}><span>{field.label}</span><input type="range" min={field.min} max={field.max} step="1"
        aria-label={field.label} aria-valuetext={current + field.unit} value={current}
        onChange={event => setDraft({ ...value, [field.key]: Number(event.target.value) / field.factor })}/>
        <output>{current}{field.unit}</output></label>;
    })}
    <div className="call-placement-buttons"><button type="button" onClick={() => { commit(control, DEFAULT_PLACEMENT); setDraft(undefined); }}>恢复默认</button>
      <button type="button" disabled={!draft} onClick={() => { commit(control, value); setDraft(undefined); }}>应用</button></div>
  </details>;
}
