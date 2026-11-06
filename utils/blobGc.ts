// 孤儿 Blob GC 入口。删除令牌（blobref:）是保守的——同一令牌可能被多处引用，消费方
// 从不主动删，残留的孤儿 Blob 统一由这里的 GC 收口（首版只挂调试面板手动触发）。
// GC 逻辑在 @rei-standard/blob-store（mark & sweep + 多道安全阀，宁可留孤儿绝不删活图），
// 本文件只负责宿主义务里最要命的那条：把「全部可能含令牌的持久化面」枚举给它。
//
// ─── 引用面清单（本文件的生死线）───
// 漏掉一个面，那个面独占引用的图就会被当孤儿删掉（不可逆）。
// 新功能把 blobref 令牌写进新的 store / localStorage key 时，必须同步更新这份清单
// 和下面的 iterateRefSources 生成器。
//
// 这份清单有两个消费者：本文件的 GC（只读，扫出谁没人引用）和 utils/blobDedupe.ts 的
// 令牌合并（读+写，把重复令牌改写成保留的那个）。REF_SOURCE_STORES 两边共用，
// localStorage 面两边各自枚举一次——加新面时两处都要过一眼。
//
// | 面 | 内容字段 | 吐法 |
// |---|---|---|
// | characters 表 | avatar / sprites / dateSkinSets / roomConfig（wallImage/floorImage/items[].image）
// |               | / chatBackground / dateBackground / vrState.chibi / phoneState.contacts[].avatar
// |               | / specialMomentRecords.*（.image 与 customData 里的头像、手办图）
// |               | / companionAvatar（含 imageWardrobe，令牌兼任条目 id 与
// |               |   imageRef 两个值位）/ videoCallBackground / companionBackground / studio.like520 | 分页逐行 JSON.stringify(row) |
// | messages 表 | content（type 为 image / emoji 的聊天图与表情消息；卡片行的 content 是 JSON，
// |             |   里面还有 charAvatar / photoDataUrl）/ metadata.cameraSnapshotRef /
// |             |   metadata.scoreCard 的同名两字段 / metadata.characterAvatar /
// |             |   metadata.post（authorAvatar 与 comments[].authorAvatar） | 分页逐行（表大，不 getAll 全量占内存） |
// | emojis 表 | url（表情库；http 外链不是令牌，一并逐字吐过去也无妨） | 分页逐行 |
// | cc_custom_parts 表 | src / shadowSrc | 分页逐行 |
// | songs 表 | coverImage | 分页逐行 |
// | daily_schedule 表 | coverImage（日程头图） | 分页逐行 |
// | gallery 表 | url | 分页逐行 |
// | assets 表 | wallpaper / lock_wallpaper / wallpaper_user_backup / icon_* /
// |           | appearance_preset_*（JSON）/ room_custom_assets_list（JSON）/
// |           | ls_mirror_v1（localStorage 镜像，最容易漏）/ spark_* 等 | 分页逐行 |
// | themes 表 | 聊天气泡主题：user / ai 两侧各自的 backgroundImage / decoration / avatarDecoration | 分页逐行 |
// | user_profile 表 | avatar（我方头像）/ perCharAvatars（分角色头像） | 分页逐行 |
// | social_posts 表 | authorAvatar（帖子作者）/ comments[].authorAvatar（评论作者） | 分页逐行 |
// | groups 表 | avatar（群头像） | 分页逐行 |
// | character_groups 表 | avatar（角色分组图标） | 分页逐行 |
// | story_theater_masks 表 | avatar（剧场原创人物面具） | 分页逐行 |
// | bank_data 表 | 店员 avatar / 留言板 avatar | 分页逐行 |
// | guidebook、life_sim 表 | 卡片里留存的 charAvatar / actorAvatar 副本 | 分页逐行 |
// | pixel_home_assets 表 | 目前未见令牌写入，纳入白名单防未来回归 | 分页逐行 |
//
// 上面从 user_profile 到 life_sim 这几张，装的都是**从角色/用户头像复制过去的副本**。
// 头像本身在 characters 表，但它会被抄进帖子、卡片、面具、群资料里长期留着。GC 扫不到
// 这些面，就会把还被老帖子引用着的图判成孤儿删掉——所以它们必须在清单里，哪怕平时为空。
// | localStorage 全量值 | tama_board_img_<charId> 与旧单键 / acnh_wallpaper_backup /
// |                     | sully-call-fake-camera-image-v1 / os_theme（JSON，令牌不剥）等 | 先同步快照再逐条吐 value |
//
// 上面各行的字段列表只是「这张表里都有哪些图」的说明，**不是枚举依据**——真正的枚举是
// 整行 JSON.stringify，字段加了删了都自动覆盖。谁要是照着表格改成按字段挑，漏掉的那个
// 字段引用的 Blob 就会被判成孤儿删掉，而且删除不可逆。
//
// 各面都是 JSON / 裸字符串，令牌逐字可见，不需要解压解密。若未来某个面压缩 / 加密后才
// 落盘，必须先还原成明文再吐——那种情况枚举不报错、安全阀也不触发，等于这个面没扫。

