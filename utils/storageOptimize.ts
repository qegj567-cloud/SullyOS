// 「优化资源存储」：转换旧图片和向量，合并重复引用，并整理连接精度。
//
//   一、把已接入令牌链路的面里仍以 base64（data:image）落库的存量图片，批量转成
//       blobref 令牌 + Blob 二进制（省掉 base64 的 ~33% 膨胀）。
//   二、把「同一张图在库里存了好几份 Blob」收敛成一份。
//   三、把还停留在 number[] 形态的记忆向量压成 Float32 原始字节（每维 ~20 字节 → 4 字节）。
//   四、把记忆连接权重收敛为五位小数，不删连接。主要缩短备份 JSON，
//       不把 Number 的小数位减少当成 IndexedDB 磁盘节省来报告。
//
// 第一笔债的由来：这些面平时靠惰性迁移——哪个消费点读到 data: 才顺手转（加载壁纸、
// 进小屋……），从不打开的内容会一直躺着多占空间；导入 v2 老备份也会重新带进一批 base64。
//
// 第二笔债的由来：同一张图有好几条互不相识的迁移入口，各转各的，于是令牌不同、内容
// 逐字节相同。SDK 的 scanContent 按内容哈希找出这些重复组，utils/blobDedupe.ts 把重复
// 令牌在全部引用面上改写成组内保留的那个。合并只改引用、不删 Blob——失去引用的那几份
// 变成孤儿，交给孤儿 GC 收（删除不可逆，走那条带安全阀的老路更稳）。
//
// 前两笔债咬合在一起：扫库结果会先给 blobRef 的内容记忆预热，所以第一步转换时遇到「库里
// 已经有一份同样内容」的图，直接复用那个令牌，不会又存出一份新的重复来。
//
// 第三笔债的由来：向量的紧凑形态（Uint8Array）和读出口（ensureFloat32）早就到位，靠的却是
// 「谁被搜到谁才转」的惰性迁移 + 一次开机后台扫描；后者跑在页面加载后台、失败只 console.warn，
// 从外面完全看不出来它有没有跑完。这里把同一个扫描挂到手动按钮上，并把失败原样报到界面——
// 一次没转完，下次再点就是了（幂等）。压缩是无损的：读出口两种形态都认，召回质量不受影响。
//
// 跑过一遍后再跑就是 no-op（幂等），导入过旧备份后可以再跑。
//
// 十二个面都是按主键分页读的，一次只有一批行在内存里。别改回整表读：真实库里这几张表
// 加起来能有几十 MB（光 messages 一张就两万多行、20 MB 量级），光是把它们读进来就够呛，
// 何况全程还得占着。
//
// ─── 覆盖面即安全边界（本文件的生死线）───
// 只允许收录「当前写入路径已产出令牌」的字段——写令牌意味着读端全链路认令牌，
// 换成令牌不可能破图。逐面对应的现役令牌写入点：
//   assets 'wallpaper' / 'lock_wallpaper' / 'wallpaper_user_backup' ← 壁纸加载器（OSContext）
//   assets 'icon_*'                  ← AppIconEditor
//   assets 'widget_*'                ← 桌面小组件图上传（apps/Appearance.tsx 的 handleWidgetUpload）
//   assets 'appearance_preset_*'     ← migrateAppearancePresetBlobRefs（字段清单复用同一函数，
//     含内嵌的 chatThemes[] 六个字段；顺便扔掉死字段 launcherWidgetImage）
//   assets 'room_custom_assets_list' ← RoomApp 自定义素材
//   assets 'spark_user_bg' / 'spark_social_profile'.avatar ← 社交主页的背景与头像上传
//   characters avatar                ← 角色资料页的头像上传（apps/Character.tsx）
//   characters roomConfig.wallImage / floorImage / items[].image ← RoomApp
//   songs coverImage                 ← SongwritingApp
//   cc_custom_parts src / shadowSrc  ← creatorPartToBlobRefs（字段清单复用同一函数）
//   gallery url                      ← Chat 把用户发的图存进相册时
//   themes user/ai 各自的 backgroundImage / decoration / avatarDecoration ← 气泡工坊（ThemeMaker）
//   messages content（type 为 image / emoji 的行，整条正文就是一张图）← Chat / GroupChat 发图发表情
//   messages 卡片行里的头像与合照副本：content(json) 和 metadata.scoreCard 各存一份的
//     charAvatar / photoDataUrl（两份必须一起转，读端优先读 metadata 那份）、
//     metadata.characterAvatar（通话结束卡）、metadata.post 的 authorAvatar 与
//     comments[].authorAvatar（分享出去的帖子快照）
//   messages replyTo.content ← 引用回复的内容快照。这一条不转令牌，图片值直接换成占位符：
//     引用块本来就只显示纯文本（还截前 10 字），令牌摆在那儿既难看，被截断后剩下的
//     'blobref:b_' 还正好是所有令牌 id 的公共前缀，会让孤儿清理判定「引用面被截断了」
//     从而整轮不敢删（新写入的快照已经直接写占位符，见 utils/applyAssistantPostProcessing.ts）
//   emojis url                       ← Chat 表情导入（http 外链不是本机资源，不转）
//   user_profile avatar / perCharAvatars ← 个人档案的头像上传 / 分角色聊天头像
//   user_profile vrState.chibi.img   ← 手办柜 / 彼方（ChibiStudio、VRWorldApp）
//   characters sprites / dateSkinSets[].sprites ← 见面场景布置的立绘上传（DateSettings）
//   characters chatBackground        ← 聊天页的背景图上传（Chat）
//   characters dateBackground        ← 见面场景布置的背景图上传（DateSettings）
//   characters vrState.chibi.img     ← 手办柜 / 彼方
//   characters phoneState.contacts[].avatar ← 查手机通讯录（值是角色头像的副本）
//   characters specialMomentRecords.*.image ← 活动留存的大图（白色情人节明信片、520 定妆照）
//   characters specialMomentRecords.*.customData.chatCard.charAvatar ← 活动留存的聊天卡片
//   social_posts authorAvatar / comments[].authorAvatar ← 社交发帖（值是角色 / 我方头像副本）
//   groups avatar                    ← 群资料页（GroupChat 早已走 migrateDataUrlToRef）
//   life_sim actionLog[].actorAvatar ← 生活模拟剧情日志（同样是头像副本）
//   characters companionAvatar.imageRef 与 .imageWardrobe[].imageRef ← 桌面陪伴的静态形象与衣柜
//   characters videoCallBackground   ← 视频通话的舞台背景（CallApp）
//   characters companionBackground   ← 桌面陪伴的背景（CompanionHome）
//     ↑ 末尾这三个是「换图即删」字段，走 convertExclusive（不去重、令牌独占），
//       衣柜里那份还得跟顶层 imageRef 同令牌。两条规矩的来由见各自函数注释。
// 明确不碰：
//   · 手账自己的配图，以及帖子自己的配图 social_posts.images[]——读端还不认令牌，转了就破图
//     （帖子配图还被当成「可能是 emoji 字符串」直接渲染成文本，见 MessageItem 的 social_card）；
//   · chibiStudio.like520.img 与 specialMomentRecords.*.customData.charChibi / userChibi——
//     刻意保持 dataURL（见 docs/chibi-studio.md）：520 活动那边全是裸 <img> + canvas 合成，
//     令牌过不去。所以 specialMomentRecords 只能走 chatCard.charAvatar 那一条精确路径，
//     绝不能整体深度遍历；
//   · life_sim 的 actionLog[].attachments[].imageUrl——裸 <img> 渲染，同理只能字段定向；
//   · pixel_home_assets / pixel_home_layouts / pixel_char_* 这一族——收益只有几十 KB，
//     但要先填四个坑：pixelImage 的读端跨了裸 <img>、canvas getImageData（失败被 catch 静默
//     吞掉，症状是角色穿墙）、fetch（令牌直接 TypeError）、分享 JSON 四种形态；墙纸地砖住在
//     pixel_home_layouts，而那张表不在 utils/blobGc.ts 的引用面清单里，转了会被孤儿 GC 当垃圾
//     删掉；像素小屋的预设导出没跑 resolveBlobRefsDeep，令牌会原样进分享文件；
//     types.ts 的 decodeColorField 已经在用认令牌的 isImageValue，跟同文件里
//     startsWith('data:') 的判据对不上。
// 新面收录时除了加进上面清单，还必须确认该面已在 utils/blobGc.ts 的引用面清单里——
// 否则转出来的 Blob 会被孤儿 GC 删掉（storageOptimize.test.ts 有守卫钉这条包含关系）。
//
// 与孤儿 GC 共用 maintenanceLock 互斥：迁移是「引用搬家」，不能撞上进行中的 mark。

