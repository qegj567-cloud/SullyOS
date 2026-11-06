// 图片 Blob 引用层（base64 → Blob 迁移的核心）。
//
// 背景：本项目图片历来以 base64 data URL 直接存进 IndexedDB / CharacterProfile。base64 比
// 原始二进制大 ~33%，且作为 JS 字符串常驻内存（React state / <img src> 里都拖着整段），
// 壁纸、小屋（RoomApp）这类大图尤其吃配额和内存。
//
// 方案：图片二进制存进 blob_assets store（IndexedDB 原生支持 Blob），字段里只存一个短
// 令牌 `blobref:<id>`。这样：
//   · 字段仍是 string —— CharacterProfile / 各 store 记录仍可 JSON 安全序列化、结构化克隆；
//   · 渲染时把令牌解析成 objectURL（URL.createObjectURL）喂给 <img>/CSS 背景，并管好回收；
//   · 整包备份（v3）令牌原样进 JSON，二进制走 zip 的 blobs/<id> 旁路、导入按原 id 写回
//     （见 utils/backupBlobs.ts）；单文件分享（外观预设 / 小屋模板）仍解析回 data URL 内嵌，
//     换取单个 JSON 文件的可移植性。
//
// 通用部分已提炼为 @rei-standard/blob-store（store 单例见 ./blobStore.ts），本文件是
// 薄壳（导出名与签名不变，逐个委托 SDK，React hook 委托 react 子路径的 useBlobUrl）
// + SullyOS 特有逻辑（引用扫描删除、外观预设迁移、hook 里的内置样板房分支）。
// 新令牌的 id 是 SDK 生成的 `b_` 前缀；存量 `img_` 令牌照常读取，无需迁移。
//
// 兼容：旧值（`data:...` / `http(s)://...` / CSS 渐变字符串）一律原样透传；内置样板房
// 的可移植令牌会按当前部署 BASE_URL 解开，避免备份跨域/跨壳恢复后家具路径失效。
// 惰性迁移由各消费方（壁纸加载、进入小屋）在读到 data: 时顺手 put 成 Blob 完成。

import { useBlobUrl } from '@rei-standard/blob-store/react';
import { dataUrlToBlob, blobToDataUrl, hashBlob } from '@rei-standard/blob-store';
import { DB } from './db';
import { blobStore } from './blobStore';
import { REF_SOURCE_STORES } from './blobGc';
import type { AppearancePreset, ChatTheme } from '../types';
import { resolveBuiltinRoomAssetUrl } from './roomTemplateAssets';

// 与 SDK 默认前缀一致（DEFAULT_PREFIX），保留字面量避免消费方多绕一层。
export const BLOBREF_PREFIX = 'blobref:';

// 用带品牌的 string 子类型做类型守卫：正分支收窄成 BlobRef，负分支仍保留 string
// （若直接用 `v is string`，对本就是 string 的入参，否定分支会被收窄成 never）。
export type BlobRef = string & { readonly __blobRef: unique symbol };

/** 是否是 blobref 令牌。 */
export const isBlobRef = (v: unknown): v is BlobRef => blobStore.isRef(v);

/**
 * 这个字段值是「一张图」，还是「一段拿来直接显示的文字」（emoji、名字首字）？
 *
 * 头像、店员、贴纸这类字段是两用的：用户可以传图，也可以只填一个 emoji。界面上到处
 * 都有「是图就 <img>，不是图就当文字画出来」的分叉，而这个判断历来各写各的，形如
 * `v.startsWith('http') || v.startsWith('data')`。
 *
 * 图片改存 Blob 之后，字段里可能是个 `blobref:` 令牌——上面那种写法两个条件都不满足，
 * 于是令牌被当成文字，界面上直接显示出一串 `blobref:b_xxx`。不报错、不破图，就是明晃晃
 * 地印在那儿。所以判断收口到这里一处，新形态只需要在这个函数里认一次。
 *
 * 认四种：blobref 令牌、内嵌 data URL、http(s) 外链、站内绝对路径（`/assets/…`）。
 */
