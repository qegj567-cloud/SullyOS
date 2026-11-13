import { ContextBuilder } from '../context';
/**
 * Memory Palace — 房间门牌（Room Plates）
 *
 * 情景→语义的固化终点。房间装原始经历（MemoryNode，走向量召回），
 * 门牌写这些经历沉淀出的常驻认知（PlateEntry，每轮直接注入 System Prompt）。
 *
 * 两个更新触发点：
 *   1. EventBox 压缩/封盒（eventBoxCompression.ts）→ updatePlateFromBoxSummary()
 *      —— 盒子的结论就是最好的蒸馏原料，封盒即沉淀
 *   2. 认知消化（digestion.ts，50轮/手动）→ consolidateAllPlates()
 *      —— 四块门牌一次全量整理，容量压力挤掉过时条目
 *
 * 合并语义（不是追加）：LLM 每次输出目标房间的**完整**新条目列表，
 * 旧条目不被重新输出即被淘汰；带 basedOn 引用的条目继承 firstLearnedAt
 * 与 sourceCount（"这条认知是什么时候得知的、被印证过几次"）。
 *
 * 卧室门牌「我们之间」硬规则：只写现象与质地，禁止给关系命名——
 * 定义只存在于质地的负空间里。prompt 层约束 + mergePlateEntries 兜底过滤。
 */

import { readMaintenanceSettings } from './maintenanceMode';
import type { MemoryNode, PlateRoom, RoomPlate } from './types';
import { PLATE_ROOMS, PLATE_TITLES } from './types';
import { MemoryNodeDB, RoomPlateDB, loadOrCreatePlate, mutatePlate } from './db';
import type { LightLLMConfig } from './pipeline';
import { safeFetchJson } from '../safeApi';
import {
    PLATE_LLM_MAX_TOKENS,
    PLATE_LLM_TEMPERATURE,
    PLATE_LLM_TIMEOUT_MS,
    PLATE_USER_TURN,
    buildPlateConsolidationPrompt,
    mergeSubmissionsIntoEntries,
    parsePlateLlmReply,
} from './roomPlateCore';

// 提示词拼装、回复解析、合并语义都搬进 roomPlateCore 了——浏览器和 amsg worker
// 共用同一份，各写一份会让同一批材料在两条路上整理出不一样的门牌。这里只留
// 「读库 → 调用 → 落库」的编排。原有导出原样转发，调用方与单测不受影响。
export {
    isPlateRoom,
    mergePlateEntries,
    parseSubmissionLine,
    violatesBedroomRule,
} from './roomPlateCore';
export type { PlateLLMItem, PlateMaterial } from './roomPlateCore';
import type { PlateLLMItem, PlateMaterial } from './roomPlateCore';
import { isPlateRoom, mergePlateEntries } from './roomPlateCore';

// ─── LLM 蒸馏调用 ─────────────────────────────────────

/**
 * 一次 LLM 调用整理若干房间的门牌（浏览器侧那条路）。
 * 输入：每房间的现有条目（带标签）+ 新原料；输出：每房间完整的新条目列表。
 *
 * 请求仍走 safeFetchJson——那份带着「设置 → API 调用记录」的埋点，是浏览器侧的东西。
 * 提示词与解析共用 roomPlateCore，跟云端那条路一字不差。
 */
async function callPlateLLM(
    charId: string,
    charName: string,
    userName: string,
    plates: RoomPlate[],
    materials: PlateMaterial[],
    llmConfig: LightLLMConfig,
    identityContext: string,
    ): Promise<PlateLLMItem[]> {
    const systemPrompt = buildPlateConsolidationPrompt({
        charName,
        userName,
        identityContext,
        plates: plates.map(p => ({ room: p.room, entries: p.entries.map(e => e.text) })),
        materials,
    });

    const data = await safeFetchJson(
        `${llmConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${llmConfig.apiKey}`,
            },
            body: JSON.stringify({
                model: llmConfig.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: PLATE_USER_TURN },
                ],
                temperature: PLATE_LLM_TEMPERATURE,
                max_tokens: PLATE_LLM_MAX_TOKENS,
                stream: false,
            }),
        },
        2, PLATE_LLM_TIMEOUT_MS, { appId: 'memorypalace', appName: '记忆宫殿', charId, charName, purpose: '门牌整理' }
    );

    return parsePlateLlmReply(data.choices?.[0]?.message?.content || '');
}