import { DB } from './db';
import {
    isBlobRef, dataUrlToBlob, putImageBlob, putImageBlobDeduped, getBlobForRef, migrateAppearancePresetBlobRefs,
    primeContentMemo, CHAT_THEME_IMAGE_KEYS,
} from './blobRef';
import { blobStore } from './blobStore';
import { collectUnmergeableRefs, buildMergePlan, rewriteBlobRefs } from './blobDedupe';
import { creatorPartToBlobRefs } from './creatorPartsBlob';
import { tryAcquireMaintenanceLock, releaseMaintenanceLock, currentMaintenanceHolder } from './maintenanceLock';
import type { AppearancePreset, ChatTheme, CharacterProfile, CustomCreatorPart, Emoji, GalleryImage, Message, SongSheet } from '../types';

/** 本工具会写的表。守卫测试断言它 ⊆ blobGc 的 REF_SOURCE_STORES（转出的 Blob 必须在 GC 视野内）。 */
export const OPTIMIZE_TARGET_STORES = ['assets', 'characters', 'songs', 'cc_custom_parts', 'gallery', 'themes', 'messages', 'emojis', 'user_profile', 'social_posts', 'groups', 'life_sim'] as const;

/** 卡片 JSON 里参与迁移的图片字段名。只认这两个——同一坨 JSON 里还有别的图片字段
 *  （520 的手办图 charChibi / userChibi）是刻意保持 dataURL 的，深度遍历会把它们一起转走。 */
const CARD_IMAGE_KEYS = ['charAvatar', 'photoDataUrl'] as const;

/** 值形态是「裸图片字符串」的 assets 行。 */
const PLAIN_ASSET_IDS = new Set(['wallpaper', 'lock_wallpaper', 'wallpaper_user_backup', 'spark_user_bg']);

/** 每批读多少行。跟 utils/blobGc.ts 一个口径：批间事务各自独立，内存峰值只有一批。 */
const PAGE_SIZE = 200;

/**
 * 按主键升序把一张表逐行吐出来，内存里一次只留一批
 * （见 DB.getStoreRowsPage：IDB 事务撑不过 await 挂起，只能每批开一个新的 readonly 事务）。
 *
 * 边读边写为什么不重不漏：翻页靠主键推进，下一页从上一页最后那个键之后开始；而这几面的迁移
 * 只改行里的图片字段，主键一个都不动——改完的行还待在它原来的位置上，翻过去的不会再回来，
 * 没翻到的也不会挪到身后去。
 * 反过来说，谁要是在这个循环里换主键（删掉旧行、用新 id 重写一条）或者往表里插新行，这条保证
 * 就没了：落在游标前面的再也扫不到，落在后面的会被当成新行又处理一遍。真要删行 / 加行，
 * 请另起一趟遍历，别混进来。
 */
async function* iterateStoreRows<T>(storeName: string): AsyncGenerator<T> {
    let afterKey: IDBValidKey | null = null;
    for (;;) {
        const { rows, lastKey } = await DB.getStoreRowsPage(storeName, afterKey, PAGE_SIZE);
        for (const row of rows) yield row as T;
        if (lastKey === null || rows.length < PAGE_SIZE) break;
        afterKey = lastKey;
    }
}

export interface OptimizeProgress {
    /** 正在处理的面（给进度条文案用） */
    label: string;
    done: number;
    total: number;
}