export function isImageValue(value: unknown): value is string {
    if (typeof value !== 'string' || value === '') return false;
    return isBlobRef(value)
        || value.startsWith('data:')
        || /^https?:\/\//i.test(value)
        || value.startsWith('/');
}

/** 把 Blob 存进 blob_assets，返回 `blobref:<id>` 令牌（新 id 由 SDK 生成，`b_` 前缀）。 */
export async function putImageBlob(blob: Blob): Promise<string> {
    // Keep independent upload handles; the storage adapter deduplicates their bytes.
    return blobStore.put(blob);
}

/** 读取令牌对应的 Blob（非令牌或不存在返回 null）。 */
export async function getBlobForRef(ref: string): Promise<Blob | null> {
    return blobStore.get(ref);
}

/**
 * 备份导入用：把 Blob 按既有令牌的原 id 写回（SDK restore）。令牌身份保住，
 * JSON 里的引用零改写。非法令牌 / 非 Blob 由 SDK 吵着抛，调用方应中止导入。
 */
export async function restoreBlobRef(token: string, blob: Blob): Promise<void> {
    await blobStore.restore(token, blob);
}

/**
 * 删除令牌对应的 Blob（best-effort，非令牌直接返回）。
 * 注意：同一令牌可能被多处引用（小屋自定义素材的 image 会被复制进摆放的 item.image），
 * 所以调用方需自行确认无人再引用后才删，否则会删出「碎图」。多数消费方从简：不主动删，
 * 残留孤儿 Blob 由后续 GC 处理，宁可占一点空间也不冒破图风险。
 *
 * 少数字段（桌面静态形象 / 视频舞台背景 / 桌面背景 / 通话快照 / 假摄像头图）确实会在
 * 换图时直接删掉旧 Blob——它们的图来自用户当场选的文件，一份令牌只归自己。这批字段
 * 登记在 utils/blobDedupe.ts 的 collectUnmergeableRefs 里，令牌合并会整组绕开它们。
 * 新增这类裸删调用点时，记得把字段一并登记过去。
 */
export async function deleteBlobRef(ref: string | undefined | null): Promise<void> {
    if (!ref) return;
    await blobStore.delete(ref);
}

// 引用面扫描的分页大小。与 blobGc / blobDedupe 同值：批间事务各自独立，内存峰值只有一批。
const REF_SCAN_PAGE_SIZE = 200;

/**
 * 这个令牌还被任何一个持久化面引用着吗？
 *
 * 面的清单直接用 blobGc 的 REF_SOURCE_STORES（+ localStorage 全量），跟孤儿 GC 同源。
 * 「优化资源存储」的内容去重会把同一张图在这十几个面上收敛成同一个令牌，所以一张图
 * 完全可能既当着壁纸又躺在聊天记录里——只查壁纸那两处就会把它判成「没人要了」删掉，
 * 聊天和相册里那张跟着一起裂。
 *
 * 判断是整行 JSON 里找子串，不按字段挑：字段加了删了都自动覆盖。子串比精确匹配宽
 * （令牌 A 是令牌 B 的前缀时会算成「还有人引用」），偏的是「宁可留孤儿也不删活图」，
 * 多留下的孤儿归手动 GC 收。
 *
 * 会走到这里的都是换壁纸、删衣柜这类低频操作，扫一遍全库的代价可以接受。
 */
async function isRefStillReferenced(ref: string): Promise<boolean> {
    for (const storeName of REF_SOURCE_STORES) {
        let afterKey: IDBValidKey | null = null;
        for (;;) {
            const { rows, lastKey } = await DB.getStoreRowsPage(storeName, afterKey, REF_SCAN_PAGE_SIZE);
            for (const row of rows) {
                const text = JSON.stringify(row);
                if (typeof text === 'string' && text.includes(ref)) return true;
            }
            if (lastKey === null || rows.length < REF_SCAN_PAGE_SIZE) break;
            afterKey = lastKey;
        }
    }

    if (typeof localStorage !== 'undefined') {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            if (localStorage.getItem(key)?.includes(ref)) return true;
        }
    }

    return false;
}