/**
 * 送达保证兜底：把消化刚提交的候选**机械并入**门牌——同文本去重、容量上限、
 * 卧室命名过滤照常，不做改写重排。没有这一步，候选会静默蒸发：消化日志记着"已提交"，
 * 门牌上却什么都没有（提交的源节点已打 digestedAt，不会再来第二次）。
 * 下轮整理 LLM 会重排这些条目。
 *
 * 两条路都用它，但时机不同，所以 `why` 要说清是哪一种，别让日志误报：
 * 本地那条路是 LLM 整理没跑成（报错/输出解析为空）之后才兜底；
 * 上云那条路是**提交之前**先并进去保底——那时整理还没开始，什么都没失败。
 */
async function fallbackMergeSubmissions(
    plates: RoomPlate[],
    submissions: Partial<Record<PlateRoom, string[]>>,
    now: number,
    why: string = 'LLM 整理未跑成',
): Promise<PlateRoom[]> {
    const updated: PlateRoom[] = [];
    for (const plate of plates) {
        const lines = submissions[plate.room];
        if (!lines || lines.length === 0) continue;
        const before = plate.entries.length;
        // 走 mutatePlate：这块门牌上还有别的路在写（云端结果落地、门牌面板的手改），
        // 拿手上这份改完整块存回去就是把中间那次更新原地抹掉。
        const saved = await mutatePlate(plate.charId, plate.room, fresh => {
            const merged = mergeSubmissionsIntoEntries(fresh.room, fresh.entries, lines, now);
            return merged ? { ...fresh, entries: merged, updatedAt: now, version: fresh.version + 1 } : null;
        });
        if (!saved) continue;
        // 手上这份也要跟着换成落库后的那份：调用方随后拿 plates 当快照交给云端 / 交给
        // 本地 LLM，留着并入之前那份的话，这批刚保底的候选在 LLM 眼里压根不存在。
        plate.entries = saved.entries;
        plate.updatedAt = saved.updatedAt;
        plate.version = saved.version;
        updated.push(plate.room);
        console.warn(`🚪 [RoomPlate] 兜底并入「${PLATE_TITLES[plate.room]}」${saved.entries.length - before} 条候选（${why}）`);
    }
    return updated;
}

/**
 * 核心流程：加载目标门牌 → LLM 整理 → 合并落库。
 *
 * LLM 输出里**一个条目都没提到的房间**跳过保存——区分"LLM 决定清空"
 * 和"LLM 忘了这个房间/输出被截断"，宁可保守不动，等下轮消化再整理。
 * LLM 整体失败/输出为空时，prioritySubmissions（消化刚提交的候选）走机械兜底并入。
 *
 * `preferCloud` 的那条路见 roomPlateCloud.ts：整理交给用户自己的 CF Worker 跑，
 * 页面关着也能跑完，结果晚点回来再合并落库。交不出去就原地退回本地跑。
 */