export interface OptimizeResult {
    /** 被替换成令牌的字段数（同图多处引用各计一次） */
    converted: number;
    /** 实际新建的 Blob 数（去重后） */
    uniqueBlobs: number;
    /** 被替换掉的 data: 字符串总长度（≈原来占的字节） */
    bytesBefore: number;
    /** 对应 Blob 的总字节数（去重后） */
    bytesAfter: number;
    /** 转换失败、原值保留的字段数（图不丢，只是这张没省下来）。
     *  两种来源：这张图本身转不动，以及转好了但那一行写不回去（配额满） */
    failed: number;
    /**
     * 失败原因 → 出现次数，键形如「相册: TypeError: ...」。
     * failed 只说「有几张没转成」，不说为什么；同一个原因通常成批出现，按原因归并
     * 既压得住条数，又够定位问题。没有失败时是个空对象。
     */
    failureReasons: Record<string, number>;
    /** 合并掉的重复 Blob 份数（同一张图多存的那几份） */
    mergedDuplicates: number;
    /** 合并后能被孤儿清理回收的字节数 */
    reclaimableBytes: number;
    /** 触到「换图即删」的字段、不敢合并而跳过的重复组数（见 blobDedupe 的清单） */
    skippedGroups: number;
    /** 扫库没做成（keys 读不出 / 没有 crypto.subtle），这一轮没有去重 */
    scanUnavailable: boolean;
    /** 压成紧凑形态的记忆向量条数 */
    vectorsCompacted: number;
    /** 向量压缩失败的原因；null = 这轮没出问题。开机那次是静默 warn 的，这里必须报出来 */
    vectorError: string | null;
    /** Rounded weights only; no edges are removed and no disk saving is inferred. */
    linksCompacted: number;
    linkError: string | null;
}

