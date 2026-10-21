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
import { HOME3D_LOCAL_KEYS } from './home3DBackup';
import { healAllMemoryPalaceHighWaterMarks } from './memoryPalace/highWaterMark';

/**
 * 参与镜像的键。收录标准：用户手动配置或长期积累、丢了没法凭空再生、体积是小段
 * JSON/字符串（严禁 data URI 等大体积——那些本来就该走 assets/blob 存储）。
 * 这份名单与「设置 → 导出备份」带走的 localStorage 键保持同一批（见 OSContext
 * exportFullData / importFullData），新增备份键时记得两边同步。
 */
export const MIRRORED_KEYS: readonly string[] = [
    ...HOME3D_LOCAL_KEYS,
    'sullyos_feedback_invitation_v1',     // 邀请资格/已显示状态；避免局部清理后重复提醒
    'os_theme',                          // 外观主题（丢了 = 回初始主题）
    'os_api_config',                     // 全局 API（丢了 = 一切生成静默失效）
    'os_available_models',               // 已拉取的模型列表
    'os_api_presets',
    'os_realtime_config',
    'os_memory_palace_config',
    'os_remote_vector_config',
    'os_cloud_backup_config',            // 丢了连"从云端恢复"都要重新配
    'os_dream_collection',               // 梦境盲盒收藏册（账号级图鉴，纯积累不可再生）
    'world_home_api',                    // 家园全局 API 覆盖
    'world_custom_styles',               // 家园自定义文风收藏
    'study_api_config',
    'study_tutor_presets',
    'check_phone_api',                   // 查手机独立 API
    'push_vapid_v1',                     // VAPID 密钥对，须与浏览器既有推送订阅匹配
    'chat_archive_prompts',
    'chat_active_archive_prompt_id',
    'character_refine_prompts',
    'character_active_refine_prompt_id',
    'os_last_active_char_id',
    // 悬浮球与快捷导航
    'sully_navigation_ball_enabled_v1',
    'sully_navigation_ball_slots_v1',
    'sully_navigation_ball_position_v1',
    // SAR 活动室存档与偏好（钓鱼/恐龙箱庭/NPC好感剧情/收藏册/芯片抽卡/模块商店/推演）
    'vr_fishing_market_v1',
    'vr_sar_club_v1',
    'vr_sar_gacha_v1',
    'vr_sar_module_shop_v1',
    'vr_sar_simulations_v1',
    'vr_fishing_simple_mode',
    'vr_sar_session_theme_v1',
    'sar-garden-guide-v1',
    'sar-facility-guide-water-v1',
    'sar-facility-guide-garden-v1',
    'sar-facility-guide-gacha-v1',
    'sar-facility-guide-simulation-v1',
    'sar-facility-guide-modules-v1',
    'sar-facility-guide-npc-v1',
    'sar-facility-guide-collection-v1',
    // 瑞幸 / 麦当劳 / 通用 MCP 配置
    'aetheros.luckin.mcpToken',
    'aetheros.luckin.mcpEnabled',
    'aetheros.mcd.mcpToken',
    'aetheros.mcd.mcpEnabled',
    'aetheros.mcp.servers',
    'aetheros.mcp.useNativeTools',
    // 音乐登录、播放队列与自创专辑
    'sully_music_cfg_v1',
    'sully_music_state_v1',
    'sully_music_local_album_v1',
    // 主动消息（旧版）与彼方/家园定时排程
    'proactive_schedules',
    'proactive_last_fire_map',
    'vr_schedules',
    'vr_last_fire_map',
    'world_home_schedules',
    'world_home_last_fire_map',
    // 彼方邮局身份与信号坠落处归属
    'vr_po_base',
    'vr_po_device',
    'signal_my_authorship',
    'signal_my_lines',
    'signal_notice_ack',
    // 网络代理、搜索与其它全局偏好
    'sully_proxy_worker_url',
    'browser_brave_key',
    'browser_use_real_search',
    'sully_firecrawl_api_key',
    'sullyos_chat_input_preferences_v1',
    'schedule_app_theme',
    'handbook_lifestream_depth',
    'groupchat_context_limit',
    'bm25_mode',
    'spark_char_handles',
    'spark_user_id',
    // 桌面皮肤与美化偏好/作者身份
    'companion_frame_style_v1',
    'companion_layout_v1',
    'tama_style_v2',
    'mg_style_v1',
    'tama_board_fg',
    'tama_accent_hue',
    'sully-beauty-author-identity-v1',
    'sully-beauty-usage-v1',
    'sully-beauty-repo-status-v1',
    'sully-beauty-author-defaults-v1',
    'sullyos_chat_wardrobe_update_v2_seen',
    'sullyos_chat_wardrobe_guide_v2_done',
    'sully-beauty-catalog-notice-v1',
    'sully-beauty-author-notice-v1',
    // 免责声明、引导与版本更新公告已读标记（防清 localStorage 后重弹历史更新队列）
    'sullyos_disclaimer_accepted',
    'os_first_use_memory_guide_v1',
    'sullyos_backup_reminder',
    'sullyos_anniversary_gift_v1',
    'sullyos_real_location_intro_v1_seen',
    'sullyos_navigation_ball_intro_v1_seen',
    'sullyos_update_2026_10_home3d_beta_seen',
    'sullyos_update_2026_09_small_updates_seen',
    'sullyos_user_holidays_intro_v1',
    'sullyos_update_2026_09_11_sar_seen',
    'sullyos_notice_2026_08_network_transit_seen',
    'sullyos_update_2026_08_30_collaboration_seen',
    'sullyos_update_2026_08_10_live2d_seen',
    'sullyos_update_2026_08_03_amsg2_seen',
];

