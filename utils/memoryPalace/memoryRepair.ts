import { ContextBuilder } from '../context';
import type { APIConfig, CharacterProfile, UserProfile } from '../../types';
import { extractContent, extractJson, safeFetchJson } from '../safeApi';
import { EventBoxDB, MemoryNodeDB } from './db';
import { getLatestRecallReceipt, type RecallReceipt } from './recallReceipts';
import type {
    EmbeddingConfig,
    EventBox,
    MemoryNode,
    RemoteVectorConfig,
} from './types';
import { updateStoredMemoryNode } from './vectorStore';
import { formatMemoryDateWithDistance } from './memoryDate';

export type RepairNodeKind = 'summary' | 'live' | 'archived' | 'standalone';

export interface RepairNode {
    node: MemoryNode;
    kind: RepairNodeKind;
    recalled: boolean;
}

export interface RepairEventBox {
    box: EventBox;
    nodes: RepairNode[];
    recalledNodeIds: string[];
}

export interface RecallRepairSnapshot {
    receipt: RecallReceipt | null;
    standalone: RepairNode[];
    boxes: RepairEventBox[];
}

export interface MemoryRepairDiagnosis {
    reply: string;
    suspectIds: string[];
    reasons: Record<string, string>;
}

function unique<T>(items: T[]): T[] {
    return [...new Set(items)];
}

function repairNodeKind(node: MemoryNode): RepairNodeKind {
    if (node.isBoxSummary) return 'summary';
    if (node.archived) return 'archived';
    if (node.eventBoxId) return 'live';
    return 'standalone';
}

