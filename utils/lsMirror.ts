/**
 * 关键 localStorage 键的 IndexedDB 镜像（防浏览器"清 localStorage 但留 IndexedDB"式驱逐）。
 *
 * 背景：有用户遇到「主题回初始 + 梦境盲盒收藏册清空 + 小窝『更新这一天』点了没反应」
 * 三连——三个症状对应的持久化恰好全在 localStorage（os_theme / os_dream_collection /
 * os_api_config），而角色、聊天记录（IndexedDB）完好。部分移动端浏览器/系统清理工具
 * 会只清 WebView 的 localStorage 而留下 IndexedDB，重新导入云备份后一切恢复也与此吻合。
 *
 * 方案：把「备份体系里也会带走的那批小体积配置键」定期快照进 IndexedDB assets 表；
 * 启动时若发现某键在 localStorage 里缺失而镜像里有，就回填。真值仍是 localStorage，
 * 镜像只在"丢了"的时候兜底——localStorage 里已有的值永远优先，不会被镜像覆盖。
 *
 * 注意 removeItem 语义：个别键（如 study_api_config）以"删除 = 恢复默认"为语义，
 * 所以镜像必须靠频繁快照（启动后 / 页面隐藏 / pagehide / 定时）及时把删除同步进去，
 * 避免启动回填把用户已删除的配置复活。实际的复活窗口 ≈ "删完立刻杀进程且没触发过
 * 一次 pagehide"，可以接受。
 */

import { DB } from './db';

/**
 * 参与镜像的键。收录标准：用户手动配置或长期积累、丢了没法凭空再生、体积是小段
 * JSON/字符串（严禁 data URI 等大体积——那些本来就该走 assets/blob 存储）。
 * 这份名单与「设置 → 导出备份」带走的 localStorage 键保持同一批（见 OSContext
 * exportFullData / importFullData），新增备份键时记得两边同步。
 */
export const MIRRORED_KEYS: readonly string[] = [
    'os_theme',                          // 外观主题（丢了 = 回初始主题）
    'os_api_config',                     // 全局 API（丢了 = 一切生成静默失效）
    'os_api_presets',
    'os_realtime_config',
    'os_memory_palace_config',
    'os_remote_vector_config',
    'os_cloud_backup_config',            // 丢了连"从云端恢复"都要重新配
    'os_dream_collection',               // 梦境盲盒收藏册（账号级图鉴，纯积累不可再生）
    'world_home_api',                    // 家园全局 API 覆盖
    'study_api_config',
    'study_tutor_presets',
    'instant_push_config_v1',
    'push_vapid_v1',                     // VAPID 密钥对，须与浏览器既有推送订阅匹配
    'chat_archive_prompts',
    'chat_active_archive_prompt_id',
    'character_refine_prompts',
    'character_active_refine_prompt_id',
    'os_last_active_char_id',
    // 微信读书 (weread skill) 配置
    'weread_enabled',
    'weread_mode',
    'weread_apikey',
    'weread_cookie',
    'weread_cookie_cloud',
    'weread_server_url',
];

const MIRROR_ASSET_ID = 'ls_mirror_v1';
const SNAPSHOT_INTERVAL_MS = 5 * 60_000;

type MirrorPayload = { savedAt: number; data: Record<string, string> };

/**
 * 启动回填：镜像里有、localStorage 里没有的键写回 localStorage。
 * 返回被回填的键名（空数组 = localStorage 完好或没有镜像）。
 * 必须在任何读 localStorage 的初始化逻辑（OSContext.loadSettings 等）之前 await。
 */
export async function healLocalStorageMirror(): Promise<string[]> {
    let payload: MirrorPayload | null = null;
    try {
        payload = await DB.getAssetRaw(MIRROR_ASSET_ID);
    } catch {
        return [];
    }
    const data = payload?.data;
    if (!data || typeof data !== 'object') return [];

    const restored: string[] = [];
    for (const key of MIRRORED_KEYS) {
        const v = data[key];
        if (typeof v !== 'string') continue;
        try {
            if (localStorage.getItem(key) === null) {
                localStorage.setItem(key, v);
                restored.push(key);
            }
        } catch {
            // quota 满 / 私有模式写不进：兜底失败就算了，不能让启动流程挂掉
        }
    }
    return restored;
}

/** 把当前 localStorage 里的镜像键快照进 IndexedDB。全部缺失时不写（避免拿空快照覆盖有效镜像）。 */
export async function snapshotLocalStorageMirror(): Promise<void> {
    const data: Record<string, string> = {};
    for (const key of MIRRORED_KEYS) {
        try {
            const v = localStorage.getItem(key);
            if (v !== null) data[key] = v;
        } catch { /* ignore */ }
    }
    if (Object.keys(data).length === 0) return;
    try {
        await DB.saveAssetRaw(MIRROR_ASSET_ID, { savedAt: Date.now(), data } satisfies MirrorPayload);
    } catch { /* 镜像写失败不影响主流程 */ }
}

let listenersAttached = false;

/**
 * 应用启动时调一次：先回填、再拍一张新快照，并挂上"页面隐藏 / 关闭 / 定时"的快照钩子。
 * 返回回填的键名，调用方可据此提示用户"本地设置曾丢失，已自动恢复"。
 */
export async function initLocalStorageMirror(): Promise<string[]> {
    const restored = await healLocalStorageMirror();
    await snapshotLocalStorageMirror();

    if (!listenersAttached && typeof window !== 'undefined' && typeof document !== 'undefined') {
        listenersAttached = true;
        const snap = () => { void snapshotLocalStorageMirror(); };
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') snap();
        });
        window.addEventListener('pagehide', snap);
        setInterval(snap, SNAPSHOT_INTERVAL_MS);
    }
    return restored;
}