import { DB } from './db';
import { blobStore } from './blobStore';
import { tryAcquireMaintenanceLock, releaseMaintenanceLock, currentMaintenanceHolder } from './maintenanceLock';

// 引用面里的 17 张表。名字与 db.ts 的 STORE_* 常量值一一对应
// （STORE_CHARACTERS / STORE_MESSAGES / STORE_CC_PARTS / STORE_SONGS / STORE_GALLERY /
//   STORE_ASSETS / STORE_THEMES / STORE_EMOJIS / STORE_USER / STORE_SOCIAL_POSTS /
//   STORE_GROUPS / STORE_CHAR_GROUPS / STORE_STORY_THEATER_MASKS / STORE_BANK_DATA /
//   STORE_GUIDEBOOK / STORE_LIFE_SIM / pixel_home_assets）。
// 全部是 inline keyPath（都用 'id'），所以 blobDedupe 的 putStoreRows 能原样写回。
// 导出仅供测试核对拼写：名字写错时 getStoreRowsPage 的 contains 兜底会静默返回空页，
// 等于那个面没扫、无任何报错——blobGc.test.ts 有一条守卫断言每个名字真实存在。
export const REF_SOURCE_STORES = [
    'daily_schedule',
    'characters',
    'messages',
    'cc_custom_parts',
    'songs',
    'gallery',
    'assets',
    'themes',
    'emojis',
    'user_profile',
    'social_posts',
    'groups',
    'character_groups',
    'story_theater_masks',
    'bank_data',
    'guidebook',
    'life_sim',
    'pixel_home_assets',
] as const;

// 每批读多少行。批间事务各自独立（见 DB.getStoreRowsPage 注释），内存峰值只有一批。
const PAGE_SIZE = 200;

/**
 * 逐条 yield 明文字符串的引用面枚举器（喂给 SDK 的 store.gc）。
 * 枚举中任何一步出错都直接上抛——SDK 的安全阀会整轮放弃（aborted: true，一个不删），
 * 绝不能在这里吞错静默跳过，那等于把出错的面当「没有引用」。
 */
async function* iterateRefSources(): AsyncGenerator<string> {
    // 表面：按主键分页逐行吐 JSON。
    for (const storeName of REF_SOURCE_STORES) {
        let afterKey: IDBValidKey | null = null;
        for (;;) {
            const { rows, lastKey } = await DB.getStoreRowsPage(storeName, afterKey, PAGE_SIZE);
            for (const row of rows) {
                const text = JSON.stringify(row);
                // JSON.stringify(undefined) 是 undefined（不是字符串），跳过这类空洞行
                if (typeof text === 'string') yield text;
            }
            if (lastKey === null || rows.length < PAGE_SIZE) break;
            afterKey = lastKey;
        }
    }

    // localStorage 面：先同步快照成数组再逐条 yield —— async generator 每次 yield 都会
    // 挂起，挂起期间并发的 removeItem 会让下标移位、漏扫一个 key。
    const localValues: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key === null) continue;
        localValues.push(localStorage.getItem(key) ?? '');
    }
    yield* localValues;
}

/**
 * 跑一轮孤儿 Blob GC，返回 SDK 的 { deleted, kept, keptBoundary, aborted }。
 * minAgeMs 默认 72h（SDK 侧新鲜豁免，挡「已 put、引用未落盘」的竞态），0 只应出现在测试。
 * keptBoundary 接近库存量 = 某个引用面混进了杂散的令牌前缀文本，GC 整轮空转——
 * 展示侧（调试面板）必须把它露出来，deleted:0 和「真没垃圾」同形，它是唯一报警信号。
 *
 * 与「优化资源存储」共用 maintenanceLock：迁移是引用搬家（data: → 令牌），
 * mark 不是一致性快照，撞上会误删活图。锁被占时直接抛（拿不到锁 ≠ 没垃圾）。
 */
export async function runBlobGc(opts?: { minAgeMs?: number }) {
    if (!tryAcquireMaintenanceLock('孤儿图片清理')) {
        throw new Error(`另一项存储维护（${currentMaintenanceHolder()}）正在进行，请稍后再试。`);
    }
    try {
        return await blobStore.gc({ refSources: (async function* () { yield* iterateRefSources(); yield* (await import('./spaceAssets')).allSpaceReferenceSources(); })(), ...opts });
    } finally {
        releaseMaintenanceLock();
    }
}