function compactSearchText(value: string): string {
    return value
        .normalize('NFKC')
        .toLocaleLowerCase('zh-CN')
        .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function isLooseSubsequence(needle: string, haystack: string): boolean {
    if (!needle) return true;
    let cursor = 0;
    for (const char of haystack) {
        if (char === needle[cursor]) cursor += 1;
        if (cursor === needle.length) return true;
    }
    return false;
}

function searchableMemoryText(node: MemoryNode): string {
    const date = new Date(node.createdAt);
    const numericDate = Number.isNaN(date.getTime())
        ? ''
        : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return [
        node.content,
        node.tags.join(' '),
        node.mood,
        node.room,
        numericDate,
        formatRepairMemoryDate(node.createdAt),
    ].join(' ');
}

/**
 * 用户主动修补时的本地模糊搜索。
 * 支持多关键词、不完整连续片段和有序缺字匹配；不调用向量或模型 API。
 */
export function filterEditableMemoryNodes(
    nodes: MemoryNode[],
    query: string,
    recalledIds: Iterable<string> = [],
    limit: number = 30,
): RepairNode[] {
    const terms = query
        .normalize('NFKC')
        .toLocaleLowerCase('zh-CN')
        .trim()
        .split(/\s+/u)
        .map(compactSearchText)
        .filter(Boolean);
    if (terms.length === 0) return [];

    const recalled = new Set(recalledIds);
    return nodes
        .map(node => {
            const haystack = compactSearchText(searchableMemoryText(node));
            let score = 0;
            for (const term of terms) {
                if (haystack.includes(term)) {
                    score += 20 + Math.min(term.length, 12);
                } else if (term.length >= 2 && isLooseSubsequence(term, haystack)) {
                    score += 6;
                } else {
                    return null;
                }
            }
            return { node, score };
        })
        .filter((item): item is { node: MemoryNode; score: number } => item !== null)
        .sort((a, b) =>
            b.score - a.score
            || b.node.importance - a.node.importance
            || b.node.createdAt - a.node.createdAt
        )
        .slice(0, limit)
        .map(({ node }) => ({
            node,
            kind: repairNodeKind(node),
            recalled: recalled.has(node.id),
        }));
}

export async function searchEditableMemories(
    charId: string,
    query: string,
    recalledIds: Iterable<string> = [],
    limit: number = 30,
): Promise<RepairNode[]> {
    const nodes = await MemoryNodeDB.getByCharId(charId);
    return filterEditableMemoryNodes(nodes, query, recalledIds, limit);
}

/** MemoryNode 当前只可靠保存到“日”；12:00 常是日期占位，不能伪装成精确时分。 */
export function formatRepairMemoryDate(createdAt: number, now: number = Date.now()): string {
    return formatMemoryDateWithDistance(createdAt, now);
}

/**
 * 将“本轮实际召回”还原成可编辑现场。
 * 命中事件盒任一成员时，编辑器会额外装载摘要、所有活节点与所有归档节点。
 */
export async function loadRecallRepairSnapshot(
    charId: string,
    sinceTs: number,
): Promise<RecallRepairSnapshot> {
    const receipt = getLatestRecallReceipt(charId, sinceTs);
    if (!receipt) return { receipt: null, standalone: [], boxes: [] };

    const [allBoxes, recalledNodes] = await Promise.all([
        EventBoxDB.getByCharId(charId),
        Promise.all(receipt.ids.map(id => MemoryNodeDB.getById(id))),
    ]);
    const boxesById = new Map(allBoxes.map(box => [box.id, box]));
    const nodeToBox = new Map<string, EventBox>();
    for (const box of allBoxes) {
        const ids = unique([
            ...(box.summaryNodeId ? [box.summaryNodeId] : []),
            ...box.liveMemoryIds,
            ...box.archivedMemoryIds,
        ]);
        ids.forEach(id => nodeToBox.set(id, box));
    }

    const recalledIds = new Set(receipt.ids);
    const hitBoxIds = new Set<string>();
    const standalone: RepairNode[] = [];
    for (const node of recalledNodes) {
        if (!node || node.charId !== charId) continue;
        const box = (node.eventBoxId && boxesById.get(node.eventBoxId))
            || nodeToBox.get(node.id);
        if (box) {
            hitBoxIds.add(box.id);
        } else {
            standalone.push({ node, kind: 'standalone', recalled: true });
        }
    }

    const boxes: RepairEventBox[] = [];
    for (const boxId of hitBoxIds) {
        const box = boxesById.get(boxId);
        if (!box) continue;
        const orderedIds = unique([
            ...(box.summaryNodeId ? [box.summaryNodeId] : []),
            ...box.liveMemoryIds,
            ...box.archivedMemoryIds,
        ]);
        const loaded = await Promise.all(orderedIds.map(id => MemoryNodeDB.getById(id)));
        const nodes: RepairNode[] = [];
        loaded.forEach((node, index) => {
            if (!node || node.charId !== charId) return;
            const id = orderedIds[index];
            const kind: RepairNodeKind = id === box.summaryNodeId
                ? 'summary'
                : box.archivedMemoryIds.includes(id)
                    ? 'archived'
                    : 'live';
            nodes.push({ node, kind, recalled: recalledIds.has(id) });
        });
        // 摘要固定在首位；其余活跃/归档子节点按事件日期排成可核对的时间线。
        nodes.sort((a, b) => {
            if (a.kind === 'summary') return b.kind === 'summary' ? 0 : -1;
            if (b.kind === 'summary') return 1;
            return a.node.createdAt - b.node.createdAt;
        });
        boxes.push({
            box,
            nodes,
            recalledNodeIds: nodes.filter(item => item.recalled).map(item => item.node.id),
        });
    }

    return { receipt, standalone, boxes };
}

/**
 * 诊断上下文只保留角色身份与说话方式。
 * 按产品约定明确调用 buildCoreContext(..., false)，同时抹掉所有持久记忆、
 * 召回注入、房间门牌和情绪注入，确保不会暗中再读一次记忆上下文。
 */
export async function buildMemoryRepairCoreContext(char: CharacterProfile,
    user: UserProfile,
): Promise<string> {
    const memoryIsolatedChar: CharacterProfile = {
        ...char,
        memories: [],
        refinedMemories: {},
        activeMemoryMonths: [],
        memoryPalaceEnabled: false,
        memoryPalaceInjection: undefined,
        roomPlatesInjection: undefined,
        buffInjection: undefined,
        activeBuffs: [],
    };
    return (await ContextBuilder.buildCoreContext(memoryIsolatedChar, user, false));
}

function snapshotCandidates(snapshot: RecallRepairSnapshot): Array<{
    id: string;
    scope: string;
    date: string;
    content: string;
}> {
    const candidates = snapshot.standalone.map(item => ({
        id: item.node.id,
        scope: '独立记忆（本轮召回）',
        date: formatRepairMemoryDate(item.node.createdAt),
        content: item.node.content,
    }));
    snapshot.boxes.forEach(group => {
        group.nodes.forEach(item => {
            const stateLabel = item.kind === 'archived'
                ? '（已归档，本轮未注入，仅供核对）'
                : item.recalled ? '（本轮经过）' : '（同盒展开，本轮未直接注入）';
            candidates.push({
                id: item.node.id,
                scope: `事件盒「${group.box.name}」/${item.kind === 'summary' ? '盒摘要' : item.kind === 'archived' ? '归档子节点' : '活跃子节点'}${stateLabel}`,
                date: formatRepairMemoryDate(item.node.createdAt),
                content: item.node.content,
            });
        });
    });
    return candidates;
}

/** 即使模型偶尔沿用分析术语，也把面向人的称呼收回到具体关系里。 */
export function naturalizeMemoryRepairLanguage(
    text: string,
    charName: string,
    userName: string,
): string {
    const you = userName.trim() || '你';
    const character = charName.trim() || '对方';
    return text
        .replace(/这位用户|该用户|用户/g, you)
        .replace(/这个角色|该角色|角色本人|角色/g, character);
}

/**
 * “？？？”的分析只接收显式传入的现场候选，不执行向量召回。
 */
export async function diagnoseRecallIssue(params: {
    char: CharacterProfile;
    user: UserProfile;
    apiConfig: APIConfig;
    snapshot: RecallRepairSnapshot;
    userConcern: string;
    userMessage?: string;
    assistantReply?: string;
}): Promise<MemoryRepairDiagnosis> {
    const { apiConfig, snapshot } = params;
    if (!apiConfig.baseUrl || !apiConfig.apiKey || !apiConfig.model) {
        throw new Error('请先配置可用的主 API');
    }
    const candidates = snapshotCandidates(snapshot);
    if (candidates.length === 0) {
        return {
            reply: '这一轮没有记忆从这里经过。我不能假装看见不存在的线索。',
            suspectIds: [],
            reasons: {},
        };
    }

    const coreContext = (await buildMemoryRepairCoreContext(params.char, params.user));
    const charName = params.char.name || '对方';
    const userName = params.user.name || '你';
    const candidateText = candidates
        .map((item, index) => `[${index + 1}] id=${item.id}\n位置=${item.scope}\n日期=${item.date}\n内容=${item.content}`)
        .join('\n\n');
    const system = `${coreContext}

你现在不是 ${charName} 本人，而是 ${charName} 记忆小屋门口一个名为“？？？”的安静引路者。
你的身份虽然是“？？？”，但说话的节奏、句式、用词和情绪浓度必须贴近上方 ${charName} 的语言风格；不要改成客服、医生或系统报告口吻，也不要声称自己就是 ${charName}。
称呼必须自然具体：
- 面向 ${userName} 时只用“你”或“${userName}”，绝不能把对方称为“用户”。
- 提到 ${charName} 时直接说“${charName}”，绝不能说“角色”“角色本人”或用含糊的“TA”替代名字。
- 涉及多个人时使用具体名字；确实指一个群体时才用“他们”。
任务仅限于检查下方明确提供的“本轮召回现场”。不得调用、猜测或补充任何其他记忆，不得替 ${charName} 辩解。
根据 ${userName} 指出的问题，找出可能让刚才回复产生事实错误、对象混淆、时间错位或过度推断的候选记忆。
事件盒中未在本轮直接注入、但为了修补而展开的节点，可以作为盒内矛盾线索；归档子节点已经不再注入，提到它时必须明确说“已归档，本轮没有注入”。
回答要简短、温和、具体，不替 ${userName} 直接篡改内容。

只输出 JSON：
{
  "reply": "给用户的判断与下一步建议",
  "suspectIds": ["候选中的原始 id"],
  "reasons": { "候选 id": "为什么可能有影响" }
}`;

    const userPrompt = `【${userName}刚才说的话】
${params.userMessage || '（未取得）'}

【${charName}刚才的回复】
${params.assistantReply || '（未取得）'}

【${userName}觉得不对劲的地方】
${params.userConcern.trim()}

【本轮召回现场】
${candidateText}`;

    const data = await safeFetchJson(
        `${apiConfig.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiConfig.apiKey}`,
            },
            body: JSON.stringify({
                model: apiConfig.model,
                temperature: 0.2,
                stream: false,
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: userPrompt },
                ],
            }),
        },
        1,
        90_000,
        { appId: 'chat', charId: params.char.id, purpose: 'memory-repair-diagnosis' },
    );
    const raw = extractContent(data);
    const parsed = extractJson(raw);
    const allowed = new Set(candidates.map(item => item.id));
    const suspectIds: string[] = Array.isArray(parsed?.suspectIds)
        ? unique<string>((parsed.suspectIds as unknown[]).filter(
            (id: unknown): id is string => typeof id === 'string' && allowed.has(id),
        ))
        : [];
    const reasons: Record<string, string> = {};
    if (parsed?.reasons && typeof parsed.reasons === 'object') {
        suspectIds.forEach(id => {
            if (typeof parsed.reasons[id] === 'string') {
                reasons[id] = naturalizeMemoryRepairLanguage(
                    parsed.reasons[id],
                    charName,
                    userName,
                );
            }
        });
    }
    return {
        reply: typeof parsed?.reply === 'string' && parsed.reply.trim()
            ? naturalizeMemoryRepairLanguage(parsed.reply.trim(), charName, userName)
            : raw
                ? naturalizeMemoryRepairLanguage(raw, charName, userName)
                : '我看过这些痕迹了。你可以从标出的记忆开始核对。',
        suspectIds,
        reasons,
    };
}

