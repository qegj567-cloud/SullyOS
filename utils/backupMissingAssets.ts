import type { ZipFileWriter } from './backupFormat';

export interface BackupMissingAsset {
    id: string;
    /** 最多保留五处引用，不保留聊天正文、配置值或图片内容。 */
    locations: string[];
    moreLocations?: boolean;
}

export interface BackupExportOptions {
    includeBackendConnection?: boolean;
    userScope?: 'current' | 'all';
    onMissingAssets?: (items: BackupMissingAsset[]) => void;
}

const names: Record<string, string> = {
    characters: '角色', user_profile: '个人档案', messages: '聊天记录', themes: '聊天装扮',
    emojis: '表情包', gallery: '相册', journal_stickers: '日记贴纸', cc_custom_parts: '捏人自绘部件',
    assets: '应用素材', collab_assets: '协同工作附件', collab_messages: '协同工作消息',
    daily_schedule: '日程', bank_data: '银行', local: '本地设置',
    avatar: '头像', perCharAvatars: '角色专属用户头像', sprites: '立绘', chibi: 'Chibi',
    chibiStudio: '手办柜', home3D: '3D 家园', vrState: '彼方', like520: '520 形象', room: '小小窝', vr: '彼方形象',
    image: '图片', img: '图片', images: '图片', thumbnail: '缩略图', coverImage: '封面',
    wallpaper: '壁纸', backgroundImage: '背景图', background: '背景', dateBackground: '见面背景',
    companionBackground: '陪伴背景', companionAvatar: '陪伴形象', videoAvatar: '视频模型',
    videoAvatarWardrobe: '视频模型衣柜', chatTheme: '聊天装扮', chatBackground: '聊天背景',
    customCss: '自定义样式', customIcons: '自定义图标', os_theme: '桌面外观',
    cameraSnapshotRef: '聊天拍照', metadata: '附加信息', content: '内容', data: '数据', assetId: '素材文件',
};
const shortLabel = (value: unknown) => String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 100);
export const backupAssetField = (key: string): string => Object.prototype.hasOwnProperty.call(names, key) ? names[key] : shortLabel(key);

export function backupAssetSource(spaceName: string, store: string, row?: any, characterNames: ReadonlyMap<string, string> = new Map()): string {
    const parts = [`用户「${shortLabel(spaceName)}」`, backupAssetField(store)];
    const character = row?.charId && characterNames.get(row.charId);
    if (character) parts.push(`角色「${shortLabel(character)}」`);
    if (row) {
        if (store === 'messages' && typeof row.timestamp === 'number' && Number.isFinite(new Date(row.timestamp).getTime())) {
            // 这是用户设备中的真实记录时间，与角色设定的时区无关。
            parts.push(new Date(row.timestamp).toLocaleString());
        }
        let name = row.name;
        if (store === 'assets' && typeof row.id === 'string' && row.id.startsWith('appearance_preset_')) {
            parts.push('外观预设');
            try { name = JSON.parse(row.data)?.name; } catch { /* 保留记录编号 */ }
        }
        if (name) parts.push(`「${shortLabel(name)}」`);
        if (row.id !== undefined) parts.push(`记录 ${shortLabel(row.id)}`);
    }
    return parts.join(' → ');
}

export function recordMissingBackupAsset(items: Map<string, BackupMissingAsset>, id: string, location?: string): void {
    const item = items.get(id) || { id, locations: [] };
    if (location && !item.locations.includes(location)) {
        if (item.locations.length < 5) item.locations.push(location);
        else item.moreLocations = true;
    }
    items.set(id, item);
}

export const missingBackupAssetsSummary = (items: readonly BackupMissingAsset[]): string =>
    `备份已生成，但有 ${items.length} 份素材原文件缺失；其余数据已打包，缺失项见包内「缺失素材清单.txt」。`;

export function writeMissingBackupAssets(zip: ZipFileWriter, items: readonly BackupMissingAsset[]): void {
    if (!items.length) return;
    zip.file('diagnostics/missing-assets.json', JSON.stringify({ version: 1, items }, null, 2));
    zip.file('缺失素材清单.txt', [
        missingBackupAssetsSummary(items),
        '原存档与素材引用未修改。缺失的文件无法从这份备份还原，可从原图或较早的完整备份补回。',
        ...items.map(item => `\n素材：${item.id}\n${item.locations.length ? item.locations.map(location => `  ${location}`).join('\n') : '  此导出路径未记录具体位置'}${item.moreLocations ? '\n  另有其他引用（最多列出五处）' : ''}`),
    ].join('\n'));
}
