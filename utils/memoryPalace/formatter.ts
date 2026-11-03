/**
 * Memory Palace — 召回结果格式化（EventBox 感知）
 *
 * 输入：hybridSearch + spreadActivation 后排序好的 ScoredMemory[]
 * 输出：注入 system prompt 的 markdown 文本
 *
 * 关键规则：
 *  - 命中盒内任一活节点 → 整盒（summary + 所有活节点）作为 1 个名额
 *  - 命中独立记忆（无 eventBoxId）→ 1 个名额
 *  - 同一 box 多次命中只算 1 次（按 box id 去重）
 *  - 总名额上限 MAX_OUTPUT_ITEMS（默认 15）
 *  - 便利贴置顶不占名额
 */

import type { Anticipation, EventBox, MemoryNode, ScoredMemory } from './types';
import { ROOM_CONFIGS, getRoomLabel } from './types';
import { MemoryNodeDB, EventBoxDB } from './db';
import { recordRecallReceipt } from './recallReceipts';
import { formatMemoryDateWithDistance } from './memoryDate';
import { memoryContentWithDates } from './relativeTime';

const DEFAULT_MAX_OUTPUT_ITEMS = 15;
const MAX_LIVE_NODES_PER_BOX = 8; // 单盒最多展开多少条活节点（防止超大盒污染）

interface RenderItem {
    /** 精确信号命中项在普通 score 排序前保底进入。 */
    guaranteed: boolean;
    /** 用于排序：取该 item 内最高的 finalScore */
    score: number;
    /** 用于按房间分组的代表房间 */
    room: string;
    /** 渲染好的内容文本块（不含 room 头） */
    body: string;
    /** 创建时间（用于次级排序） */
    createdAt: number;
    /** 重要性（用于次级排序） */
    importance: number;
    /** 调试日志用 */
    debugLabel: string;
    /** 实际落到 prompt 里的 memoryId 列表（事件盒会展开成 summary + 活节点） */
    sourceIds: string[];
}

/**
 * 话题盒展开 + 格式化为 Markdown
 *
 * 1. 加载便利贴置顶（不占 15 条名额）
 * 2. 把 ScoredMemory 按 eventBoxId 去重分组：
 *    - 命中带 eventBoxId 的记忆 → 整盒展开（summary + 活节点）
 *    - 独立记忆 → 单条展开
 * 3. 占用 MAX_OUTPUT_ITEMS 个名额，按 score 排序后按房间渲染
 */