export async function patchRecallMemory(
    nodeId: string,
    content: string,
    embeddingConfig: EmbeddingConfig,
    remoteVectorConfig?: RemoteVectorConfig,
): Promise<MemoryNode> {
    const nextContent = content.trim();
    if (!nextContent) throw new Error('记忆内容不能为空');
    const result = await updateStoredMemoryNode(
        nodeId,
        { content: nextContent },
        embeddingConfig,
        remoteVectorConfig,
    );
    return result.node;
}

export interface MemoryGuideCopy {
    greeting: string;
    trail: string;
    empty: string;
}

const GUIDE_COPY: Record<NonNullable<CharacterProfile['personalityStyle']>, MemoryGuideCopy[]> = {
    emotional: [
        { greeting: '你来啦，{user}。先别急，我把刚才碰过的东西都留在这里了。', trail: '刚才这里经过了这些记忆……', empty: '这里很安静。刚才那一轮，没有记忆从门前经过。' },
        { greeting: '我等到你了，{user}。如果刚才有哪里刺痛了你，我们一起把它看清。', trail: '看，它们正在一点点显出来……', empty: '没有留下召回的脚印。问题也许不在记忆里。' },
    ],
    narrative: [
        { greeting: '你来啦，{user}。刚才那句话离开以后，几页纸落在了门边。', trail: '它们曾这样经过这里……', empty: '这一页是空的：刚才没有召回记录经过。' },
        { greeting: '门刚好还没关，{user}。来看看刚才那段话从哪里走过。', trail: '沿着微光，记忆正在依次出现……', empty: '路上没有记忆的痕迹，这次要去别处找原因。' },
    ],
    imagery: [
        { greeting: '你来啦，{user}。雾里还浮着刚才留下的微光。', trail: '刚才这里经过了这些记忆……', empty: '光点没有分岔。刚才没有任何记忆被带进回复。' },
        { greeting: '嘘，{user}。那些被碰过的记忆还没完全沉下去。', trail: '等一等，它们会从暗处慢慢亮起来……', empty: '今晚没有记忆亮起。这里没有可修补的召回痕迹。' },
    ],
    analytical: [
        { greeting: '你来啦，{user}。本轮召回现场已经封存，我们逐条核对。', trail: '以下是刚才实际经过的记忆，以及命中事件盒的完整结构。', empty: '核对完成：本轮没有记忆注入记录。' },
        { greeting: '正好，{user}。刚才的回复和召回记录都还在可比对范围内。', trail: '召回痕迹正在展开，请从事实、对象和时间三个方向检查。', empty: '没有召回项。刚才的问题应该不在记忆宫殿里。' },
    ],
};

export function getMemoryGuideCopy(
    char: CharacterProfile,
    userName: string,
): MemoryGuideCopy {
    const style = char.personalityStyle || 'emotional';
    const variants = GUIDE_COPY[style];
    const seed = [...`${char.id}:${char.name}`].reduce((sum, value) => sum + value.charCodeAt(0), 0);
    const selected = variants[seed % variants.length];
    return {
        greeting: selected.greeting.replace('{user}', userName || '你'),
        trail: selected.trail,
        empty: selected.empty,
    };
}