/**
 * 仅在令牌已不再被任何持久化面引用时删除 Blob。
 *
 * 壁纸、锁屏、外观预设、聊天记录、相册……都可能共享同一令牌；直接在换图时 delete
 * 会让别处变成死图。调用方须先把自己那一处的指针落盘，再调这里——扫描看到的是
 * 库里的现状，指针还没写回去的话这张图会被当成「还有人用」而留下。
 *
 * 扫描中途出错（哪怕只有一张表读不出来）一律当作「还有人引用」保留：删除不可逆，
 * 留下的孤儿则有手动 GC 兜着。
 */
export async function deleteBlobRefIfUnreferenced(ref: string | undefined | null): Promise<boolean> {
    if (!ref || !isBlobRef(ref)) return false;

    try {
        if (await isRefStillReferenced(ref)) return false;
    } catch {
        return false;
    }

    await deleteBlobRef(ref);
    return true;
}

// ─── data URL ⇄ Blob 互转 ───────────────────────────────────────
// 语义随 SDK：dataUrlToBlob 非法输入抛错、非 base64 退化 UTF-8 编码；
// blobToDataUrl 优先 FileReader，无 FileReader 环境（Worker / Node 测试）退化 arrayBuffer 手编。
export { dataUrlToBlob, blobToDataUrl };

// ─── 内容记忆：同一份图别存第二遍 ───────────────────────────────
//
// 惰性迁移分散在各消费点（壁纸加载、进小屋、图标、捏人器部件），彼此不知道对方转过什么。
// 导入过「同一张图内联在好几处」的旧备份后，这些入口会在几分钟里把同一份 base64 各转一遍，
// 库里于是躺着好几份一模一样的 Blob。这层记忆按内容哈希把它们收敛到同一个令牌上。
//
// key 用哈希而不是 data URL：后者动辄几 MB，缓存它等于把 base64 又请回内存，
// 那正是 blobRef 要解决的问题。
//
// 只在进程内有效（刷新即空）。跨会话的重复交给「优化资源存储」——它扫全库按内容合并，
// 并在开头拿扫描结果给这份记忆预热，于是转换时能直接复用库里已经有的那份。
const contentMemo = new Map<string, string>();

/**
 * 用扫库结果预热内容记忆。tokens 按创建时间升序，取第一个（也是合并时的保留方）。
 *
 * 调用方要先滤掉「被裸删字段引用」的令牌（见 utils/blobDedupe.ts 的 collectUnmergeableRefs）：
 * 复用到那种令牌，等于让新字段和一个「换图就直接删」的字段共享 Blob，对方一删这边就破图。
 */
export function primeContentMemo(byHash: Map<string, string[]>): void {
    for (const [hash, tokens] of byHash) {
        if (tokens.length > 0) contentMemo.set(hash, tokens[0]);
    }
}

/** 仅测试用：清空内容记忆，避免用例之间串味。 */
export function clearContentMemo(): void {
    contentMemo.clear();
}

/**
 * 存 Blob，但先看看同样内容的是不是已经有了——有就复用它的令牌，不再存第二份。
 * 算不出哈希（非安全上下文没有 crypto.subtle）时退化成普通 put，功能照旧、只是不去重。
 *
 * 上传保留独立令牌，迁移可复用令牌；底层共享池在两种情况下都只保存一份文件字节。
 */
export async function putImageBlobDeduped(blob: Blob): Promise<{ token: string; reused: boolean }> {
    let hash: string | null = null;
    try { hash = await hashBlob(blob); } catch { hash = null; }

    if (hash) {
        const remembered = contentMemo.get(hash);
        // 记住的令牌可能已经不在了：它写进某个字段后那个字段又被改掉，Blob 成孤儿被 GC 收走。
        // 直接还回去就是个死令牌，所以确认 Blob 还在才复用。
        if (remembered) {
            if (await getBlobForRef(remembered)) return { token: remembered, reused: true };
            contentMemo.delete(hash);
        }
    }

    const { putSharedImage } = await import('./spaceAssets');
    const token = await putSharedImage(blob);
    if (hash) contentMemo.set(hash, token);
    return { token, reused: false };
}