export async function expandAndFormat(
    results: ScoredMemory[],
    charId: string,
    anticipations: Anticipation[] = [],
    userName?: string,
    /** 注入上限。rerank 启用时传 15 + topN，让 rerank 额外召回的不被切。 */
    maxOutputItems: number = DEFAULT_MAX_OUTPUT_ITEMS,
    options?: { omitDates?: boolean },
): Promise<string> {
    const MAX_OUTPUT_ITEMS = maxOutputItems;
    const omitDates = options?.omitDates === true;
    // 0. 加载便利贴置顶记忆（pinnedUntil > now，不占 15 条名额）
    const now = Date.now();
    const allCharNodes = await MemoryNodeDB.getByCharId(charId);
    const pinnedNodes = allCharNodes.filter(n => n.pinnedUntil && n.pinnedUntil > now && !n.archived);
    const pinnedIds = new Set(pinnedNodes.map(n => n.id));

    if (results.length === 0 && anticipations.length === 0 && pinnedNodes.length === 0) return '';

    // 1. 按 eventBoxId 去重分组（同一 box 多次命中合并；保留命中里最高分作 box 分）
    //    boxItem: { boxId, topScore, hitNodeIds[] }
    const boxHits = new Map<string, { topScore: number; hitNodeIds: Set<string>; sample: ScoredMemory; guaranteed: boolean }>();
    const standaloneItems: ScoredMemory[] = [];

    for (const r of results) {
        if (pinnedIds.has(r.node.id)) continue; // 已置顶不再下沉到列表里
        if (r.node.archived) continue;          // 防御：理论上 archived 不会到这里

        const ebId = r.node.eventBoxId;
        if (ebId) {
            const cur = boxHits.get(ebId);
            if (!cur) {
                boxHits.set(ebId, {
                    topScore: r.finalScore,
                    hitNodeIds: new Set([r.node.id]),
                    sample: r,
                    guaranteed: r.recallGuarantee === 'explicit_entity',
                });
            } else {
                if (r.finalScore > cur.topScore) cur.topScore = r.finalScore;
                cur.hitNodeIds.add(r.node.id);
                if (r.recallGuarantee === 'explicit_entity') cur.guaranteed = true;
            }
        } else {
            standaloneItems.push(r);
        }
    }

    // 2. 加载所有 box 的完整内容
    const renderItems: RenderItem[] = [];
    const localNodeMap = new Map(allCharNodes.map(n => [n.id, n]));

    for (const [boxId, hit] of boxHits) {
        const box = await EventBoxDB.getById(boxId);
        if (!box) {
            // box 丢失 → 退化为单条命中
            renderItems.push(buildStandaloneItem(hit.sample, now, omitDates));
            continue;
        }
        const item = await buildBoxItem(box, hit.topScore, localNodeMap, now, hit.guaranteed, omitDates);
        if (item) renderItems.push(item);
    }

    for (const r of standaloneItems) {
        renderItems.push(buildStandaloneItem(r, now, omitDates));
    }

    // 3. 排序（finalScore 降序，同分时较新者优先）+ 截断到 MAX_OUTPUT_ITEMS
    renderItems.sort((a, b) => {
        if (a.guaranteed !== b.guaranteed) return a.guaranteed ? -1 : 1;
        if (b.score !== a.score) return b.score - a.score;
        return b.createdAt - a.createdAt;
    });
    const finalItems = renderItems.slice(0, MAX_OUTPUT_ITEMS);
    const cutItems = renderItems.slice(MAX_OUTPUT_ITEMS);

    // ── 召回回执：把这次实际注入 prompt 的 memoryId 落到 localStorage ──
    // 用途见 ./recallReceipts.ts。便利贴也算注入（用户对某条便利贴可能纠正）。
    // 截断/过期记忆不计入（cut 部分没进 prompt，pinnedIds 已经过 archived 过滤）。
    try {
        const injectedIds: string[] = [];
        for (const it of finalItems) injectedIds.push(...it.sourceIds);
        for (const id of pinnedIds) injectedIds.push(id);
        recordRecallReceipt(charId, injectedIds);
    } catch (e) {
        // 回执只是 extraction 阶段的辅助，写失败不影响本次召回输出
        console.warn('🏰 [MemoryPalace] recordRecallReceipt failed:', e);
    }

    // ─── 调试：打印最终注入 prompt 的完整列表 ─────────────
    //
    // 打开控制台展开这个 group，能看到：
    //  - 每条的 rank / score / 所属房间 / 完整文字 / 字数
    //  - 是独立记忆还是事件盒（盒子会打印 summary + 所有活节点完整内容，
    //    验证盒内成员有没有真的一起出来）
    //  - 被截断的 item 也会列出来（标 ✂️），方便判断是不是应该注入的事件盒被挤掉了
    const finalTotalChars = finalItems.reduce((s, it) => s + it.body.length, 0);
    const pinnedTotalChars = pinnedNodes.reduce((s, n) => s + n.content.length, 0);
    console.groupCollapsed(
        `🏰 [MemoryPalace] 最终注入 prompt：${finalItems.length} 条 · ${finalTotalChars} 字`
        + `（便利贴 ${pinnedNodes.length}/${pinnedTotalChars}字 | 盒子 ${boxHits.size} | 独立 ${standaloneItems.length}`
        + `${cutItems.length > 0 ? ` | ✂️ cut ${cutItems.length}` : ''}）`
    );
    if (pinnedNodes.length > 0) {
        console.groupCollapsed(`📌 便利贴置顶（不占 ${MAX_OUTPUT_ITEMS} 条名额）${pinnedNodes.length} 条 · ${pinnedTotalChars} 字`);
        for (const p of pinnedNodes) {
            const daysLeft = Math.ceil((p.pinnedUntil! - now) / (24 * 60 * 60 * 1000));
            console.log(
                `📌 [${p.room}] 剩余 ${daysLeft} 天 · ${p.content.length} 字\n${p.content}`
            );
        }
        console.groupEnd();
    }
    finalItems.forEach((it, i) => {
        const isBox = it.debugLabel.startsWith('box ');
        const scoreStr = it.score.toFixed(3);
        const chars = it.body.length;
        if (isBox) {
            // 从 boxHits 里找到具体是哪个盒子 + 命中了几条
            const boxId = it.debugLabel.slice(4).split(' ')[0];
            const hit = boxHits.get(boxId);
            const hitCount = hit?.hitNodeIds.size ?? 0;
            const meta = it.debugLabel.slice(4 + boxId.length + 1); // "(N live + summary)"
            console.log(
                `#${i + 1} [${it.room}] score=${scoreStr}`
                + ` 📦 ${boxId} ${meta} · 命中 ${hitCount} 条 · ${chars} 字\n${it.body}`
            );
        } else {
            const nodeId = it.debugLabel.slice(4); // "mem xxx" → "xxx"
            console.log(
                `#${i + 1} [${it.room}] score=${scoreStr}`
                + ` 🔹 独立 ${nodeId} · ${chars} 字\n${it.body}`
            );
        }
    });
    if (cutItems.length > 0) {
        console.groupCollapsed(`✂️ 被截断的 ${cutItems.length} 条（排在 15 名之外，不注入）`);
        cutItems.forEach((it, i) => {
            console.log(
                `#${MAX_OUTPUT_ITEMS + i + 1} [${it.room}] score=${it.score.toFixed(3)}`
                + ` ${it.debugLabel.startsWith('box ') ? '📦' : '🔹'} ${it.debugLabel} · ${it.body.length} 字`
            );
        });
        console.groupEnd();
    }
    console.groupEnd();

    // 4. 按房间分组渲染
    let output = `### 记忆宫殿 (Memory Palace)\n`;
    output += `以下是你脑海中浮现的相关记忆片段，它们可能影响你此刻的感受和反应：\n\n`;

    // 4a. 便利贴置顶记忆
    if (pinnedNodes.length > 0) {
        output += `📌 **便利贴（近期重要事项）**\n`;
        // 便利贴不占名额、每轮全量注入，置顶最长 30 天。没有这句分寸，「记着一件事」
        // 会退化成每段结尾都追问一遍进展、催对方快去办。同仓库里 Notion 笔记块
        // （chatPrompts 的「不要每次都提」）和用药提醒（lifeRecords 的「别反复催」）
        // 早就配了同类措辞，这里补齐。
        output += `（这些是你这几天一直记着的事。记着不等于要一直说——话赶到那儿了顺口提一句就够了，没赶到就让它待在心里；同一件事不必每次聊天都追问进展，也不必替 ta 安排什么时候去做。）\n`;
        for (const node of pinnedNodes) {
            if (omitDates) {
                output += `- ${node.content}\n`;
            } else {
                const daysLeft = Math.ceil((node.pinnedUntil! - now) / (24 * 60 * 60 * 1000));
                output += `- [${formatMemoryDateWithDistance(node.createdAt, now)}] ${memoryContentWithDates(node)}（剩余 ${daysLeft} 天）\n`;
            }
        }
        output += `\n`;
        console.log(`📌 [MemoryPalace] 便利贴置顶 ${pinnedNodes.length} 条`);
    }

    // 按房间分组（保持房间显示顺序：卧室 > 客厅 > 书房 > 用户房间 > 自我房间 > 阁楼 > 窗台）
    const byRoom = new Map<string, RenderItem[]>();
    for (const it of finalItems) {
        const arr = byRoom.get(it.room) || [];
        arr.push(it);
        byRoom.set(it.room, arr);
    }
    const roomOrder = ['bedroom', 'living_room', 'study', 'user_room', 'self_room', 'attic', 'windowsill'];
    for (const room of roomOrder) {
        const items = byRoom.get(room);
        if (!items || items.length === 0) continue;
        const roomLabel = getRoomLabel(room as any, userName);
        const roomDesc = ROOM_CONFIGS[room as keyof typeof ROOM_CONFIGS]?.description || '';
        for (const it of items) {
            output += `**[${roomLabel} · ${roomDesc}]** ${it.body}\n\n`;
        }
    }

    // 5. 窗台期盼
    const activeAnticipations = anticipations.filter(a => a.status === 'active' || a.status === 'anchor');
    if (activeAnticipations.length > 0) {
        output += `> **窗台期盼**:\n`;
        // 同便利贴：active/anchor 的期盼每轮全量注入，anchor 更是长期挂着。
        output += `> （这是你心里盼着的事，不是待办清单。它影响你的心情多过你的话头，不必每次都提起来。）\n`;
        for (const ant of activeAnticipations) {
            const label = ant.status === 'anchor' ? '🔒 锚点' : '✨ 期盼';
            output += `> - ${label}: ${ant.content}\n`;
        }
        output += `\n`;
    }

    const trimmed = output.trim();
    console.log(`🏰 [MemoryPalace] 本次召回 ${finalItems.length} 条 (${boxHits.size} 个 box + ${standaloneItems.length} 条独立)，${trimmed.length} 字`);
    return trimmed;
}