async function consolidatePlates(
    charId: string,
    charName: string,
    userName: string,
    materials: PlateMaterial[],
    llmConfig: LightLLMConfig,
    prioritySubmissions?: Partial<Record<PlateRoom, string[]>>,
    preferCloud = false,
): Promise<{ updated: PlateRoom[]; cloudPending?: boolean }> {
    const rooms = materials.map(m => m.room);
    // 快照时刻要在**读之前**取。读完门牌之后还要拼身份上下文、过一遍能不能交云端那几道门
    // （其中一道要发请求）、把消化刚提交的候选先保底并进去，才轮到提交；这一段少则几百
    // 毫秒、多则好几秒，期间用户在门牌面板上改的字 LLM 是看不到的。取在读之后（更别说
    // 取在提交那一刻）就会把这段时间的编辑漏判成「LLM 见过」，一份陈旧结果回来把用户刚
    // 敲的字原样盖回去。宁可反过来错——顶多丢掉整理结果对那一条的改写。
    const snapshotAt = Date.now();
    const plates = await Promise.all(rooms.map(r => loadOrCreatePlate(charId, r)));

    const hasMaterial = materials.some(m => m.lines.length > 0);
    const hasEntries = plates.some(p => p.entries.length > 0);
    if (!hasMaterial && !hasEntries) {
        return { updated: [] };
    }

    /** 交云端失败之前，送达保证已经当场并入的房间。退回本地跑也要连它们一起报。 */
    let cloudRescued: PlateRoom[] = [];
    const withRescued = (updated: PlateRoom[]) => ({ updated: [...new Set([...cloudRescued, ...updated])] });

    // 身份上下文：直接走 ContextBuilder.buildCoreContext(char, user, false)——
    // 与全 App 统一的人设口径（身份/核心指令/世界观/用户画像/印象/核心记忆），不重复造轮子。
    // includeDetailedMemories=false：只省略神经链接详细日志；已有向量召回仍统一注入。
    // 尤其是回填场景，材料横跨几个月，没有人设参照时蒸馏视角会飘。

    let identityContext = '';
    try {
        const { DB } = await import('../db');
        const chars = await DB.getAllCharacters();
        const profile = chars.find(c => c.id === charId);
        const up = await DB.getUserProfile();
        if (profile && up) identityContext = (await ContextBuilder.buildCoreContext(profile, up, false));
    } catch { /* 拿不到就裸跑，prompt 里仍有名字与身份确认段 */ }

    if (preferCloud && !readMaintenanceSettings().enabled) {
        const cloud = await tryCloudConsolidation({
            charId, charName, userName, identityContext, plates, materials, llmConfig, prioritySubmissions, snapshotAt,
        });
        if (cloud.handled) return { updated: cloud.updated, cloudPending: cloud.pending };
        // 交不出去（没配 worker / 副 API 缺字段 / 服务端答复了不行）→ 原地退回本地跑。
        // plates 可能已经被上面的送达保证并入过候选，本地这轮拿到的就是并入后的那份，
        // LLM 的完整新列表照常覆盖它。
        cloudRescued = cloud.rescued;
    }

    let items: PlateLLMItem[] = [];
    try {
        items = await callPlateLLM(charId, charName, userName, plates, materials, llmConfig, identityContext);
    } catch (e: any) {
        if (llmConfig.deferPlateMaintenance) throw e;
        console.warn(`🚪 [RoomPlate] LLM 整理调用失败: ${e?.message || e}`);
    }
    if (items.length === 0) {
        if (llmConfig.deferPlateMaintenance) throw new Error('门牌整理没有返回有效内容，请稍后重试');
        console.warn(`🚪 [RoomPlate] LLM 未返回有效条目，门牌保持不动`);
        if (prioritySubmissions) {
            return withRescued(await fallbackMergeSubmissions(plates, prioritySubmissions, Date.now()));
        }
        return withRescued([]);
    }

    const now = Date.now();
    const updated: PlateRoom[] = [];
    const skippedPlates: RoomPlate[] = [];
    for (const plate of plates) {
        const roomItems = items.filter(i => i.room === plate.room);
        if (roomItems.length === 0) { skippedPlates.push(plate); continue; }
        // 同上：这块门牌上还有别的路在写，落库统一走 mutatePlate 那条队。
        const saved = await mutatePlate(plate.charId, plate.room, fresh => ({
            ...fresh,
            entries: mergePlateEntries(fresh.room, fresh.entries, roomItems, now),
            updatedAt: now,
            version: fresh.version + 1,
        }));
        if (!saved) continue;
        plate.entries = saved.entries;
        plate.updatedAt = saved.updatedAt;
        plate.version = saved.version;
        updated.push(plate.room);
        console.log(`🚪 [RoomPlate] 「${PLATE_TITLES[plate.room]}」v${saved.version}：${saved.entries.length} 条`);
    }
    // 半失败态：LLM 只给部分房间输出了条目。没被提到的房间若有本次提交的候选，
    // 同样机械兜底并入——按房间粒度保证送达。
    if (prioritySubmissions && skippedPlates.length > 0) {
        const rescued = await fallbackMergeSubmissions(skippedPlates, prioritySubmissions, now);
        updated.push(...rescued);
    }
    return withRescued(updated);
}

