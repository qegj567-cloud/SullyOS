import React, {createContext, useContext, useLayoutEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import type {CharacterProfile, ChatTheme} from '../../types';
import type {DecorationOrigin} from '../../utils/decorationLibrary';
import type {DecorationPreset} from '../../utils/chatDecoration';
import {useLocalBackHandler} from '../../hooks/useLocalBackHandler';

export interface ChatDecorationTrial {
  characterId: string;
  patch: Partial<CharacterProfile>;
  bubble?: ChatTheme;
  showProfile: boolean;
  commit: () => Promise<void>;
}

export const DecorationTrialContext = createContext<{
  active: boolean;
  start: (preset: DecorationPreset, origin: DecorationOrigin, beforeCommit?: () => Promise<void>) => Promise<void>;
} | null>(null);

// Temporarily release the modal top layer while keeping the detail and its scroll position mounted.
export function useWardrobeDetailDialog() {
  const trial = useContext(DecorationTrialContext);
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!trial?.active) element?.showModal();
    return () => element?.close();
  }, [trial?.active]);
  return {trial, dialog};
}

export function ChatTrialControls({onReturn, onUse, onScroll}: {
  onReturn: () => void; onUse: () => Promise<void>; onScroll: (pixels: number) => void;
}) {
  const [root, setRoot] = useState<ShadowRoot | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const touchY = useRef(0);
  const cancel = () => { if (!locked.current) onReturn(); };
  useLocalBackHandler(() => { cancel(); return true; }, 100);
  useLayoutEffect(() => {
    const host = document.createElement('div');
    host.style.setProperty('all', 'initial', 'important');
    document.documentElement.append(host);
    setRoot(host.attachShadow({mode: 'open'}));
    return () => host.remove();
  }, []);
  useLayoutEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, [root]);
  const use = async () => {
    if (locked.current) return;
    locked.current = true; setSaving(true); setError('');
    try { await onUse(); }
    catch (e) { setError(e instanceof Error ? e.message : '应用失败，请重试'); }
    finally { locked.current = false; setSaving(false); }
  };
  return root && createPortal(<>
    <style>{`
      dialog { position:fixed; inset:0; margin:auto; width:max-content; max-width:min(85vw,320px); height:fit-content;
        box-sizing:border-box; padding:12px 16px; border:1px solid #ddd; border-radius:16px; background:#fff;
        color:#222; font:14px/1.4 system-ui,sans-serif; color-scheme:light; text-align:center; box-shadow:0 4px 24px #0003; }
      dialog::backdrop { background:transparent; touch-action:none; }
      strong { display:block; margin-bottom:8px; }
      button { font:inherit; padding:6px 14px; min-height:36px; border:0; border-radius:10px; background:#eee; color:#222; }
      button + button { margin-left:8px; background:#272727; color:white; }
      p { margin:6px 0; overflow-wrap:anywhere; color:#942d28; }
    `}</style>
    <dialog ref={dialog} aria-label="聊天装扮试用" onCancel={e=>{e.preventDefault();cancel();}}
      onWheel={e=>onScroll(e.deltaY)} onTouchStart={e=>{touchY.current=e.touches[0].clientY;}}
      onTouchMove={e=>{const y=e.touches[0].clientY;onScroll(touchY.current-y);touchY.current=y;}}>
      <strong role="status">试用中…</strong>
      {error && <p role="alert">{error}</p>}
      <button type="button" disabled={saving} onClick={cancel}>返回</button>
      <button type="button" disabled={saving} onClick={()=>void use()}>{saving?'应用中…':'使用'}</button>
    </dialog>
  </>, root);
}
