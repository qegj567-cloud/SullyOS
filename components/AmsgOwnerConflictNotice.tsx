import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../context/OSContext';
import Modal from './os/Modal';
import ConfirmDialog from './os/ConfirmDialog';
import { flushAmsgState, markAmsgStateDirty, syncAmsgLlmCredentials } from '../utils/amsgStateSync';
import {
  AMSG_OWNER_CHECK_AFTER_IMPORT_LS_KEY,
  AMSG_OWNER_CONFLICT_EVENT,
  findCloudOwnerConflicts,
  keepUsingCloudOwners,
  type CloudOwnerConflict,
} from '../utils/amsgOwnerReconcile';

/** 启动后稍等再查，别跟开机那一波请求抢。 */
const STARTUP_CHECK_DELAY_MS = 3000;

const takeImportMark = (): boolean => {
  try {
    const marked = localStorage.getItem(AMSG_OWNER_CHECK_AFTER_IMPORT_LS_KEY) === '1';
    localStorage.removeItem(AMSG_OWNER_CHECK_AFTER_IMPORT_LS_KEY);
    return marked;
  } catch { return false; }
};

/** 本地角色在云端已停用（或代次对不上）时，让用户选「继续使用」还是「删除本机」。 */
export default function AmsgOwnerConflictNotice() {
  const { characters, isDataLoaded, deleteCharacter, addToast, apiConfig, realtimeConfig, userProfile, groups } = useOS();
  const [conflicts, setConflicts] = useState<CloudOwnerConflict[]>([]);
  const [fromImport, setFromImport] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<CloudOwnerConflict | null>(null);
  const latest = useRef({ characters, apiConfig, realtimeConfig, userProfile, groups });
  latest.current = { characters, apiConfig, realtimeConfig, userProfile, groups };
  const checking = useRef(false);

  const check = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      const found = await findCloudOwnerConflicts(latest.current.characters);
      setConflicts(found);
      setError('');
    } catch (err) {
      console.warn('[amsg2] 角色云端状态对账失败（下次启动再查）', err);
    } finally {
      checking.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isDataLoaded) return;
    setFromImport(takeImportMark());
    const timer = setTimeout(() => { void check(); }, STARTUP_CHECK_DELAY_MS);
    const onConflict = () => { void check(); };
    window.addEventListener(AMSG_OWNER_CONFLICT_EVENT, onConflict);
    return () => { clearTimeout(timer); window.removeEventListener(AMSG_OWNER_CONFLICT_EVENT, onConflict); };
  }, [isDataLoaded, check]);

  const settle = (id: string) => setConflicts(prev => prev.filter(item => item.id !== id));

  const keepUsing = async (conflict: CloudOwnerConflict) => {
    setBusyId(conflict.id); setError('');
    try {
      const { failed } = await keepUsingCloudOwners([conflict]);
      if (failed.length) { setError(`「${conflict.name}」没能恢复：${failed[0].detail}`); return; }
      // 恢复后云端那份快照和凭据都是空的，按本地重新传一遍。
      const { characters: chars, apiConfig: api, realtimeConfig: realtime, userProfile: user, groups: groupList } = latest.current;
      const char = chars.find(item => item.id === conflict.id);
      if (char) markAmsgStateDirty({ char, userProfile: user, groups: groupList, realtimeConfig: realtime });
      void flushAmsgState('owner-restored');
      syncAmsgLlmCredentials(api);
      settle(conflict.id);
      addToast(conflict.retired
        ? `「${conflict.name}」已在云端恢复。之前排的主动消息不会回来，需要的话重新设置`
        : `「${conflict.name}」已在本机接入云端`, 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const deleteLocal = async (conflict: CloudOwnerConflict) => {
    setConfirmDelete(null); setBusyId(conflict.id); setError('');
    try {
      // 云端已经停用，停用屏障在；云端善后成不成功都不该拦住本地删除。
      await deleteCharacter(conflict.id, { force: true });
      settle(conflict.id);
      addToast(`已删除本机的「${conflict.name}」`, 'info');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  if (conflicts.length === 0) return null;
  const busy = busyId !== null;
  const intro = fromImport
    ? '导入的备份里有这些角色，但它们之前在云端被删除过。要继续用主动消息，需要在云端恢复。'
    : '这些角色可能在另一台设备上被删除或恢复过，也可能是从旧备份导入回来的。处理好之前，它们的主动消息用不了。';

  return createPortal(
    <>
      <Modal
        isOpen={!confirmDelete}
        title="角色的云端状态对不上"
        onClose={() => { if (!busy) setConflicts([]); }}
        footer={<button type="button" disabled={busy} onClick={() => setConflicts([])} className="w-full py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform disabled:opacity-50">以后再说</button>}
      >
        <div className="space-y-3 text-sm text-slate-600 leading-relaxed">
          <p>{intro}</p>
          {conflicts.map(conflict => (
            <div key={conflict.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-3 space-y-2">
              <p className="font-bold text-slate-800 break-all">{conflict.name}</p>
              <p className="text-xs text-slate-500">{conflict.retired ? '云端已停用' : '在别的设备上恢复过，本机还没接入'}</p>
              <div className="flex gap-2">
                <button type="button" disabled={busy} onClick={() => void keepUsing(conflict)} className="flex-1 py-2 rounded-xl bg-indigo-500 text-white font-bold disabled:opacity-50">
                  {busyId === conflict.id ? '处理中…' : conflict.retired ? '继续使用' : '在本机接入'}
                </button>
                {conflict.retired && (
                  <button type="button" disabled={busy} onClick={() => setConfirmDelete(conflict)} className="flex-1 py-2 rounded-xl bg-white border border-red-200 text-red-500 font-bold disabled:opacity-50">
                    删除本机
                  </button>
                )}
              </div>
            </div>
          ))}
          {error && <p role="alert" className="text-red-500 text-xs">{error}</p>}
        </div>
      </Modal>
      <ConfirmDialog
        isOpen={!!confirmDelete}
        title={`删除本机的「${confirmDelete?.name ?? ''}」？`}
        message="会删除这台设备上 ta 的聊天记录、记忆和设置，删除后无法恢复。"
        confirmText="删除"
        variant="danger"
        onConfirm={() => { if (confirmDelete) void deleteLocal(confirmDelete); }}
        onCancel={() => setConfirmDelete(null)}
      />
    </>,
    document.body,
  );
}
