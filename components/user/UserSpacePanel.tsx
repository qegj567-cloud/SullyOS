import React, { useState } from 'react';
import { useOS } from '../../context/OSContext';
import { listUserSpaces, SESSION_SPACE_ID, saveUserSpaces, isUserSpaceDeleting, type UserSpace } from '../../utils/userSpaces';
import { createUserSpace, switchUserSpace, persistSpaceCatalog } from '../../utils/userSpaceData';
import UserSpaceDeleteDialog from './UserSpaceDeleteDialog';

export default function UserSpacePanel() {
    const { userProfile, addToast } = useOS();
    const [spaces, setSpaces] = useState(listUserSpaces);
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [managing, setManaging] = useState(false);
    const [deleting, setDeleting] = useState<UserSpace | null>(null);
    const run = async (action: () => Promise<void>) => {
        setBusy(true);
        try { await action(); } catch (e) { addToast(e instanceof Error ? e.message : '操作失败', 'error'); }
        finally { setBusy(false); }
    };
    return <section className="bg-white rounded-2xl p-5 border border-slate-100 space-y-3">
        <div className="flex items-center justify-between"><h2 className="font-bold text-sm text-slate-700">用户空间</h2><button disabled={busy} onClick={() => setManaging(!managing)} className="text-xs text-slate-400 py-1">{managing ? '完成' : '管理用户'}</button></div>
        <p className="text-xs text-slate-500 leading-relaxed">编辑资料会延续原有经历；另一个身份可以新建空间。角色和相处记录独立，系统设置共用。</p>
        <div className="flex flex-wrap gap-2">{spaces.map(space => <button key={space.id} disabled={busy || space.id === SESSION_SPACE_ID || isUserSpaceDeleting(space.id)}
            onClick={() => void run(async () => {
                saveUserSpaces(listUserSpaces().map(s => s.id === SESSION_SPACE_ID ? { ...s, name: userProfile.name || s.name } : s));
                await switchUserSpace(space.id);
            })}
            className={`px-3 py-2 rounded-xl text-xs ${space.id === SESSION_SPACE_ID ? 'bg-primary text-white' : 'bg-slate-100 text-slate-700'}`}>
            {space.id === SESSION_SPACE_ID ? userProfile.name || space.name : space.name}{space.id === SESSION_SPACE_ID ? ' · 当前' : isUserSpaceDeleting(space.id) ? ' · 待删除' : ''}</button>)}</div>
        {managing && <div className="space-y-2 border-t border-slate-100 pt-3">
            <p className="text-xs text-slate-400">至少保留一个用户。删除当前用户前，请先切换到另一个用户。</p>
            {spaces.filter(s => s.id !== SESSION_SPACE_ID).map(space => <div key={space.id} className="flex items-center justify-between gap-3 text-sm"><span className="truncate">{space.name}</span><button disabled={busy || spaces.length < 2} onClick={() => setDeleting(space)} className="shrink-0 text-xs text-red-500 py-2">{isUserSpaceDeleting(space.id) ? '继续删除' : '删除用户'}</button></div>)}
        </div>}
        <div className="flex gap-2"><input aria-label="新用户名称" value={name} onChange={e => setName(e.target.value)} maxLength={60} placeholder="新用户名称" className="min-w-0 flex-1 bg-slate-50 rounded-xl px-3 py-2 text-sm" />
            <button disabled={busy || !name.trim()} className="px-3 py-2 rounded-xl bg-slate-800 text-white text-xs disabled:opacity-40" onClick={() => void run(async () => {
                saveUserSpaces(listUserSpaces().map(s => s.id === SESSION_SPACE_ID ? { ...s, name: userProfile.name || s.name } : s));
                const created = await createUserSpace(name);
                setSpaces(listUserSpaces()); setName(''); await persistSpaceCatalog(); await switchUserSpace(created.id);
            })}>{busy ? '处理中…' : '新建并进入'}</button></div>
        <p className="text-[11px] text-slate-400">新空间没有角色，可在神经链接中创建、导入或继承。切换前请先结束正在进行的对话。</p>
        {deleting && <UserSpaceDeleteDialog key={deleting.id} space={deleting} onClose={() => { setDeleting(null); setSpaces(listUserSpaces()); }} onDeleted={result => {
            setDeleting(null); setSpaces(listUserSpaces());
            addToast(result.cloudPending ? '用户已删除，云端正在继续清理' : '用户及其存档已删除', 'success');
            if (result.assetsRetained) addToast('部分闲置素材暂时保留，未影响用户数据清理', 'info');
        }} />}
    </section>;
}