export async function optimizeResourceStorage(
    onProgress?: (p: OptimizeProgress) => void,
): Promise<OptimizeResult> {
    if (!tryAcquireMaintenanceLock('优化资源存储')) {
        throw new Error(`另一项存储维护（${currentMaintenanceHolder()}）正在进行，请稍后再试。`);
    }
    try {
        const result: OptimizeResult = {
            converted: 0, uniqueBlobs: 0, bytesBefore: 0, bytesAfter: 0, failed: 0,
            failureReasons: {},
            mergedDuplicates: 0, reclaimableBytes: 0, skippedGroups: 0, scanUnavailable: false,
            vectorsCompacted: 0, vectorError: null,
            linksCompacted: 0, linkError: null,
        };
        // 当前正在处理哪个面（tick 时更新）。失败原因带上它才知道是哪张表出的事。
        let currentFace = '开始前';
        // 已计过字节数的令牌：canonical 迁移函数产出的令牌经这里补记大小，避免重复计。
        const countedTokens = new Set<string>();
        // 这一行开跑时的记账读数 + 这一行新计过的令牌（tick 时刷新）。
        // 行写回失败时按它把这一行的账原样退回去，见 writeRow。
        const rowStart = () => ({
            converted: result.converted, bytesBefore: result.bytesBefore,
            uniqueBlobs: result.uniqueBlobs, bytesAfter: result.bytesAfter,
            newTokens: [] as string[],
        });
        let rowTally = rowStart();

        /** convert / convertExclusive 共用的转换体。差别只在 put：走不走内容去重。 */
        const convertWith = async (
            value: unknown,
            put: (blob: Blob) => Promise<{ token: string; reused: boolean }>,
        ): Promise<string | null> => {
            if (typeof value !== 'string' || !value.startsWith('data:image/')) return null;
            // 内联 SVG 一律跳过：库里这些不是用户传的图，是代码现画出来的占位符
            // （群默认头像 ~300 字节、生活模拟的附件插图）。上传路径产出的都是 png/jpeg，
            // 不会落到这个分支。拿一条 Blob 行去换几百字节是负收益。
            if (value.startsWith('data:image/svg+xml')) return null;
            try {
                const blob = dataUrlToBlob(value);
                // 复用命中时不计新建：那份 Blob 本来就在库里占着，这次一个字节都没多存
                const { token, reused } = await put(blob);
                result.converted++;
                result.bytesBefore += value.length;
                if (!reused && !countedTokens.has(token)) {
                    countedTokens.add(token);
                    rowTally.newTokens.push(token);
                    result.uniqueBlobs++;
                    result.bytesAfter += blob.size;
                }
                return token;
            } catch (e) {
                result.failed++; // 坏 data: 转不动：原值保留，图不丢
                // 原因原本整个吞掉，只留一个数字，出问题时无从查起——按「面 + 原因」归并记一笔。
                const reason = `${currentFace}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
                result.failureReasons[reason] = (result.failureReasons[reason] ?? 0) + 1;
                return null;
            }
        };

        /** data:image → 令牌；非图片 data / 已是令牌 / http 一律返回 null（调用方不动原值）。
         *
         *  「同一份图别转两遍」这件事交给 putImageBlobDeduped——它按内容哈希认人，记的是
         *  哈希（几十字节），不是 base64 原文。这里不要再套一层以 data URL 为键的缓存：
         *  那层缓存等于把这一轮见过的每张图的原文都钉在内存里，表分页读了也白读。 */
        const convert = (value: unknown) => convertWith(value, putImageBlobDeduped);

        /** 「换图即删」字段专用：不走内容去重，每次都产出只归这个字段的新令牌。
         *
         *  这几个字段（清单见 utils/blobDedupe.ts）换图 / 移除时会直接 deleteBlobRef 掉旧
         *  Blob，前提是「这份令牌只归我」。走 putImageBlobDeduped 的话，两个字段恰好放了
         *  同一张图就会拿到同一个令牌，那边一换图，这边的图跟着没。宁可多存一份二进制。 */
        const convertExclusive = (value: unknown) =>
            convertWith(value, async blob => ({ token: await putImageBlob(blob), reused: false }));

        /** 一袋立绘（情绪键 → 图）整袋转成令牌，返回有没有动过。
         *  袋子里除了见面情绪立绘还混着小小窝的 chibi，两者都在令牌链路上，一起转。 */
        const migrateSpriteMap = async (sprites: unknown): Promise<boolean> => {
            if (!sprites || typeof sprites !== 'object') return false;
            let touched = false;
            for (const key of Object.keys(sprites as Record<string, string>)) {
                const token = await convert((sprites as Record<string, string>)[key]);
                if (token) { (sprites as Record<string, string>)[key] = token; touched = true; }
            }
            return touched;
        };

        /** canonical 迁移函数（预设 / 捏人器部件）转完后的记账：按 before/after 差异补计。 */
        const tallyPair = async (before: unknown, after: unknown): Promise<void> => {
            if (typeof before !== 'string' || !before.startsWith('data:image/')) return;
            if (typeof after !== 'string' || !isBlobRef(after)) return;
            result.converted++;
            result.bytesBefore += before.length;
            if (!countedTokens.has(after)) {
                countedTokens.add(after);
                rowTally.newTokens.push(after);
                result.uniqueBlobs++;
                const blob = await getBlobForRef(after);
                if (blob) result.bytesAfter += blob.size;
            }
        };

        const yieldMain = () => new Promise<void>(r => setTimeout(r, 0));

        /**
         * 行级写回：这一行写不进去就只记一笔失败，接着跑下一行。
         *
         * 这几张表的写入口会等事务真的提交完才 resolve，配额满 / 事务 abort 都是从这里抛
         * 上来的。而本函数只有 finally 没有 catch，不在这儿接住的话，一行写失败就把整轮掐断
         * 在半路——后面的面全不跑，连回收最省的那步「合并重复图片」都轮不到，结果也返回不了。
         * 偏偏「存储快满」正是有人来点这个按钮的时候。
         *
         * 账按行退：这一行转出来的令牌一个都没落库，库里还是原来那份 base64，所以算
         * 「没省下来」（failed）而不是「省了」（converted）。退不掉的只有已经写进 blob 表的
         * 那几份二进制——它们现在没有任何字段引用着，是孤儿，交给孤儿清理收。
         */
        const writeRow = async (save: () => Promise<unknown>): Promise<void> => {
            try {
                await save();
            } catch (e) {
                const rolledBack = result.converted - rowTally.converted;
                result.converted = rowTally.converted;
                result.bytesBefore = rowTally.bytesBefore;
                result.uniqueBlobs = rowTally.uniqueBlobs;
                result.bytesAfter = rowTally.bytesAfter;
                for (const token of rowTally.newTokens) countedTokens.delete(token);
                // 一行里可能好几个字段一起没写进去，各记一笔。一个字段都没转、只改了别的
                // 东西的行（比如只归一化了引用快照）也得留下一笔，别让失败静默过去。
                const lost = Math.max(rolledBack, 1);
                result.failed += lost;
                const reason = `${currentFace}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
                result.failureReasons[reason] = (result.failureReasons[reason] ?? 0) + lost;
            }
        };

        // ── 0) 扫库：谁和谁装的是同一份内容 ───────────────────────
        // 结果有两个用处：给内容记忆预热（下面转换时直接复用库里已有的那份），
        // 以及收尾时把存量重复合并掉。扫不动就整轮跳过去重，转换照跑。
        const scan = await blobStore.scanContent({
            onProgress: (done, total) => onProgress?.({ label: '查找重复图片', done, total }),
        });
        // 每条都算不出哈希（非安全上下文没有 crypto.subtle）和「真没重复」长得一模一样，
        // 这里一并当作「这轮没做成去重」报出去，别让它静默过去。
        // 判据靠 SDK 那两个计数器互斥：算出哈希才 scanned++，读不出 / 算不动一律 skipped++。
        // 所以「一条都没成」写作 skipped > 0 且 scanned === 0——空库两个都是 0，不算不可用；
        // 只坏了几条时 scanned 仍大于 0，去重照跑，也不算。
        result.scanUnavailable = scan.aborted || (scan.skipped > 0 && scan.scanned === 0);

        // 被「换图即删」的字段引用着的令牌不能拿来共享：对方一删，这边就破图。
        const unmergeable = result.scanUnavailable ? new Set<string>() : await collectUnmergeableRefs();
        if (!result.scanUnavailable) {
            const safeByHash = new Map<string, string[]>();
            for (const [hash, tokens] of scan.byHash) {
                const safe = tokens.filter(t => !unmergeable.has(t));
                if (safe.length > 0) safeByHash.set(hash, safe);
            }
            primeContentMemo(safeByHash);
        }

        // ── 进度条的总数：九张表各数一下行数 ─────────────────────
        // 只要个数字，count() 不读行里的内容，几十 MB 的图不会被顺带读进内存。
        let total = 0;
        for (const storeName of OPTIMIZE_TARGET_STORES) total += await DB.countStoreRows(storeName);
        let done = 0;
        // total 是开跑那一刻的快照。跑的中途别处往这几张表写了行，实际走过的行数就跟它对不上：
        // 多出来的行照样处理，只是报出去的 done 按 total 封顶——done 只增不减也不越过 total，
        // 进度条既不会倒退也不会冲过头；行变少时它停在不满格的位置，函数返回即收尾
        // （展示侧本来就以返回为准，不靠进度条判完成）。
        // 每行开头都会走一趟，顺手把记账起点也刷了——writeRow 退账靠的就是这个读数，
        // 少刷一次就会把上一行的账一起退掉。
        const tick = (label: string) => { currentFace = label; rowTally = rowStart(); done++; onProgress?.({ label, done: Math.min(done, total), total }); };

        // ── 1) assets 表 ─────────────────────────────────────────
        for await (const a of iterateStoreRows<{ id: string; data: string }>('assets')) {
            tick('系统外观');
            if (typeof a.data !== 'string') continue;
            if (PLAIN_ASSET_IDS.has(a.id) || a.id.startsWith('icon_') || a.id.startsWith('widget_')) {
                const token = await convert(a.data);
                if (token) { await writeRow(() => DB.saveAsset(a.id, token)); await yieldMain(); }
            } else if (a.id.startsWith('appearance_preset_')) {
                let preset: AppearancePreset;
                try { preset = JSON.parse(a.data); } catch { continue; }
                if (!preset || typeof preset !== 'object' || !preset.theme) continue;
                const beforeFields = presetImageFields(preset);
                const migrated = await migrateAppearancePresetBlobRefs(preset);
                const afterFields = presetImageFields(migrated);
                let changed = false;
                for (let i = 0; i < beforeFields.length; i++) {
                    if (beforeFields[i] !== afterFields[i]) { changed = true; await tallyPair(beforeFields[i], afterFields[i]); }
                }
                if (changed) { await writeRow(() => DB.saveAsset(a.id, JSON.stringify(migrated))); await yieldMain(); }
            } else if (a.id === 'spark_social_profile') {
                // 社交主页的个人资料 JSON，图只有 avatar 一个字段。
                let profile: { avatar?: string };
                try { profile = JSON.parse(a.data); } catch { continue; }
                if (!profile || typeof profile !== 'object') continue;
                const token = await convert(profile.avatar);
                if (token) { profile.avatar = token; await writeRow(() => DB.saveAsset(a.id, JSON.stringify(profile))); await yieldMain(); }
            } else if (a.id === 'room_custom_assets_list') {
                let list: Array<{ image?: string }>;
                try { list = JSON.parse(a.data); } catch { continue; }
                if (!Array.isArray(list)) continue;
                let changed = false;
                for (const entry of list) {
                    const token = await convert(entry?.image);
                    if (token) { entry.image = token; changed = true; }
                }
                if (changed) { await writeRow(() => DB.saveAsset(a.id, JSON.stringify(list))); await yieldMain(); }
            }
        }

        // ── 2) characters：角色头像 + 小屋图 ──────────────────────
        // 两样东西在同一趟遍历里一起转。别拆成两趟：翻页靠主键推进，多一趟就是把整张表
        // 连同行里那些几 MB 的图再读一遍（见 iterateStoreRows 的注释）。
        for await (const c of iterateStoreRows<CharacterProfile>('characters')) {
            tick('角色头像与小屋');
            let changed = false;
            // ⚠️ 这一段必须跑在下面转立绘之前：它靠「立绘的字面值」反查情绪键，
            // 立绘一旦换成令牌就再也对不上了。
            //
            // savedDateState.currentSprite 是历史残留——见面存档现在只记情绪键
            // （DateSession 的 currentSpriteKey），types.ts 也把它标了 @deprecated。
            // 它躺的是整张立绘的 base64 副本，一条就能占近 1 MB。
            // 这里不转成令牌而是直接扔掉：转了也只是把「拿值反查键」这条脆链路
            // 从 base64 换成令牌，两边同进同退才成立；反查出键补上再删字段，
            // 空间归零，恢复存档时照样定位得到当时那个表情。
            const saved = (c as any).savedDateState;
            if (saved && typeof saved.currentSprite === 'string' && saved.currentSprite) {
                if (!saved.currentSpriteKey) {
                    const inferred = inferSavedSpriteKey(c, saved);
                    if (inferred) saved.currentSpriteKey = inferred;
                }
                delete saved.currentSprite;
                changed = true;
            }
            // 头像是两用字段：可能是图，也可能是个 emoji，还可能是 http 外链或已经是令牌。
            // convert 只认 data:image/ 开头的值，其余一律原样不动。
            const avatarToken = await convert(c.avatar);
            if (avatarToken) { c.avatar = avatarToken; changed = true; }

            // 桌面陪伴形象 / 视频舞台背景 / 桌面背景：这三个是「换图即删」字段，
            // 只能走 convertExclusive，理由见那个函数的注释。
            //
            // 衣柜里那份必须跟顶层 imageRef 转成同一个令牌：companionWardrobe 拿令牌
            // 当条目 id 认亲（utils/companionWardrobe.ts 的 activeUploadedOutfit 与
            // listUploadedCompanionOutfits），两边给出不同令牌的话，当前穿着的这套会在
            // 衣柜里裂成两条重复项。非去重的 put 每次都产新令牌，所以这里必须行内记账。
            //
            // 记账只在 companionAvatar 这一坨里通用，不跨到下面两个背景字段：它们各自也是
            // 裸删的，共享令牌等于把连坐从「别的表」搬到「同一行里」。
            const companion = (c as any).companionAvatar;
            if (companion && typeof companion === 'object') {
                const seen = new Map<string, string>();
                const convertOnce = async (value: unknown): Promise<string | null> => {
                    if (typeof value !== 'string') return null;
                    const hit = seen.get(value);
                    if (hit) return hit;
                    const token = await convertExclusive(value);
                    if (token) seen.set(value, token);
                    return token;
                };
                const imageToken = await convertOnce(companion.imageRef);
                if (imageToken) { companion.imageRef = imageToken; changed = true; }
                if (Array.isArray(companion.imageWardrobe)) {
                    for (const outfit of companion.imageWardrobe) {
                        const token = await convertOnce(outfit?.imageRef);
                        if (token) { outfit.imageRef = token; changed = true; }
                    }
                }
            }
            for (const key of ['videoCallBackground', 'companionBackground'] as const) {
                const token = await convertExclusive((c as any)[key]);
                if (token) { (c as any)[key] = token; changed = true; }
            }

            const rc = (c as any).roomConfig;
            if (rc) {
                for (const key of ['wallImage', 'floorImage']) {
                    const token = await convert(rc[key]);
                    if (token) { rc[key] = token; changed = true; }
                }
                if (Array.isArray(rc.items)) {
                    for (const item of rc.items) {
                        const token = await convert(item?.image);
                        if (token) { item.image = token; changed = true; }
                    }
                }
            }
            // 聊天页背景与见面场景背景。两个字段的读写端都已改成认令牌
            // （Chat / ChatModals / DateSettings / DateSession / CheckPhone / PersonaSim），
            // 这里收存量。
            for (const key of ['chatBackground', 'dateBackground'] as const) {
                const token = await convert((c as any)[key]);
                if (token) { (c as any)[key] = token; changed = true; }
            }
            // 彼方 / 小小窝的 Q 版形象。写端存的是裸 dataURL（ChibiStudio、VRWorldApp），
            // 所以这一面确实有存量——别被「chibi 都是令牌原生」的印象骗了。
            const vrChibi = (c as any).vrState?.chibi;
            if (vrChibi) {
                const token = await convert(vrChibi.img);
                if (token) { vrChibi.img = token; changed = true; }
            }
            // 「查手机」通讯录里的联系人头像，值是角色头像的副本。
            const contacts = (c as any).phoneState?.contacts;
            if (Array.isArray(contacts)) {
                for (const contact of contacts) {
                    const token = await convert(contact?.avatar);
                    if (token) { contact.avatar = token; changed = true; }
                }
            }
            // 活动留存记录里的聊天卡片头像。**只走这一条精确路径**，绝不能对
            // specialMomentRecords 整体深度遍历——隔壁 like520 的 customData.charChibi.dataUrl
            // 是刻意保持 dataURL 的（520 活动那边全是裸 img + canvas 合成，令牌过不去），
            // 顺手转掉就是永久破图。
            const moments = (c as any).specialMomentRecords;
            if (moments && typeof moments === 'object') {
                for (const key of Object.keys(moments)) {
                    // 活动自己留的那张大图（白色情人节的明信片、520 的定妆照）。
                    const momentImage = await convert(moments[key]?.image);
                    if (momentImage) { moments[key].image = momentImage; changed = true; }
                    const chatCard = moments[key]?.customData?.chatCard;
                    if (!chatCard) continue;
                    const token = await convert(chatCard.charAvatar);
                    if (token) { chatCard.charAvatar = token; changed = true; }
                }
            }
            // 见面立绘：角色默认那套 + 每个换装套装各一套，结构一样，走同一个转换。
            // 漏掉换装那侧是这一面最容易犯的错——不报错也不破图，只是没省下来。
            if (await migrateSpriteMap((c as any).sprites)) changed = true;
            if (Array.isArray((c as any).dateSkinSets)) {
                for (const skin of (c as any).dateSkinSets) {
                    if (await migrateSpriteMap(skin?.sprites)) changed = true;
                }
            }
            if (changed) { await writeRow(() => DB.saveCharacter(c)); await yieldMain(); }
        }

        // ── 3) songs 封面 ─────────────────────────────────────────
        for await (const s of iterateStoreRows<SongSheet>('songs')) {
            tick('歌曲封面');
            const token = await convert((s as any).coverImage);
            if (token) { (s as any).coverImage = token; await writeRow(() => DB.saveSong(s)); await yieldMain(); }
        }

        // ── 4) 捏人器自定义部件 ───────────────────────────────────
        for await (const p of iterateStoreRows<CustomCreatorPart>('cc_custom_parts')) {
            tick('捏人器部件');
            const srcIsData = typeof p.src === 'string' && p.src.startsWith('data:');
            const shadowIsData = typeof p.shadowSrc === 'string' && p.shadowSrc.startsWith('data:');
            if (!srcIsData && !shadowIsData) continue;
            const migrated: CustomCreatorPart = await creatorPartToBlobRefs(p);
            if (migrated.src === p.src && migrated.shadowSrc === p.shadowSrc) continue;
            await tallyPair(p.src, migrated.src);
            await tallyPair(p.shadowSrc, migrated.shadowSrc);
            await writeRow(() => DB.saveCustomCreatorPart(migrated));
            await yieldMain();
        }

        // ── 5) 相册 ───────────────────────────────────────────────
        // 聊天里发的每张图都会存一份进来，是最容易堆大的一面。
        for await (const g of iterateStoreRows<GalleryImage>('gallery')) {
            tick('相册');
            const token = await convert(g.url);
            if (token) { g.url = token; await writeRow(() => DB.saveGalleryImage(g)); await yieldMain(); }
        }

        // ── 6) 聊天气泡主题 ───────────────────────────────────────
        // 一套主题分用户侧和角色侧，每侧各带底纹、气泡贴纸、头像挂件三张图，最多 6 张。
        // 两侧字段名一样，所以两层循环走同一份清单；漏掉一侧是这一面最容易犯的错。
        for await (const t of iterateStoreRows<ChatTheme>('themes')) {
            tick('气泡主题');
            let changed = false;
            for (const side of ['user', 'ai'] as const) {
                const style = t[side];
                if (!style) continue;
                for (const key of ['backgroundImage', 'decoration', 'avatarDecoration'] as const) {
                    const token = await convert(style[key]);
                    if (token) { style[key] = token; changed = true; }
                }
            }
            if (changed) { await writeRow(() => DB.saveTheme(t)); await yieldMain(); }
        }

        // ── 7) 聊天图与表情消息 ───────────────────────────────────
        // 全库最大的一张表（两万多行、20 MB 量级），也是唯一一张「绝大多数行跟图片无关」的：
        // 只有 type 为 image / emoji 的行，content 里躺的才是图片。别的类型（文本、各种卡片
        // 的 JSON、转账…）一个字节都不许动——先按 type 卡一道，再交给只吃 data:image/ 的
        // convert，两道一起挡住「正文恰好长得像 data URL 的文本消息」。
        // 转出来的令牌可能跟相册那一面是同一个（同一张图发出去时两边各存了一份引用），
        // 这正是要的效果：一份 Blob 两处引用，删其中一处也绝不能直接删 Blob。
        // 一行最多有两处要动：正文（图片行是整张图，卡片行是 JSON 里的头像副本）和引用快照。
        // 两处合成一次整行写回——图片行也可能带引用（引用一条图片消息后回了张图 / 一个表情），
        // 谁要是让某类行提前跳过引用那段，那几 MB 的快照副本就永久留库：正文一旦转成令牌，
        // 重跑优化连正文都不动了，再也补不上。
        for await (const m of iterateStoreRows<Message>('messages')) {
            tick('聊天图片');
            let changed = false;

            if (m.type === 'image' || m.type === 'emoji') {
                const token = await convert(m.content);
                if (token) { m.content = token; changed = true; }
            } else {
                // 其余类型的行里也压着图，但都是「副本」：卡片上印的角色头像、通话结束卡上的
                // 头像、分享出去的帖子快照。逐个字段定向处理，不做深度遍历
                // ——同一坨 JSON 里还躺着 520 的手办图，那个是刻意留 dataURL 的。

                // 卡片正文：content 是一段 JSON。只认这两个字段名。
                if (typeof m.content === 'string' && m.content.startsWith('{')) {
                    try {
                        const card = JSON.parse(m.content);
                        if (card && typeof card === 'object') {
                            // 用行内的小旗子而不是外面那个 changed：外面那个会被别处的改动
                            // 点亮，拿它当判据的话，一张图都没转到的卡片也会被重新 stringify
                            let cardChanged = false;
                            for (const key of CARD_IMAGE_KEYS) {
                                const token = await convert(card[key]);
                                if (token) { card[key] = token; cardChanged = true; }
                            }
                            if (cardChanged) { m.content = JSON.stringify(card); changed = true; }
                        }
                    } catch { /* 不是 JSON 的正文原样不动 */ }
                }

                const meta = (m as any).metadata;
                if (meta && typeof meta === 'object') {
                    // metadata.scoreCard 是同一张卡的另一份副本，而且读端优先读它——
                    // 只转 content 那份等于白转。两边必须一起。
                    const card = meta.scoreCard;
                    if (card && typeof card === 'object') {
                        for (const key of CARD_IMAGE_KEYS) {
                            const token = await convert(card[key]);
                            if (token) { card[key] = token; changed = true; }
                        }
                    }
                    // 通话结束卡上留的角色头像
                    const callAvatar = await convert(meta.characterAvatar);
                    if (callAvatar) { meta.characterAvatar = callAvatar; changed = true; }
                    // 分享到聊天里的社交帖子快照
                    const post = meta.post;
                    if (post && typeof post === 'object') {
                        const authorToken = await convert(post.authorAvatar);
                        if (authorToken) { post.authorAvatar = authorToken; changed = true; }
                        if (Array.isArray(post.comments)) {
                            for (const comment of post.comments) {
                                const token = await convert(comment?.authorAvatar);
                                if (token) { comment.authorAvatar = token; changed = true; }
                            }
                        }
                        // post.images[] 不碰：渲染那头把它当成「可能是 emoji 的字符串」
                        // 直接印成文本（见 MessageItem 的 social_card 分支）。
                    }
                }
            }

            // 引用回复的内容快照：被引用的若是图片，这里存的是整张图的副本。
            // 这一段对所有类型的行都要跑到（图片 / 表情行照样能带引用），
            // 所以它待在上面那个 if / else 外面。
            // 不转令牌而是换成占位符——引用块本来就只显示纯文本（还截前 10 字），
            // 令牌摆在那儿既难看，被截断后剩下的 'blobref:b_' 还正好是所有令牌 id 的
            // 公共前缀，会让孤儿清理判定「引用面被截断了」从而整轮不敢删。
            // 新写入的快照已经直接写占位符（见 utils/applyAssistantPostProcessing.ts），
            // 这里把存量对齐过去。
            const replyTo = (m as any).replyTo;
            if (replyTo && typeof replyTo.content === 'string') {
                const quoted = replyTo.content.trim();
                if (quoted.startsWith('data:') || isBlobRef(quoted)) {
                    replyTo.content = '[图片]';
                    changed = true;
                }
            }

            if (changed) { await writeRow(() => DB.putStoreRows('messages', [m])); await yieldMain(); }
        }

        // ── 8) 表情库 ─────────────────────────────────────────────
        // url 有两种：用户上传的图（data:）和加进来的网络表情（http 外链）。外链是别人
        // 服务器上的地址，本机没有它的二进制，转不了也不用转——convert 只认 data:image/
        // 开头的值，外链天然落在判定之外。
        for await (const e of iterateStoreRows<Emoji>('emojis')) {
            tick('表情包');
            const token = await convert(e.url);
            if (token) { await writeRow(() => DB.saveEmoji(e.name, token, e.categoryId)); await yieldMain(); }
        }

        // ── 9) 我方头像（user_profile 单例）───────────────────────
        // 两处都要转：整体头像 avatar，和「分角色聊天头像」perCharAvatars（charId → 头像的
        // 对象，逐个值转）。只转 avatar 是这一面最容易犯的错——分角色那几张会静默留在 base64。
        // 写回用通用整行写回而不是 DB.saveUserProfile：后者会把主键强行按成 'me'，而这个
        // 循环的不重不漏建立在「主键一个都不动」上（见 iterateStoreRows 的注释）。
        for await (const p of iterateStoreRows<any>('user_profile')) {
            tick('我的头像');
            let changed = false;
            const avatarToken = await convert(p?.avatar);
            if (avatarToken) { p.avatar = avatarToken; changed = true; }
            const perChar = p?.perCharAvatars;
            if (perChar && typeof perChar === 'object') {
                for (const charId of Object.keys(perChar)) {
                    const token = await convert(perChar[charId]);
                    if (token) { perChar[charId] = token; changed = true; }
                }
            }
            // 我方的彼方 Q 版形象，跟角色那侧同一套渲染。
            const myChibi = p?.vrState?.chibi;
            if (myChibi) {
                const token = await convert(myChibi.img);
                if (token) { myChibi.img = token; changed = true; }
            }
            if (changed) { await writeRow(() => DB.putStoreRows('user_profile', [p])); await yieldMain(); }
        }

        // ── 10) 社交帖子：作者头像与评论头像 ─────────────────────
        // 都是角色 / 我方头像的副本，读端早就全是 TokenImg。
        // **只转这两个字段**：帖子自己的配图 images[] 读端还没改造，不在收录范围。
        for await (const post of iterateStoreRows<any>('social_posts')) {
            tick('社交帖子');
            let changed = false;
            const authorToken = await convert(post?.authorAvatar);
            if (authorToken) { post.authorAvatar = authorToken; changed = true; }
            if (Array.isArray(post?.comments)) {
                for (const comment of post.comments) {
                    const token = await convert(comment?.authorAvatar);
                    if (token) { comment.authorAvatar = token; changed = true; }
                }
            }
            if (changed) { await writeRow(() => DB.putStoreRows('social_posts', [post])); await yieldMain(); }
        }

        // ── 11) 群头像 ────────────────────────────────────────────
        // 用户没设头像时这里躺的是代码现画的 SVG 占位符，convert 会跳过（见它开头的判断）。
        for await (const g of iterateStoreRows<any>('groups')) {
            tick('群头像');
            const token = await convert(g?.avatar);
            if (token) { g.avatar = token; await writeRow(() => DB.putStoreRows('groups', [g])); await yieldMain(); }
        }

        // ── 12) 生活模拟：剧情日志里的角色头像副本 ────────────────
        // **只转 actorAvatar 这一条路径**。同一行里的 actionLog[].attachments[].imageUrl
        // 是裸 <img> 渲染的（apps/lifesim/StoryAttachments.tsx），整行深度遍历会把它一起
        // 转掉、永久破图。
        for await (const sim of iterateStoreRows<any>('life_sim')) {
            tick('生活模拟');
            if (!Array.isArray(sim?.actionLog)) continue;
            let changed = false;
            for (const action of sim.actionLog) {
                const token = await convert(action?.actorAvatar);
                if (token) { action.actorAvatar = token; changed = true; }
            }
            if (changed) { await writeRow(() => DB.putStoreRows('life_sim', [sim])); await yieldMain(); }
        }

        // ── 13) 合并存量重复：把重复令牌在全部引用面上改写成保留的那个 ──
        // 只改引用，不删 Blob。失去引用的那几份变成孤儿，由孤儿清理回收。
        if (!result.scanUnavailable && scan.duplicateGroups.length > 0) {
            const plan = buildMergePlan(scan.duplicateGroups, unmergeable);
            result.skippedGroups = plan.skippedGroups;
            if (plan.mapping.size > 0) {
                const rewrite = await rewriteBlobRefs(plan.mapping, {
                    onProgress: scanned => onProgress?.({ label: '合并重复图片', done: scanned, total: scanned }),
                });
                // 按「真改掉的那些」记账，不按计划数。上一轮合并留下的孤儿 Blob 还躺在库里，
                // 这一轮扫描照样把它当重复报出来，按计划数就会虚报一笔并不存在的收益。
                result.mergedDuplicates = rewrite.mergedRefs.size;
                for (const ref of rewrite.mergedRefs) {
                    result.reclaimableBytes += plan.bytesByToken.get(ref) ?? 0;
                }
            }
        }

        // ── 14) 记忆向量压成紧凑形态 ──────────────────────────────
        // 跟图片没有任何关系，单独一个 try：图片那几步的成果不该因为向量失败就报不出来。
        // 反过来也不吞错——开机那次后台扫描正是因为只 console.warn，卡住了也没人知道。
        try {
            const { MemoryVectorDB } = await import('./memoryPalace/db');
            result.vectorsCompacted = await MemoryVectorDB.scanAndMigrateLegacy((migrated, scanned) => {
                onProgress?.({ label: '压缩记忆向量', done: migrated, total: Math.max(scanned, migrated) });
            });
        } catch (e) {
            result.vectorError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        }

        try {
            const { MemoryLinkDB } = await import('./memoryPalace/db');
            result.linksCompacted = await MemoryLinkDB.compactStrengths((changed, scanned) => {
                onProgress?.({ label: '整理记忆连接精度', done: scanned, total: scanned });
            });
        } catch (e) {
            result.linkError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        }
        return result;
    } finally {
        releaseMaintenanceLock();
    }
}