/**
 * 交云端这一轮的三种结局。
 *
 * `handled: false` 那支要把 `rescued` 一起交回去：送达保证已经真的把候选并进门牌、
 * 落库、升过版本号了。丢掉的话消化日志会说「这次一块门牌都没动」，而门牌上明明多了
 * 几条——本地那条路末尾的兜底并入是按文本去重的，那批已经在里面了，它一条也不会再报。
 */
type CloudConsolidationOutcome =
    /**
     * 云端接手了。`pending` = **云端正有一份整理在跑、结果会晚点落地**——这一轮刚交上去
     * 的算，上一份还没回来所以这轮没重复交的也算。它最后决定消化日志上说哪句话，问的是
     * 「门牌等会儿还会不会动」，不是「这一轮交没交」。两者混起来的话，第二种会被写成
     * 「⚠️ 本次提交的候选未合并进门牌（整理未跑成或未被采纳）」——而它正在用户自己的
     * Worker 上好好跑着，几分钟后就落地。
     */
    | { handled: true; updated: PlateRoom[]; pending: boolean }
    /** 交不出去，调用方退回本地跑。`rescued` 是送达保证当场并入的房间。 */
    | { handled: false; rescued: PlateRoom[] };

/**
 * 试着把这一轮整理交给云端。云端接手了（交出去了 / 上一份还在跑）就返回 `handled: true`
 * ——`updated` 只有送达保证当场并入的那些，整理结果要等它回来才落地；交不出去返回
 * `handled: false`，调用方退回本地跑。
 *
 * **送达保证要前置**：本地那条路是「LLM 挂了才机械并入候选」，而上云之后「挂没挂」
 * 要几分钟后才知道，候选的源节点却已经打了 digestedAt、不会再来第二次。所以改成
 * 先并进去保底，再把并入后的门牌当快照交上去——云端整理出的完整新列表会把这批粗糙
 * 条目改写掉，云端要是最终没回来，它们也已经在门牌上了，不会静默蒸发。
 */
async function tryCloudConsolidation(args: {
    charId: string;
    charName: string;
    userName: string;
    identityContext: string;
    plates: RoomPlate[];
    materials: PlateMaterial[];
    llmConfig: LightLLMConfig;
    prioritySubmissions?: Partial<Record<PlateRoom, string[]>>;
    /** `plates` 是什么时候读的（epoch 毫秒），原样传给提交侧记进在飞记号。 */
    snapshotAt: number;
}): Promise<CloudConsolidationOutcome> {
    // 动态 import：没开主动消息 2.0 的用户不该为这条路付首屏包体。
    // 只引这一个模块——「能不能交」那几道门也收在它里面（plateCloudGate），
    // 判定入口分散到两处的话，改一处漏一处就是「点了灯却走本地」那种查不出来的静默分流。
    const { plateCloudGate, readPlateJobInFlight, submitPlateConsolidation } = await import('./roomPlateCloud');

    const gate = await plateCloudGate({ charId: args.charId, lightLLM: args.llmConfig });
    if (gate === 'local') return { handled: false, rescued: [] };

    const rescued = args.prioritySubmissions
        ? await fallbackMergeSubmissions(args.plates, args.prioritySubmissions, Date.now(), '先保底再交云端整理')
        : [];

    // 上一份整理还在云端跑：这轮只做送达保证，整理本身不重复交也不退回本地——本地再全量
    // 跑一遍会白烧一次 API，跑出来的结果还会和在飞那份互相覆盖。
    // `pending: true` —— 云端确实有一份在跑，门牌等会儿就会动。报 false 的话，候选恰好
    // 都已经在门牌上（送达保证按文本去重、一条都没并进去）的那次消化，日志上会写成
    // 「整理未跑成」。
    if (gate === 'skip') return { handled: true, updated: rescued, pending: true };

    try {
        await submitPlateConsolidation({
            charId: args.charId,
            charName: args.charName,
            userName: args.userName,
            identityContext: args.identityContext,
            plates: args.plates,
            materials: args.materials,
            lightLLM: args.llmConfig,
            snapshotAt: args.snapshotAt,
        });
        return { handled: true, updated: rescued, pending: true };
    } catch (e: any) {
        // 在飞记号还在 = 请求发出去了却没等到答复，任务可能已经在云端建起来了（提交那侧
        // 只在「服务端答复了不行」时才收记号）。这时候退回本地全量跑一遍，就是拿同一份
        // 快照烧两次 API，两份结果还先后落地互相盖。宁可这轮不整理，等它回来。
        if (readPlateJobInFlight(args.charId)) {
            console.warn(`🚪 [RoomPlate] 交云端整理没等到答复，任务可能已经建起来了，这轮不退回本地: ${e?.message || e}`);
            return { handled: true, updated: rescued, pending: true };
        }
        console.warn(`🚪 [RoomPlate] 交云端整理失败，退回本地跑: ${e?.message || e}`);
        return { handled: false, rescued };
    }
}