const MIRRORED_KEYS_SET = new Set<string>(MIRRORED_KEYS);

const MIRROR_ASSET_ID = 'ls_mirror_v1';
const SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const WRITE_DEBOUNCE_MS = 250;

type MirrorPayload = { savedAt: number; data: Record<string, string> };

let mirrorReadFailed = false;
let pendingDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 启动回填：镜像里有、localStorage 里没有的键写回 localStorage。
 * 返回被回填的键名（空数组 = localStorage 完好或没有镜像）。
 * 必须在任何读 localStorage 的初始化逻辑（OSContext.loadSettings 等）之前 await。
 */
export async function healLocalStorageMirror(): Promise<string[]> {
    let payload: MirrorPayload | null = null;
    try {
        payload = await DB.getAssetRaw(MIRROR_ASSET_ID);
        mirrorReadFailed = false;
    } catch {
        mirrorReadFailed = true;
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
    if (restored.length > 0 && typeof window !== 'undefined') {
        try {
            window.dispatchEvent(new StorageEvent('storage', { key: null }));
        } catch { /* ignore */ }
    }
    return restored;
}

/** 把当前 localStorage 里的镜像键快照进 IndexedDB。全部缺失时不写（避免拿空快照覆盖有效镜像）。 */
export async function snapshotLocalStorageMirror(): Promise<void> {
    if (mirrorReadFailed) {
        await healLocalStorageMirror();
        if (mirrorReadFailed) return;
    }
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

function scheduleDebouncedSnapshot(): void {
    if (pendingDebounceTimer !== null) clearTimeout(pendingDebounceTimer);
    pendingDebounceTimer = setTimeout(() => {
        pendingDebounceTimer = null;
        void snapshotLocalStorageMirror();
    }, WRITE_DEBOUNCE_MS);
}

/**
 * 应用启动时调一次：先回填（含记忆宫殿水位线）、再拍一张新快照，并挂上"写盘防抖 / 页面隐藏 / 关闭 / 定时"的快照钩子。
 * 返回回填的键名，调用方可据此提示用户"本地设置曾丢失，已自动恢复"。
 */
export async function initLocalStorageMirror(): Promise<string[]> {
    const [restored, restoredHwms] = await Promise.all([
        healLocalStorageMirror(),
        healAllMemoryPalaceHighWaterMarks(),
    ]);
    await snapshotLocalStorageMirror();

    if (!listenersAttached && typeof window !== 'undefined' && typeof document !== 'undefined') {
        listenersAttached = true;
        const snap = () => {
            if (pendingDebounceTimer !== null) {
                clearTimeout(pendingDebounceTimer);
                pendingDebounceTimer = null;
            }
            void snapshotLocalStorageMirror();
        };
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') snap();
        });
        window.addEventListener('pagehide', snap);
        setInterval(snap, SNAPSHOT_INTERVAL_MS);

        if (typeof Storage !== 'undefined') {
            const origSetItem = Storage.prototype.setItem;
            const origRemoveItem = Storage.prototype.removeItem;
            const origClear = Storage.prototype.clear;
            Storage.prototype.setItem = function (key: string, value: string) {
                origSetItem.call(this, key, value);
                if (this === localStorage && MIRRORED_KEYS_SET.has(key)) {
                    scheduleDebouncedSnapshot();
                }
            };
            Storage.prototype.removeItem = function (key: string) {
                origRemoveItem.call(this, key);
                if (this === localStorage && MIRRORED_KEYS_SET.has(key)) {
                    scheduleDebouncedSnapshot();
                }
            };
            Storage.prototype.clear = function () {
                if (this === localStorage && pendingDebounceTimer !== null) {
                    clearTimeout(pendingDebounceTimer);
                    pendingDebounceTimer = null;
                }
                origClear.call(this);
            };
        }
    }
    return [...restored, ...restoredHwms];
}