/**
 * 把一个 data: 图片存成 Blob 并返回令牌（惰性迁移用）。同内容的图已经存过就复用它，
 * 不再存第二份。转换失败时回退返回原字符串，保证调用方永远拿到一个可渲染的值，
 * 不会因迁移失败而丢图。
 */
export async function migrateDataUrlToRef(dataUrl: string): Promise<string> {
    try {
        return (await putImageBlobDeduped(dataUrlToBlob(dataUrl))).token;
    } catch {
        return dataUrl;
    }
}

/**
 * 气泡主题里参与令牌迁移的图片字段名。user / ai 两侧字段完全一样，共用这一份清单——
 * 分开写两份的结果一定是其中一侧漏掉某个字段，而漏掉的那侧不报错也不破图，只是没省下来。
 */
export const CHAT_THEME_IMAGE_KEYS = ['backgroundImage', 'decoration', 'avatarDecoration'] as const;

/**
 * 一套气泡主题里的六张图（user / ai 两侧各三张）转成令牌。
 *
 * 两个调用方共用它：themes 表的存量转换，和外观预设里内嵌的那份 chatThemes。
 * 后者尤其要紧——应用一个老预设时若把预设里的 base64 原样写回 themes 表，
 * 等于把刚优化掉的图又倒回去，用户会看到「优化完过几天又涨回来了」。
 */
export async function migrateChatThemeBlobRefs(theme: ChatTheme): Promise<ChatTheme> {
    const migrated: ChatTheme = { ...theme };
    for (const side of ['user', 'ai'] as const) {
        const style = theme[side];
        if (!style) continue;
        const next = { ...style };
        for (const key of CHAT_THEME_IMAGE_KEYS) {
            const value = next[key];
            if (typeof value === 'string' && value.startsWith('data:')) {
                next[key] = await migrateDataUrlToRef(value);
            }
        }
        migrated[side] = next;
    }
    return migrated;
}

/**
 * 外观预设导入专用迁移：只转换已经接入 BlobRef 渲染链路的字段，其他 data URL 保持原状。
 *
 * 同一张原图在壁纸、锁屏或多个图标里出现时只会存一份 Blob——这由 migrateDataUrlToRef
 * 的内容记忆保证（按哈希认人）。这里不再自备一层 data URL → 令牌的缓存：键是几 MB 的
 * base64 原文，一批预设过下来等于把它们全留在内存里，而收益只是省掉一次哈希计算。
 */
export async function migrateAppearancePresetBlobRefs(
    preset: AppearancePreset,
): Promise<AppearancePreset> {
    const migrate = async (value: string | undefined): Promise<string | undefined> => {
        if (!value?.startsWith('data:')) return value;
        return await migrateDataUrlToRef(value);
    };

    const theme = { ...preset.theme };
    theme.wallpaper = (await migrate(theme.wallpaper)) || theme.wallpaper;
    if ('lockWallpaper' in theme) theme.lockWallpaper = await migrate(theme.lockWallpaper);

    // 桌面小组件图。槽位键遍历全部，不写死 tl/tr/wide/dsq——老美化包的预设里还压着
    // polaroid_* 这类历史键，一并转掉，免得它们以 base64 形态一直躺在预设 JSON 里。
    if (theme.launcherWidgets) {
        const widgets: Record<string, string> = {};
        for (const [slot, value] of Object.entries(theme.launcherWidgets)) {
            widgets[slot] = (await migrate(value)) || value;
        }
        theme.launcherWidgets = widgets;
    }

    // launcherWidgetImage 是死字段：types.ts 标了 DEPRECATED，OSContext 加载 / 应用预设时
    // 一律剥掉，永远不会渲染。老美化包的预设里还压着一张几百 KB 的 base64，转成令牌只是
    // 把死重量换个地方存，直接扔掉。
    if ('launcherWidgetImage' in theme) (theme as any).launcherWidgetImage = undefined;

    let customIcons = preset.customIcons;
    if (customIcons) {
        customIcons = {};
        for (const [appId, icon] of Object.entries(preset.customIcons || {})) {
            customIcons[appId] = (await migrate(icon)) || icon;
        }
    }

    // 预设里内嵌的气泡主题：保存预设时是从 themes 表原样抄过来的，themes 表转了、这里没转，
    // 下次应用预设就把 base64 又灌回 themes 表。两边必须一起转。
    let chatThemes = preset.chatThemes;
    if (chatThemes) {
        const next: ChatTheme[] = [];
        for (const ct of chatThemes) next.push(await migrateChatThemeBlobRefs(ct));
        chatThemes = next;
    }

    return { ...preset, theme, customIcons, chatThemes };
}