// ─── 触发点 1：EventBox 压缩/封盒 → 增量合并 ─────────

/**
 * 盒子压缩完成后，把这次整合的结论合并进该房间的门牌。
 * 由 eventBoxCompression 调用；失败只 warn，不影响压缩结果。
 */
export async function updatePlateFromBoxSummary(
    charId: string,
    room: string,
    summaryContent: string,
    llmConfig: LightLLMConfig,
    charName: string,
    userName?: string,
): Promise<void> {
    if (!isPlateRoom(room)) return;
    if (!summaryContent?.trim()) return;
    await consolidatePlates(
        charId, charName, userName || '用户',
        [{ room, lines: [summaryContent.trim()] }],
        llmConfig,
    );
}

// ─── 触发点 2：认知消化 → 四块门牌全量整理 ───────────

/** 每房间送入 LLM 的原料上限与单条截断长度 */
const MATERIAL_NODES_PER_ROOM = 15;
const MATERIAL_LINE_MAX_CHARS = 160;
/** sinceTs 窗口之前的老节点最多留几条高分锚点（防止每轮重复喂同一批高分老货） */
const MATERIAL_ANCHOR_CAP = 5;

/**
 * 从房间里挑蒸馏原料，优先级：
 *   1. 盒子 summary（已是整合过的结论）
 *   2. sinceTs 之后的新节点（按时近降序）——"这段时间的新经历"
 *   3. sinceTs 之前的老节点按 importance 取最多 MATERIAL_ANCHOR_CAP 条锚点
 * 排除 archived（已被压进 summary）。sinceTs=0 时全部算新节点（老行为兼容）。
 */
export function pickMaterialLines(nodes: MemoryNode[], room: PlateRoom, sinceTs: number = 0): string[] {
    const candidates = nodes.filter(n => n.room === room && !n.archived);
    const summaries = candidates.filter(n => n.isBoxSummary);
    const fresh = candidates
        .filter(n => !n.isBoxSummary && n.createdAt > sinceTs)
        .sort((a, b) => b.createdAt - a.createdAt);
    const anchors = sinceTs > 0
        ? candidates
            .filter(n => !n.isBoxSummary && n.createdAt <= sinceTs)
            .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
            .slice(0, MATERIAL_ANCHOR_CAP)
        : [];
    return [...summaries, ...fresh, ...anchors]
        .slice(0, MATERIAL_NODES_PER_ROOM)
        .map(n => n.content.replace(/\s+/g, ' ').trim().slice(0, MATERIAL_LINE_MAX_CHARS));
}

/**
 * 全量整理四块门牌。由 runCognitiveDigestion 在消化尾声调用，
 * 也可从 UI 手动触发。一次 LLM 调用覆盖全部房间。
 *
 * @param extraMaterial 消化状态机之外提交的蒸馏候选（synthesize_user /
 *   internalize / self_insight / distill 的产出）。放在原料最前——它们是
 *   本次消化刚提炼的概括，优先级高于旧节点，且不占节点配额。
 * @param sinceTs 上次消化时间戳：节点原料以该时间之后的新增优先，
 *   老节点只留少量高分锚点（避免每轮重复喂同一批高分老货）。
 */
