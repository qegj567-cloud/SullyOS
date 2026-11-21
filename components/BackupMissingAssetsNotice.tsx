import React, { useEffect, useState } from 'react';
import { damagedBackupAssetsSummary, missingBackupAssetsSummary, type BackupMissingAsset } from '../utils/backupMissingAssets';
import { readRestoreDamagedAssets, clearRestoreDamagedAssets } from '../utils/backupImportPolicy';

/** export：导出时原文件缺失；restore：恢复时备份包里的文件已损坏、被跳过。total 是实际份数，items 只带了一部分时传。 */
export function BackupMissingAssetsNotice({ items, context = 'export', total = items.length }: { items: readonly BackupMissingAsset[]; context?: 'export' | 'restore'; total?: number }) {
    if (!items.length) return null;
    const restore = context === 'restore';
    return <div role="status" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 select-text">
        <p className="font-bold">{restore ? damagedBackupAssetsSummary(items, total) : missingBackupAssetsSummary(items)}</p>
        <p className="mt-2 leading-relaxed">{restore
            ? '这几份文件在备份里本身就已损坏，不是这次恢复弄坏的。如果有更早的完整备份，可以从那里找回这些图片。'
            : '原存档未修改。缺失文件无法从这份备份恢复，请保留原图或较早的完整备份。'}</p>
        <details className="mt-2">
            <summary className="cursor-pointer">{restore ? '查看跳过的素材' : '查看缺失素材及位置'}</summary>
            <ul className="mt-2 max-h-64 overflow-y-auto space-y-3 break-words">
                {items.slice(0, 20).map(item => <li key={item.id}>
                    <span className="font-mono">{item.id}</span>{item.reason === 'damaged' && '（文件损坏）'}
                    {item.locations.map(location => <p key={location} className="mt-1">{location}</p>)}
                    {!item.locations.length && !restore && <p>此导出路径未记录具体位置</p>}
                    {item.moreLocations && <p>另有其他引用，最多列出五处。</p>}
                </li>)}
            </ul>
            {total > 20 && <p className="mt-2">{restore ? '此处显示前 20 份。' : '此处显示前 20 份，完整清单在备份包内。'}</p>}
        </details>
    </div>;
}

/**
 * 启动后的「恢复完成」提示：上次恢复跳过了备份包里已损坏的素材。恢复写完库立刻刷新页面，清单存在本机，
 * 这里读到就弹一次，弹出即清掉。blocked 期间（免责声明、导入中断提示还开着）先不弹。
 */
export function RestoreDamagedAssetsStartupNotice({ blocked }: { blocked: boolean }) {
    const [damaged, setDamaged] = useState(() => readRestoreDamagedAssets());
    const visible = !blocked && !!damaged;
    useEffect(() => {
        if (visible) clearRestoreDamagedAssets();
    }, [visible]);
    if (!visible) return null;
    return <div className="fixed inset-0 z-[9999] flex items-center justify-center p-5 animate-fade-in" role="dialog" aria-label="恢复完成">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-md" />
        <div className="relative w-full max-w-sm bg-white/95 backdrop-blur-xl rounded-[2.5rem] shadow-2xl border border-white/30 overflow-hidden animate-slide-up">
            <div className="pt-7 pb-3 px-6 text-center">
                <h2 className="text-lg font-extrabold text-slate-800">恢复完成</h2>
            </div>
            <div className="px-6 max-h-[58vh] overflow-y-auto no-scrollbar text-left">
                <BackupMissingAssetsNotice items={damaged.items} total={damaged.total} context="restore" />
            </div>
            <div className="px-6 pb-7 pt-2">
                <button onClick={() => setDamaged(null)} className="w-full py-3 bg-slate-100 text-slate-600 font-bold rounded-2xl active:scale-95 transition-transform text-sm">知道了</button>
            </div>
        </div>
    </div>;
}
