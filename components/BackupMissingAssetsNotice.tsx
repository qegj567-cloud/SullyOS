import React from 'react';
import { missingBackupAssetsSummary, type BackupMissingAsset } from '../utils/backupMissingAssets';

export function BackupMissingAssetsNotice({ items }: { items: readonly BackupMissingAsset[] }) {
    if (!items.length) return null;
    return <div role="status" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 select-text">
        <p className="font-bold">{missingBackupAssetsSummary(items)}</p>
        <p className="mt-2 leading-relaxed">原存档未修改。缺失文件无法从这份备份恢复，请保留原图或较早的完整备份。</p>
        <details className="mt-2">
            <summary className="cursor-pointer">查看缺失素材及位置</summary>
            <ul className="mt-2 max-h-64 overflow-y-auto space-y-3 break-words">
                {items.slice(0, 20).map(item => <li key={item.id}>
                    <span className="font-mono">{item.id}</span>
                    {item.locations.map(location => <p key={location} className="mt-1">{location}</p>)}
                    {!item.locations.length && <p>此导出路径未记录具体位置</p>}
                    {item.moreLocations && <p>另有其他引用，最多列出五处。</p>}
                </li>)}
            </ul>
            {items.length > 20 && <p className="mt-2">此处显示前 20 份，完整清单在备份包内。</p>}
        </details>
    </div>;
}