export async function consolidateAllPlates(
    charId: string,
    charName: string,
    userName: string | undefined,
    llmConfig: LightLLMConfig,
    extraMaterial?: Partial<Record<PlateRoom, string[]>>,
    sinceTs: number = 0,
): Promise<{ updated: PlateRoom[]; cloudPending?: boolean }> {
    const allNodes = await MemoryNodeDB.getByCharId(charId);
    const materials: PlateMaterial[] = PLATE_ROOMS.map(room => {
        const extra = (extraMaterial?.[room] || [])
            .map(l => l.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .map(l => l.slice(0, MATERIAL_LINE_MAX_CHARS * 2)); // 领悟全文可到 200 字，放宽截断
        return {
            room,
            lines: [...extra, ...pickMaterialLines(allNodes, room, sinceTs)],
        };
    });
    // extraMaterial 同时作为 prioritySubmissions 传入：LLM 整理失败时机械兜底并入，不许蒸发。
    //
    // 这个触发点走云端（配了主动消息 2.0 的话）：消化跑在一轮对话刚结束的时候，用户
    // 大概率正准备切走，而四块门牌全量整理是这条链上最慢的一次调用。同一个角色同时只许
    // 一份整理在飞（见 roomPlateCloud 的在飞记号），两份结果先后落地就是拿两份旧快照
    // 互相盖。另外两个触发点留在本地——盒子压缩那个一轮里可能跑好几次、后一次要看到前
    // 一次的结果；手动回填有进度条，批次之间也是串行依赖的。
    return consolidatePlates(charId, charName, userName || '用户', materials, llmConfig, extraMaterial, true);
}

// ─── 历史回填（Bootstrap — 老用户的门牌不能从零开始） ──

/** 回填每批每房间的行数 & 单角色回填的行数上限（超出取最新的，旧尾丢弃并 log） */
const BOOTSTRAP_LINES_PER_BATCH = 12;
export const BOOTSTRAP_MAX_LINES_PER_ROOM = 240;

/**
 * 收集某房间的全部历史原料，**时间正序**（旧→新）：
 * 分批喂给整理 LLM 时，后面的批次带着更新的事实，合并语义自然完成 supersede——
 * 和知识真实积累的顺序一致。盒子 summary 按自身 createdAt 参与排序。
 * 超过上限时丢最旧的（保留最新 N 条），返回丢弃数供 log。
 */
export function collectBootstrapNodes(
    nodes: MemoryNode[],
    room: PlateRoom,
    maxLines: number = BOOTSTRAP_MAX_LINES_PER_ROOM,
): { nodes: MemoryNode[]; dropped: number } {
    const candidates = nodes
        .filter(n => n.room === room && !n.archived)
        .sort((a, b) => a.createdAt - b.createdAt);
    const dropped = Math.max(0, candidates.length - maxLines);
    return { nodes: dropped > 0 ? candidates.slice(dropped) : candidates, dropped };
}

export function collectBootstrapLines(
    nodes: MemoryNode[],
    room: PlateRoom,
    maxLines: number = BOOTSTRAP_MAX_LINES_PER_ROOM,
): { lines: string[]; dropped: number } {
    const { nodes: kept, dropped } = collectBootstrapNodes(nodes, room, maxLines);
    return {
        lines: kept.map(n => n.content.replace(/\s+/g, ' ').trim().slice(0, MATERIAL_LINE_MAX_CHARS)),
        dropped,
    };
}

/**
 * 从历史记忆回填门牌：把四个门牌房间的全部积压分批过整理 LLM。
 *
 * 触发方式：
 *   - 自动：消化尾声发现"门牌全空但历史可观"时跑一次（批数受 maxBatches 限制，
 *     控制后台成本；没扫完的部分等手动触发补完）
 *   - 手动：记忆宫殿 App「从历史记忆重建门牌」按钮（全量批次 + 进度回调）
 *
 * 幂等性：合并语义天然幂等——重复回填同样的历史，条目被去重/合并而非翻倍。
 */
export async function bootstrapPlatesFromHistory(
    charId: string,
    charName: string,
    userName: string | undefined,
    llmConfig: LightLLMConfig,
    options: {
        maxBatches?: number;
        /** 历史总行数低于此值直接跳过（常规整理足以覆盖小历史，不值得跑回填） */
        minLines?: number;
        /** 断点续传：从第几批开始（0 起）。历史近似 append-only + 稳定排序，批次边界跨次稳定 */
        startBatch?: number;
        /** 进度回调：done/total 都是全量口径（绝对批次序号 / 总批数） */
        onProgress?: (done: number, total: number) => void;
    } = {},
): Promise<{ updated: PlateRoom[]; batches: number; totalLines: number; neededBatches: number; nextBatch: number; complete: boolean }> {
    const allNodes = await MemoryNodeDB.getByCharId(charId);
    const byRoom = new Map<PlateRoom, MemoryNode[]>();
    let totalLines = 0;
    for (const room of PLATE_ROOMS) {
        const { nodes: kept, dropped } = collectBootstrapNodes(allNodes, room);
        if (dropped > 0) {
            console.warn(`🚪 [Bootstrap] 「${PLATE_TITLES[room]}」历史超上限，丢弃最旧 ${dropped} 条（保留最新 ${BOOTSTRAP_MAX_LINES_PER_ROOM}）`);
        }
        byRoom.set(room, kept);
        totalLines += kept.length;
    }
    if (totalLines === 0 || totalLines < (options.minLines ?? 0)) {
        return { updated: [], batches: 0, totalLines, neededBatches: 0, nextBatch: 0, complete: false };
    }

    const neededBatches = Math.max(
        ...PLATE_ROOMS.map(r => Math.ceil((byRoom.get(r)!.length) / BOOTSTRAP_LINES_PER_BATCH)),
    );
    const startBatch = Math.max(0, Math.min(options.startBatch ?? 0, neededBatches));
    const endBatch = Math.min(neededBatches, startBatch + (options.maxBatches ?? neededBatches));
    if (startBatch > 0 || endBatch < neededBatches) {
        console.log(`🚪 [Bootstrap] 本次跑第 ${startBatch + 1}~${endBatch} 批（共 ${neededBatches} 批）——没跑完的部分下次续传`);
    }

    const fmtLine = (n: MemoryNode) => n.content.replace(/\s+/g, ' ').trim().slice(0, MATERIAL_LINE_MAX_CHARS);
    const updatedSet = new Set<PlateRoom>();
    let ran = 0;
    let nextBatch = startBatch;
    for (let i = startBatch; i < endBatch; i++) {
        const batchNodes = PLATE_ROOMS.flatMap(room =>
            byRoom.get(room)!.slice(i * BOOTSTRAP_LINES_PER_BATCH, (i + 1) * BOOTSTRAP_LINES_PER_BATCH));
        if (batchNodes.length === 0) { nextBatch = i + 1; continue; }
        const materials: PlateMaterial[] = PLATE_ROOMS.map(room => ({
            room,
            lines: byRoom.get(room)!.slice(i * BOOTSTRAP_LINES_PER_BATCH, (i + 1) * BOOTSTRAP_LINES_PER_BATCH).map(fmtLine),
        }));
        // 进度在批次**开始**时上报：慢批次跑着的时候用户看到的是"正在第 N 批"，
        // 而不是上一批的旧数字挂着像死机（LLM 调用已有 120s/次硬超时兜底）
        options.onProgress?.(i + 1, neededBatches);
        try {
            const { updated } = await consolidatePlates(charId, charName, userName || '用户', materials, llmConfig);
            updated.forEach(r => updatedSet.add(r));
        } catch (e: any) {
            console.warn(`🚪 [Bootstrap] 第 ${i + 1}/${neededBatches} 批整理失败（继续下一批）: ${e?.message || e}`);
        }
        // 判过"该不该上门牌"的历史节点打标退场：不再进后续消化的送审候选，
        // 也和续传指针语义一致（该批不会再被扫）。与批次成败无关——resume 同样跳过失败批。
        const seenAt = Date.now();
        for (const n of batchNodes) {
            if (!n.digestedAt) {
                n.digestedAt = seenAt;
                try { await MemoryNodeDB.save(n); } catch { /* 单条失败无害，最多下轮多看一眼 */ }
            }
        }
        ran++;
        nextBatch = i + 1;
    }
    const complete = nextBatch >= neededBatches;
    console.log(`🚪 [Bootstrap] 本次 ${ran} 批 / 进度 ${nextBatch}/${neededBatches}${complete ? '（已还清）' : ''} → 更新 ${[...updatedSet].length} 块门牌`);
    return { updated: [...updatedSet], batches: ran, totalLines, neededBatches, nextBatch, complete };
}

// 回填进度（断点续传）：跑一半关页面/自动限批没跑完时，从这里接着还
const BOOTSTRAP_PROGRESS_KEY = (charId: string) => `mp_plateBootstrapBatch_${charId}`;
export function getBootstrapResume(charId: string): number {
    try {
        const v = parseInt(localStorage.getItem(BOOTSTRAP_PROGRESS_KEY(charId)) || '0', 10);
        return isNaN(v) || v < 0 ? 0 : v;
    } catch { return 0; }
}
export function setBootstrapResume(charId: string, nextBatch: number): void {
    try { localStorage.setItem(BOOTSTRAP_PROGRESS_KEY(charId), String(nextBatch)); } catch {}
}
export function clearBootstrapResume(charId: string): void {
    try { localStorage.removeItem(BOOTSTRAP_PROGRESS_KEY(charId)); } catch {}
}

/** 门牌是否全空（自动回填的触发判据之一） */
export async function arePlatesEmpty(charId: string): Promise<boolean> {
    const plates = await RoomPlateDB.getByCharId(charId);
    return plates.every(p => p.entries.length === 0);
}

// 回填完成标记：防"LLM 判定无可立牌"时每次消化都重扫历史的成本循环。
// 自动路径查/设；手动全量回填完成后也设（并可无视它强制重跑）。
const BOOTSTRAP_FLAG_KEY = (charId: string) => `mp_plateBootstrapped_${charId}`;
export function isPlateBootstrapDone(charId: string): boolean {
    try { return !!localStorage.getItem(BOOTSTRAP_FLAG_KEY(charId)); } catch { return false; }
}
export function markPlateBootstrapDone(charId: string): void {
    try { localStorage.setItem(BOOTSTRAP_FLAG_KEY(charId), String(Date.now())); } catch {}
}

// ─── 注入：格式化为常驻 System Prompt 段落 ───────────

/**
 * 门牌 → Markdown 段落。空门牌跳过；全空返回 ''。
 *
 * 注入框架是设计核心：这些是 constraint（认知底色，防说错话），
 * 不是 topic（不要老念叨）——对应人脑"背景知识常在但低激活"的状态。
 */
export function formatRoomPlatesSection(plates: RoomPlate[], userName?: string): string {
    const userLabel = userName || '用户';
    const byRoom = new Map(plates.map(p => [p.room, p]));
    const sections: string[] = [];

    for (const room of PLATE_ROOMS) {
        const plate = byRoom.get(room);
        if (!plate || plate.entries.length === 0) continue;
        const title = room === 'user_room' ? `关于${userLabel}` : PLATE_TITLES[room];
        const suffix = room === 'bedroom' ? '（没有名字，也不需要名字——只有质地）' : '';
        sections.push(
            `**${title}**${suffix}\n` +
            plate.entries.map(e => `- ${e.text}`).join('\n')
        );
    }

    if (sections.length === 0) return '';

    return `### 底色认知 (Resident Knowledge)
以下是你早已知道的背景。它们是你认知的底色，不是话题——不要主动提起，也不要逐条复述，只在相关时让它们自然影响你的反应、措辞与温度。

${sections.join('\n\n')}
`;
}

/** 加载某角色的全部门牌并格式化（纯 IDB 读，不调 LLM，供 pipeline 每轮注入用） */
export async function buildRoomPlatesInjection(charId: string, userName?: string): Promise<string> {
    try {
        const plates = await RoomPlateDB.getByCharId(charId);
        return formatRoomPlatesSection(plates, userName);
    } catch (e: any) {
        console.warn(`🚪 [RoomPlate] 加载门牌失败: ${e?.message || e}`);
        return '';
    }
}