/**
 * 见面存档里那张立绘对应哪个情绪键——趁立绘还是原值的时候反查出来。
 *
 * 取值顺序照搬 DateSession 的 getSpritesForSkin：先看存档自己记的换装套装，
 * 再看角色当前套装，最后才是角色默认那套。顺序错了会反查到另一套里同名的键上。
 */
function inferSavedSpriteKey(char: any, saved: any): string {
    const src = saved?.currentSprite;
    if (typeof src !== 'string' || !src) return '';
    const skins: any[] = Array.isArray(char?.dateSkinSets) ? char.dateSkinSets : [];
    const candidates: Array<Record<string, string> | undefined> = [];
    const bySavedSkin = saved.activeSkinSetId ? skins.find(sk => sk?.id === saved.activeSkinSetId) : undefined;
    if (bySavedSkin?.sprites) candidates.push(bySavedSkin.sprites);
    const byCharSkin = char?.activeSkinSetId ? skins.find(sk => sk?.id === char.activeSkinSetId) : undefined;
    if (byCharSkin?.sprites) candidates.push(byCharSkin.sprites);
    candidates.push(char?.sprites);
    for (const sprites of candidates) {
        if (!sprites) continue;
        const hit = Object.entries(sprites).find(([, value]) => value === src);
        if (hit) return hit[0];
    }
    return '';
}