// ─── 子渲染：单条独立记忆 ──────────────────────────────

function buildStandaloneItem(r: ScoredMemory, now: number, omitDates = false): RenderItem {
    const node = r.node;
    const body = omitDates
        ? `(重要性: ${node.importance})\n${node.content}`
        : `(${formatMemoryDateWithDistance(node.createdAt, now)}, 重要性: ${node.importance})\n${memoryContentWithDates(node)}`;
    return {
        guaranteed: r.recallGuarantee === 'explicit_entity',
        score: r.finalScore,
        room: node.room,
        body,
        createdAt: node.createdAt,
        importance: node.importance,
        debugLabel: `mem ${node.id}`,
        sourceIds: [node.id],
    };
}

// ─── 子渲染：整个 EventBox（summary + 活节点） ──────────

async function buildBoxItem(
    box: EventBox,
    topScore: number,
    localNodeMap: Map<string, MemoryNode>,
    now: number,
    guaranteed: boolean = false,
    omitDates: boolean = false,
): Promise<RenderItem | null> {
    // 加载 summary（如有）
    let summary: MemoryNode | null = null;
    if (box.summaryNodeId) {
        const s = localNodeMap.get(box.summaryNodeId) || (await MemoryNodeDB.getById(box.summaryNodeId)) || null;
        if (s) summary = s;
    }
    // 加载活节点（按时间升序）
    const liveNodes: MemoryNode[] = [];
    for (const id of box.liveMemoryIds) {
        const n = localNodeMap.get(id) || (await MemoryNodeDB.getById(id));
        if (n && !n.archived) liveNodes.push(n);
    }
    liveNodes.sort((a, b) => a.createdAt - b.createdAt);

    if (!summary && liveNodes.length === 0) return null; // 空盒，跳过

    // 决定房间：summary 优先；否则用最重要的活节点的房间
    const repNode = summary || liveNodes.reduce((acc, n) => (n.importance > acc.importance ? n : acc), liveNodes[0]);
    const room = repNode.room;
    const importance = repNode.importance;
    const createdAt = summary?.createdAt || liveNodes[liveNodes.length - 1]?.createdAt || box.updatedAt;

    // 渲染：盒子标题 + summary（如有）+ 活节点条目
    const liveToShow = liveNodes.slice(0, MAX_LIVE_NODES_PER_BOX);
    const omitted = liveNodes.length - liveToShow.length;

    let body = `📦 **事件盒：${box.name}**`;
    if (box.tags.length > 0) body += `  〈${box.tags.slice(0, 6).join(' · ')}〉`;
    body += '\n';

    if (summary) {
        if (omitDates) {
            body += `_整合回忆_ (重要性 ${summary.importance}, 已压缩 ${box.compressionCount} 次)\n`;
        } else {
            const sDate = formatMemoryDateWithDistance(summary.createdAt, now);
            body += `_整合回忆_ (${sDate}, 重要性 ${summary.importance}, 已压缩 ${box.compressionCount} 次)\n`;
        }
        body += `${summary.content}\n`;
    }

    if (liveToShow.length > 0) {
        body += summary ? `_新增片段_：\n` : '';
        for (const n of liveToShow) {
            if (omitDates) {
                body += `- ${n.content}\n`;
            } else {
                const d = formatMemoryDateWithDistance(n.createdAt, now);
                body += `- [${d}] ${memoryContentWithDates(n)}\n`;
            }
        }
        if (omitted > 0) body += `（另有 ${omitted} 条同盒活节点未展示）\n`;
    }

    const sourceIds: string[] = [];
    if (summary) sourceIds.push(summary.id);
    for (const n of liveToShow) sourceIds.push(n.id);

    return {
        guaranteed,
        score: topScore,
        room,
        body: body.trimEnd(),
        createdAt,
        importance,
        debugLabel: `box ${box.id} (${liveNodes.length} live${summary ? ' + summary' : ''})`,
        sourceIds,
    };
}