/**
 * 把单个值从令牌解析成可直接用的 data URL（读 Blob → base64）；非令牌原样返回。
 * 用在必须拿 base64 字符串的消费点（如跨 iframe postMessage 的捏人器部件）。
 * Blob 已丢时返回空串（避免把死令牌当 img src 用）。
 */
export async function resolveRefToDataUrl(value: string): Promise<string> {
    return blobStore.resolveToDataUrl(value);
}

/**
 * 深度遍历对象树，把所有 `blobref:<id>` 字符串原地替换成对应的 data URL（读 Blob 转 base64）。
 * 单文件分享（外观预设 / 小屋模板）导出前调用，令牌随之变回 data:image 内嵌进 JSON——
 * 整包备份不走这条（v3 令牌原样进包，见 utils/backupBlobs.ts）。解析不到的令牌置空串
 * （图已丢，避免导出一个恢复端认不得的死令牌）。原地修改传入对象，调用方须传独立副本。
 */
export async function resolveBlobRefsDeep(root: unknown): Promise<void> {
    if (root === null || typeof root !== 'object') return;
    await blobStore.resolveDeep(root);
    // The SDK only resolves whole-field tokens. Decoration CSS embeds image
    // references in url(...); character/appearance single-file exports need these too.
    const {portableCssImages} = await import('./cssImageAssets');
    const seen = new WeakSet<object>();
    const visit = async (node: any): Promise<void> => {
        if (!node || typeof node !== 'object' || seen.has(node)) return;
        seen.add(node);
        for (const key of Object.keys(node)) {
            const value = node[key];
            if (typeof value === 'string' && value.includes('blobref:')) node[key] = await portableCssImages(value);
            else if (value && typeof value === 'object') await visit(value);
        }
    };
    await visit(root);
}

// ─── React 渲染 hook ────────────────────────────────────────────

/**
 * 把一个图片字段值解析成可直接用于 <img src>/CSS url() 的字符串。
 *   · blobref 令牌 → 交给 SDK 读 Blob 建 objectURL，组件卸载 / value 变化时 revoke，绝不泄漏；
 *     解析完成前返回 undefined —— 首帧无图、令牌间切换时先空一帧再出新图，
 *     绝不把上一个（已 revoke 的）objectURL 吐给渲染层；
 *   · builtin-room-asset 令牌 / 旧样板房绝对 URL → 当前部署下的内置资源 URL；
 *   · 其它（data: / http(s) / 渐变 / undefined）→ 渲染期直接透传，不等 effect、无一帧滞后。
 * 语义契约钉在 ./blobRefHook.contract.test.ts。
 */
export function useBlobRefUrl(value: string | undefined | null): string | undefined {
    // builtin 分支在 SDK 之前解析；blobref 令牌绕过它直接交给 SDK。
    const resolved = isBlobRef(value) ? value : resolveBuiltinRoomAssetUrl(value);
    return useBlobUrl(blobStore, resolved);
}