/** 外观预设里参与令牌迁移的图片字段快照（顺序稳定，before/after 逐位对比用）。
 *  字段范围由 migrateAppearancePresetBlobRefs 决定，这里只是读它动过的位置。
 *  漏一个字段的后果不是报错，是「转换白跑一趟、预设一个字没变、全程零报错」——
 *  changed 判定完全靠这份清单，它看不见的改动等于没发生。 */
function presetImageFields(preset: AppearancePreset): Array<string | undefined> {
    const icons = preset.customIcons || {};
    const fields: Array<string | undefined> = [
        preset.theme?.wallpaper,
        (preset.theme as any)?.lockWallpaper,
        // 死字段，迁移时直接扔掉。不列进来的话，「只有它变了」的预设会被判成没变、写不回去
        (preset.theme as any)?.launcherWidgetImage,
        ...Object.keys(icons).sort().map(k => icons[k]),
        // 桌面小组件图：槽位键排序后展开，顺序才稳定
        ...Object.keys((preset.theme as any)?.launcherWidgets || {}).sort()
            .map(k => (preset.theme as any).launcherWidgets[k]),
    ];
    // 预设里内嵌的气泡主题：数组顺序就是预设里的顺序（稳定），每套按 user/ai 两侧 × 三张图展开
    for (const ct of preset.chatThemes || []) {
        for (const side of ['user', 'ai'] as const) {
            for (const key of CHAT_THEME_IMAGE_KEYS) fields.push(ct?.[side]?.[key]);
        }
    }
    return fields;
}
