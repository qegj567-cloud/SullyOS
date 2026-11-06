import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useOS } from '../../context/OSContext';
import { SESSION_SPACE_ID } from '../../utils/userSpaces';
import { saveUserLocationConfig } from '../../utils/userLocation';
import { loadUserLocationConfig } from '../../utils/userLocationPrivacy';
import { loadMcpServers, saveMcpServers } from '../../utils/mcpClient';
import { useLocalBackHandler } from '../../hooks/useLocalBackHandler';

export default function UserSpaceNotice() {
    const { characters, groups, userProfile, realtimeConfig, updateRealtimeConfig, isDataLoaded, addToast } = useOS();
    const [pending, setPending] = useState(() => { try { return sessionStorage.getItem('sully_space_switch_notice') === SESSION_SPACE_ID; } catch { return false; } });
    const [ids, setIds] = useState<string[]>([]);
    const [cities, setCities] = useState<Record<string, string>>({});
    const [servers, setServers] = useState(loadMcpServers);
    const dismiss = () => { setPending(false); try { sessionStorage.removeItem('sully_space_switch_notice'); } catch { /* Session only. */ } };
    useLocalBackHandler(() => { dismiss(); return true; }, 70, pending && isDataLoaded);
    useEffect(() => {
        if (!isDataLoaded) return;
        try { setIds(loadUserLocationConfig().characterIds ?? characters.map(c => c.id)); } catch { setIds([]); }
        setCities(realtimeConfig.weatherCities || {});
    }, [isDataLoaded]);
    let location;
    try { location = loadUserLocationConfig(); } catch { location = undefined; }
    if (!pending || !isDataLoaded) return null;
    const needsSelection = characters.length > 0 && (location?.enabled || realtimeConfig.weatherEnabled)
        || characters.length + groups.length > 0 && servers.some(s => s.enabled);
    return createPortal(<div role="dialog" aria-modal="true" aria-label="用户空间感知设置" className="fixed inset-0 z-[250] bg-black/40 flex items-center justify-center p-5">
        <div className="bg-white rounded-2xl p-5 max-w-sm w-full space-y-3 max-h-[80vh] overflow-y-auto">
            <h2 className="font-bold">已切换为 {userProfile.name}</h2>
            <p className="text-sm text-slate-500">角色和记录已切换，系统设置不用重配。</p>
            {location?.enabled && characters.length > 0 && <><p className="text-sm font-medium">允许哪些角色感知你的位置？</p>{characters.map(c => <label key={c.id} className="flex gap-2 py-1 text-sm"><input type="checkbox" checked={ids.includes(c.id)} onChange={e => setIds(old => e.target.checked ? [...old, c.id] : old.filter(id => id !== c.id))} />{c.name}</label>)}<p className="text-xs text-slate-400">未选择时，所有角色都看不到位置。</p></>}
            {realtimeConfig.weatherEnabled && characters.length > 0 && <details><summary className="text-sm">角色天气城市</summary>{characters.map(c => <label key={c.id} className="block text-xs my-2">{c.name}<input aria-label={`${c.name}的天气城市`} className="w-full border rounded-lg p-2 mt-1" value={cities[c.id] || ''} placeholder={realtimeConfig.weatherCity || '沿用系统城市'} onChange={e => setCities(old => ({ ...old, [c.id]: e.target.value }))} /></label>)}</details>}
            {servers.filter(s => s.enabled && characters.length + groups.length > 0).map(server => <details key={server.id}><summary className="text-sm">工具：{server.name}</summary>
                <p className="text-xs text-slate-400 my-2">选择可使用此工具的聊天；不选择则不可用。</p>
                {[...characters, ...groups].map(c => <label key={c.id} className="flex gap-2 py-1 text-xs"><input type="checkbox" checked={!server.charIds?.length || server.charIds.includes(c.id)} onChange={e => setServers(all => all.map(s => {
                    if (s.id !== server.id) return s;
                    const current = s.charIds?.length ? s.charIds.filter(id => id !== '__space_unselected__') : [...characters, ...groups].map(c => c.id);
                    const next = e.target.checked ? [...new Set([...current, c.id])] : current.filter(id => id !== c.id);
                    return { ...s, charIds: next.length ? next : ['__space_unselected__'] };
                }))} />{c.name}</label>)}
            </details>)}
            {!characters.length && <p className="text-xs text-slate-400">这里还没有角色，去神经链接添加吧。</p>}
            <button className="w-full bg-primary text-white py-2 rounded-xl" onClick={() => {
                if (!needsSelection) { dismiss(); return; }
                try {
                    if (location?.enabled) saveUserLocationConfig({ ...location, characterIds: ids.filter(id => characters.some(c => c.id === id)) });
                    if (realtimeConfig.weatherEnabled) updateRealtimeConfig({ weatherCities: cities });
                    saveMcpServers(loadMcpServers().map(s => ({ ...s, charIds: servers.find(own => own.id === s.id)?.charIds ?? s.charIds })));
                    dismiss();
                } catch (error) { addToast(error instanceof Error ? error.message : '选择未保存', 'error'); }
            }}>{needsSelection ? '保存并继续' : '知道了'}</button>
            {needsSelection && <button className="w-full text-xs text-slate-500 py-2" onClick={dismiss}>稍后设置</button>}
        </div>
    </div>, document.body);
}
