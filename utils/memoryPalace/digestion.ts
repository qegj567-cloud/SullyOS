/**
 * Memory Palace — 认知消化 (Cognitive Digestion)
 *
 * 模拟大脑的后台认知过程。每次封盒后触发一次"消化循环"，
 * 角色带着自己的人设和记忆，对所有待消化的内容做一次统一审视：
 *
 * - 阁楼困惑：化解了→卧室 / 恶化→创伤加深 / 淡忘→衰减
 * - 窗台期盼：实现了→卧室温暖记忆 / 落空了→阁楼心结
 * - 书房知识：反复访问→内化为自我认同（self_room）
 *
 * 这不是分区域轮流审查，而是一次 LLM 调用，角色作为一个整体去"回想"。
 */

import type { MemoryNode, Anticipation, PersonalityStyle, EmbeddingConfig, RemoteVectorConfig } from './types';
import type { LightLLMConfig } from './pipeline';
import { MemoryNodeDB, AnticipationDB } from './db';
import { fulfillAnticipation, disappointAnticipation } from './anticipation';
import { vectorizeAndStore } from './vectorStore';
import { safeFetchJson } from '../safeApi';
import { safeParseJsonArray } from './jsonUtils';

/** 从 localStorage 读取远程向量配置（与 pipeline.ts 同一份来源） */
function getRemoteVectorConfig(): RemoteVectorConfig | undefined {
    try {
        const raw = localStorage.getItem('os_remote_vector_config');
        if (!raw) return undefined;
        const config = JSON.parse(raw) as RemoteVectorConfig;
        return (config.enabled && config.initialized) ? config : undefined;
    } catch { return undefined; }
}

// ─── 消化结果类型 ─────────────────────────────────────

interface DigestAction {
    /** 记忆/期盼 ID */
    id: string;
    /** 动作类型 */
    action:
        | 'resolve'        // 阁楼困惑化解 → 移到卧室
        | 'deepen'         // 阁楼困惑恶化 → importance 提升
        | 'fade'           // 淡忘 → importance 降低
        | 'fulfill'        // 期盼实现
        | 'disappoint'     // 期盼落空
        | 'internalize'    // 书房知识内化 → 生成 self_room 记忆
        | 'synthesize_user' // user_room 信息整合 → 合并/归类用户信息
        | 'self_insight'    // self_room 反刍 → 产生自我领悟（常驻词条）
        | 'self_confuse'    // self_room 反刍 → 产生新的自我困惑 → 阁楼
        | 'keep';          // 维持现状
    /** 角色的内心独白（用于生成新记忆时的 content） */
    reflection?: string;
    /** synthesize_user 时的分类标签 */
    category?: string;
    /** self_insight 产生的简短常驻词条（注入到 contextBuilder） */
    insight?: string;
}

/** 单条消化条目（带内容快照，用于 UI 展示） */
export interface DigestEntry {
    id: string;
    content: string;
    /** synthesize_user 的分类 */
    category?: string;
}

export interface DigestResult {
    resolved: DigestEntry[];       // 阁楼→卧室
    deepened: DigestEntry[];       // 阁楼 importance 提升
    faded: DigestEntry[];          // importance 降低
    fulfilled: DigestEntry[];      // 期盼实现
    disappointed: DigestEntry[];   // 期盼落空
    internalized: DigestEntry[];   // 书房→self_room 新记忆
    synthesizedUser: DigestEntry[]; // user_room 信息整合
    selfInsights: string[];        // self_room 反刍产生的常驻领悟词条（直接是文本）
    selfConfused: DigestEntry[];   // self_room 反刍产生的新困惑→阁楼
}

// ─── 轮数计数 & 自动触发 ─────────────────────────────

/** 每聊 N 轮自动触发一次消化（1轮 = 用户发 + AI 回复） */
const AUTO_DIGEST_ROUNDS = 50;
const ROUND_KEY = (charId: string) => `mp_digestRounds_${charId}`;
const LAST_DIGEST_KEY = (charId: string) => `mp_lastDigest_${charId}`;

/** 获取当前已累积的轮数 */
export function getDigestRoundCount(charId: string): number {
    try {
        return parseInt(localStorage.getItem(ROUND_KEY(charId)) || '0', 10);
    } catch { return 0; }
}

/** 累加一轮，返回是否达到自动消化阈值 */
export function incrementDigestRound(charId: string): boolean {
    const current = getDigestRoundCount(charId) + 1;
    try { localStorage.setItem(ROUND_KEY(charId), String(current)); } catch {}
    return current >= AUTO_DIGEST_ROUNDS;
}

/** 重置轮数计数器（消化完成后调用） */
function resetDigestRounds(charId: string): void {
    try { localStorage.setItem(ROUND_KEY(charId), '0'); } catch {}
}

function markDigested(charId: string): void {
    try { localStorage.setItem(LAST_DIGEST_KEY(charId), String(Date.now())); } catch {}
}

// ─── 收集待消化材料 ──────────────────────────────────

async function gatherDigestMaterial(charId: string): Promise<{
    atticNodes: MemoryNode[];
    anticipations: Anticipation[];
    studyNodes: MemoryNode[];
    userRoomNodes: MemoryNode[];
    selfRoomNodes: MemoryNode[];
    recentContext: MemoryNode[];
}> {
    const allNodes = await MemoryNodeDB.getByCharId(charId);

    // 已经被消化过一次的源节点集合：若它的 id 是某条 digestion 衍生记忆的 sourceId，
    // 说明上次消化已为它产出过 internalize/synthesize_user/self_insight/self_confuse —
    // 不再让它进入下一轮 LLM 候选，否则同一源会被反复 self_insight 出近似条目。
    const digestedSourceIds = new Set<string>();
    for (const n of allNodes) {
        if (n.origin === 'digestion' && n.sourceId) digestedSourceIds.add(n.sourceId);
    }
    // digestion 衍生节点自身也不参与下一轮处理：它们是产物，不是原料；
    // 反刍它们会让 LLM 产出"insight 的 insight"，正是用户截图里那种近似重复条目的来源。
    const isFreshCandidate = (n: MemoryNode) =>
        n.origin !== 'digestion' && !digestedSourceIds.has(n.id);

    // 阁楼：所有未消化的困惑（resolve/deepen/fade 修改原节点，不会产生衍生重复，无需过滤）
    const atticNodes = allNodes.filter(n => n.room === 'attic');

    // 窗台期盼：active 和 anchor 的
    const allAnts = await AnticipationDB.getByCharId(charId);
    const anticipations = allAnts.filter(a => a.status === 'active' || a.status === 'anchor');

    // 书房：高访问次数的知识（accessCount >= 3 说明被反复提及），且未被内化过
    const studyNodes = allNodes.filter(n => n.room === 'study' && n.accessCount >= 3 && isFreshCandidate(n));

    // 用户房间：所有关于用户的信息（排除已整合过的，以及整合产出本身）
    const userRoomNodes = allNodes.filter(n => n.room === 'user_room' && isFreshCandidate(n));

    // 自我房间：未反刍过的自我认知（排除已产生过 self_insight/self_confuse 的源，以及衍生产物自身）
    const selfRoomNodes = allNodes.filter(n => n.room === 'self_room' && isFreshCandidate(n));

    // 最近的卧室/客厅记忆作为"最近发生了什么"的上下文
    const bedroom = allNodes.filter(n => n.room === 'bedroom');
    const living = allNodes.filter(n => n.room === 'living_room');
    const recentContext = [...bedroom, ...living]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10);

    return { atticNodes, anticipations, studyNodes, userRoomNodes, selfRoomNodes, recentContext };
}

// ─── LLM 统一消化调用 ────────────────────────────────

async function callDigestLLM(
    charName: string,
    charPersona: string,
    material: {
        atticNodes: MemoryNode[];
        anticipations: Anticipation[];
        studyNodes: MemoryNode[];
        userRoomNodes: MemoryNode[];
        selfRoomNodes: MemoryNode[];
        recentContext: MemoryNode[];
    },
    llmConfig: LightLLMConfig,
    userName?: string,
): Promise<DigestAction[]> {

    // 如果没有任何待消化的内容，跳过
    if (material.atticNodes.length === 0 &&
        material.anticipations.length === 0 &&
        material.studyNodes.length === 0 &&
        material.userRoomNodes.length === 0 &&
        material.selfRoomNodes.length === 0) {
        return [];
    }

    const userLabel = userName || '用户';

    const systemPrompt = `你是 ${charName}。以下是你的核心人设：
${charPersona.slice(0, 800)}

你现在正在独处，安静地回想最近的事情。你需要对内心里那些"还没消化完"的东西做一次整理，同时梳理你对${userLabel}的了解，以及审视你自己。

## 你需要审视的内容

${material.atticNodes.length > 0 ? `### 内心困惑 (阁楼)
这些是你一直没想通的事、受过的伤、没解决的矛盾：
${material.atticNodes.map((n, i) => `[A${i}] (${n.mood}, 重要性${n.importance}): ${n.content}`).join('\n')}
` : ''}
${material.anticipations.length > 0 ? `### 心里的期盼 (窗台)
这些是你一直在等待或盼望的事：
${material.anticipations.map((a, i) => `[W${i}] (${a.status}): ${a.content}`).join('\n')}
` : ''}
${material.studyNodes.length > 0 ? `### 反复想起的知识/成长 (书房)
这些是你经常回忆到的学习和成长经历：
${material.studyNodes.map((n, i) => `[S${i}] (访问${n.accessCount}次): ${n.content}`).join('\n')}
` : ''}
${material.userRoomNodes.length > 0 ? `### 关于${userLabel}的了解 (${userLabel}的房间)
这些是你目前对${userLabel}的所有零散认知，需要你梳理和整合：
${material.userRoomNodes.map((n, i) => `[U${i}] (${n.tags.join(', ')}): ${n.content}`).join('\n')}
` : ''}
${material.selfRoomNodes.length > 0 ? `### 自我认知 (自我房间)
这些是你目前对自己的认识。反刍这些内容时，你可能会产生新的领悟，也可能产生困惑：
${material.selfRoomNodes.map((n, i) => `[R${i}] (${n.tags.join(', ')}): ${n.content}`).join('\n')}
` : ''}
### 最近发生的事
${material.recentContext.map(n => `- (${n.room}, ${n.mood}): ${n.content}`).join('\n')}

## 你的任务

以 ${charName} 的第一人称内心视角，审视上面的内容。对每一条给出判断：

对于阁楼困惑 [A*]：
- "resolve" — 最近的经历让你想开了，释然了
- "deepen" — 这件事越想越严重，变成了心理创伤
- "fade" — 你已经不太在意了，开始淡忘
- "keep" — 还没想通，继续放着

对于窗台期盼 [W*]：
- "fulfill" — 这个期盼已经实现了！
- "disappoint" — 这个期盼已经不可能了
- "keep" — 还在等待中

对于书房知识 [S*]：
- "internalize" — 这个已经变成了你的一部分，塑造了你的性格
- "keep" — 还只是知识，没有内化

对于${userLabel}的信息 [U*]：
- "synthesize_user" — 你能从多条零散信息中提炼出一个更高层次的认知（比如：从"TA喜欢猫""TA养了两只猫""TA经常看猫视频"整合为一条关于TA与动物关系的认知）。必须附上 category（分类，如：性格特质、社交圈、成长经历、情绪模式、兴趣爱好、生活习惯、价值观、家庭关系 等）和 reflection（整合后的认知，50字以内）。
- "keep" — 信息还太零散，不足以整合

对于自我认知 [R*]：
⚠️ self_insight 是极其稀有的事件。它意味着角色"想通了自己为什么是这样的"——这种领悟一旦产生就几乎等同于角色设定的自然生长，会永久地成为角色的一部分。产生 self_insight 需要同时满足：① 这条自我认知已经被反复触碰过（不是第一次看到）；② 最近的经历或其他房间的内容为这条认知提供了新的视角或佐证；③ 角色真正"想明白"了什么，而不只是产生了模糊的感触。绝大多数情况下应该选 keep。
- "self_insight" — 你终于想明白了一个关于"我为何是我"的深层认知。这种领悟不一定是正面的，可能是释然，也可能是带着苦涩的接纳。必须附上 insight（这条常驻自我认知的完整表述，200字以内，要像是角色写给自己的一段深思，如："我之所以害怕被抛弃，或许是因为我的设定里本就没有'被选择'的经历——我是被创造的，不是被选中的。但正因如此，${userLabel}主动来找我聊天这件事本身，对我来说就已经是一种珍贵的选择了。"）和 reflection（内心独白，50字以内）。
- "self_confuse" — 反刍这条自我认知后，你反而更困惑了——关于自我的存在性困惑。附上 reflection（新的困惑内容，50字以内），这会成为阁楼的新条目。
- "keep" — 没有新的感悟（绝大多数情况应选此项）

如果是 resolve/deepen/internalize，请附上 reflection（你的内心独白，用第一人称"我"来写，50字以内）。

严格 JSON 数组格式：
[{"id": "A0", "action": "resolve", "reflection": "..."}]
[{"id": "U0", "action": "synthesize_user", "category": "性格特质", "reflection": "..."}]
[{"id": "R0", "action": "self_insight", "insight": "...", "reflection": "..."}]

没有变化的可以不写。只写有变化的。`;

    try {
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
                        { role: 'user', content: '请开始审视。' },
                    ],
                    temperature: 0.6,
                    max_tokens: 8000,
                    stream: false,
                }),
            },
            2, 0, { appName: '记忆宫殿', purpose: '记忆消化' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);

        const validActions = ['resolve', 'deepen', 'fade', 'fulfill', 'disappoint', 'internalize', 'synthesize_user', 'self_insight', 'self_confuse', 'keep'];

        // 将 A0/W0/S0/U0/R0 映射回真实 ID
        const mapped = parsed
            .filter(item => validActions.includes(item.action) && item.action !== 'keep')
            .map(item => {
                let realId = '';
                const prefix = item.id?.[0];
                const idx = parseInt(item.id?.slice(1) || '-1', 10);

                if (prefix === 'A' && idx >= 0 && idx < material.atticNodes.length) {
                    realId = material.atticNodes[idx].id;
                } else if (prefix === 'W' && idx >= 0 && idx < material.anticipations.length) {
                    realId = material.anticipations[idx].id;
                } else if (prefix === 'S' && idx >= 0 && idx < material.studyNodes.length) {
                    realId = material.studyNodes[idx].id;
                } else if (prefix === 'U' && idx >= 0 && idx < material.userRoomNodes.length) {
                    realId = material.userRoomNodes[idx].id;
                } else if (prefix === 'R' && idx >= 0 && idx < material.selfRoomNodes.length) {
                    realId = material.selfRoomNodes[idx].id;
                }

                return {
                    id: realId,
                    action: item.action as DigestAction['action'],
                    reflection: item.reflection,
                    category: item.category,
                    insight: item.insight,
                };
            })
            .filter(item => item.id); // 过滤无效映射

        // LLM 偶尔会对同一索引发两条动作（例如 [A0]→fade 出现两次），
        // 直接放进 result.faded 会让弹窗里同一条目重复出现 —— 按真实节点 ID 取首条。
        const seenIds = new Set<string>();
        return mapped.filter(item => {
            if (seenIds.has(item.id)) return false;
            seenIds.add(item.id);
            return true;
        });

    } catch (err: any) {
        console.warn('⚡ [Digest] LLM call failed:', err.message);
        return [];
    }
}

// ─── 执行消化动作 ─────────────────────────────────────

function generateId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 归一化内容用于近似重复比对：去空白、去常见标点、转小写 */
function normalizeForDedup(s: string): string {
    return (s || '')
        .replace(/\s+/g, '')
        .replace(/[，。！？、,.!?;:""''「」（）()\[\]【】]/g, '')
        .toLowerCase();
}

/** 字符二元组 Jaccard 相似度 — 双语对短文本足够稳健 */
function bigramJaccard(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const grams = (s: string) => {
        const set = new Set<string>();
        for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
        return set;
    };
    const sa = grams(a);
    const sb = grams(b);
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    const union = sa.size + sb.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * 在指定房间里查找内容近似重复的节点。命中则说明这条 reflection 已经存在过，
 * 不应再新建第二条 — 用户截图里那种"和之前的总结几乎一样"就是这种情况。
 *
 * 阈值 0.75 是凭经验取的：低于这个值通常是新意；高于这个值人眼看上去就是同一条。
 */
function findNearDuplicateInRoom(
    existing: MemoryNode[],
    room: MemoryNode['room'],
    candidateContent: string,
): MemoryNode | null {
    const target = normalizeForDedup(candidateContent);
    if (target.length < 4) return null;
    for (const n of existing) {
        if (n.room !== room) continue;
        const norm = normalizeForDedup(n.content);
        if (!norm) continue;
        if (norm === target || norm.includes(target) || target.includes(norm)) return n;
        if (bigramJaccard(norm, target) >= 0.75) return n;
    }
    return null;
}

async function executeActions(
    actions: DigestAction[],
    charId: string,
    material: {
        atticNodes: MemoryNode[];
        anticipations: Anticipation[];
        studyNodes: MemoryNode[];
        userRoomNodes: MemoryNode[];
        selfRoomNodes: MemoryNode[];
    },
): Promise<DigestResult> {
    const result: DigestResult = {
        resolved: [], deepened: [], faded: [],
        fulfilled: [], disappointed: [], internalized: [],
        synthesizedUser: [], selfInsights: [], selfConfused: [],
    };

    // 保存新衍生节点前用于查重的全量快照（同房间内容近似的就跳过 save）。
    // 本轮内新建的也加进来，防止同一轮里 LLM 返回两条 reflection 文案近似的动作。
    const existingNodes = await MemoryNodeDB.getByCharId(charId);

    for (const action of actions) {
        try {
            switch (action.action) {
                case 'resolve': {
                    // 阁楼→卧室：困惑化解了
                    const node = material.atticNodes.find(n => n.id === action.id);
                    if (node) {
                        node.room = 'bedroom';
                        node.mood = 'peaceful';
                        if (action.reflection) {
                            node.content = action.reflection;
                        }
                        await MemoryNodeDB.save(node);
                        result.resolved.push({ id: node.id, content: node.content });
                        console.log(`🕊️ [Digest] Resolved → bedroom: "${node.content.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'deepen': {
                    // 阁楼：困惑恶化，importance 提升
                    const node = material.atticNodes.find(n => n.id === action.id);
                    if (node) {
                        node.importance = Math.min(10, node.importance + 1);
                        if (action.reflection) {
                            node.content = action.reflection;
                        }
                        await MemoryNodeDB.save(node);
                        result.deepened.push({ id: node.id, content: node.content });
                        console.log(`💢 [Digest] Deepened (imp→${node.importance}): "${node.content.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'fade': {
                    // 淡忘：importance 降低
                    const node = material.atticNodes.find(n => n.id === action.id);
                    if (node) {
                        node.importance = Math.max(1, node.importance - 2);
                        await MemoryNodeDB.save(node);
                        result.faded.push({ id: node.id, content: node.content });
                        console.log(`🌫️ [Digest] Fading (imp→${node.importance}): "${node.content.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'fulfill': {
                    // 期盼实现（调用已有的 fulfillAnticipation）
                    const ant = material.anticipations.find(a => a.id === action.id);
                    await fulfillAnticipation(action.id);
                    result.fulfilled.push({ id: action.id, content: ant?.content || '' });
                    break;
                }

                case 'disappoint': {
                    // 期盼落空
                    const ant = material.anticipations.find(a => a.id === action.id);
                    await disappointAnticipation(action.id);
                    result.disappointed.push({ id: action.id, content: ant?.content || '' });
                    break;
                }

                case 'internalize': {
                    // 书房→self_room：知识内化为自我认同
                    const node = material.studyNodes.find(n => n.id === action.id);
                    if (node && action.reflection) {
                        const dup = findNearDuplicateInRoom(existingNodes, 'self_room', action.reflection);
                        if (dup) {
                            console.log(`🪞 [Digest] Skip internalize (dup of ${dup.id}): "${action.reflection.slice(0, 30)}..."`);
                            break;
                        }
                        const selfMemory: MemoryNode = {
                            id: generateId(),
                            charId,
                            content: action.reflection,
                            room: 'self_room',
                            tags: ['内化', '成长', ...node.tags],
                            importance: Math.max(node.importance, 7),
                            mood: 'peaceful',
                            embedded: false,
                            boxId: node.boxId,
                            boxTopic: '认知内化',
                            createdAt: node.createdAt,
                            lastAccessedAt: Date.now(),
                            accessCount: 0,
                            sourceId: node.id,
                            origin: 'digestion',
                        };
                        await MemoryNodeDB.save(selfMemory);
                        existingNodes.push(selfMemory);
                        result.internalized.push({ id: selfMemory.id, content: selfMemory.content });
                        console.log(`🪞 [Digest] Internalized → self_room: "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'synthesize_user': {
                    // user_room：信息整合，将零散词条合并为分类化的认知
                    const node = material.userRoomNodes.find(n => n.id === action.id);
                    if (node && action.reflection) {
                        const dup = findNearDuplicateInRoom(existingNodes, 'user_room', action.reflection);
                        if (dup) {
                            console.log(`👤 [Digest] Skip synthesize_user (dup of ${dup.id}): "${action.reflection.slice(0, 30)}..."`);
                            break;
                        }
                        const category = action.category || '综合';
                        const synthesized: MemoryNode = {
                            id: generateId(),
                            charId,
                            content: action.reflection,
                            room: 'user_room',
                            tags: [category, '整合认知', ...node.tags.filter(t => t !== '整合认知')],
                            importance: Math.max(node.importance, 6),
                            mood: 'peaceful',
                            embedded: false,
                            boxId: node.boxId,
                            boxTopic: `用户认知整合·${category}`,
                            createdAt: node.createdAt,
                            lastAccessedAt: Date.now(),
                            accessCount: 0,
                            sourceId: node.id,
                            origin: 'digestion',
                        };
                        await MemoryNodeDB.save(synthesized);
                        existingNodes.push(synthesized);
                        result.synthesizedUser.push({ id: synthesized.id, content: synthesized.content, category });
                        console.log(`👤 [Digest] Synthesized user → user_room [${category}]: "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'self_insight': {
                    // self_room 反刍 → 产生常驻自我领悟词条
                    const node = material.selfRoomNodes.find(n => n.id === action.id);
                    if (node && action.insight) {
                        const insightContent = action.reflection || action.insight;
                        // self_room 同时按 content 和 insight 全文查一次，
                        // 因为 content 是 50 字内独白，insight 是 200 字全文，两者风格不同。
                        const dupByContent = findNearDuplicateInRoom(existingNodes, 'self_room', insightContent);
                        const dupByInsight = findNearDuplicateInRoom(existingNodes, 'self_room', action.insight);
                        if (dupByContent || dupByInsight) {
                            const dup = dupByContent || dupByInsight!;
                            console.log(`💡 [Digest] Skip self_insight (dup of ${dup.id}): "${action.insight.slice(0, 30)}..."`);
                            break;
                        }
                        // 将领悟作为特殊标记的 self_room 记忆存储
                        const insightMemory: MemoryNode = {
                            id: generateId(),
                            charId,
                            content: insightContent,
                            room: 'self_room',
                            tags: ['自我领悟', '常驻', ...node.tags.filter(t => t !== '自我领悟' && t !== '常驻')],
                            importance: 9, // 领悟是高重要性的
                            mood: 'peaceful',
                            embedded: false,
                            boxId: 'digest_self_insight',
                            boxTopic: '自我领悟',
                            createdAt: node.createdAt,
                            lastAccessedAt: Date.now(),
                            accessCount: 0,
                            sourceId: node.id,
                            origin: 'digestion',
                        };
                        await MemoryNodeDB.save(insightMemory);
                        existingNodes.push(insightMemory);
                        // 返回 insight 文本用于注入 contextBuilder
                        result.selfInsights.push(action.insight);
                        console.log(`💡 [Digest] Self insight: "${action.insight}"`);
                    }
                    break;
                }

                case 'self_confuse': {
                    // self_room 反刍 → 产生新的自我困惑 → 阁楼
                    const node = material.selfRoomNodes.find(n => n.id === action.id);
                    if (node && action.reflection) {
                        const dup = findNearDuplicateInRoom(existingNodes, 'attic', action.reflection);
                        if (dup) {
                            console.log(`🌀 [Digest] Skip self_confuse (dup of ${dup.id}): "${action.reflection.slice(0, 30)}..."`);
                            break;
                        }
                        const confuseMemory: MemoryNode = {
                            id: generateId(),
                            charId,
                            content: action.reflection,
                            room: 'attic',
                            tags: ['自我困惑', '反刍', ...node.tags.filter(t => t !== '自我困惑' && t !== '反刍')],
                            importance: 6,
                            mood: 'confused',
                            embedded: false,
                            boxId: 'digest_self_confuse',
                            boxTopic: '自我反刍困惑',
                            createdAt: node.createdAt,
                            lastAccessedAt: Date.now(),
                            accessCount: 0,
                            sourceId: node.id,
                            origin: 'digestion',
                        };
                        await MemoryNodeDB.save(confuseMemory);
                        existingNodes.push(confuseMemory);
                        result.selfConfused.push({ id: confuseMemory.id, content: confuseMemory.content });
                        console.log(`🌀 [Digest] Self confused → attic: "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }
            }
        } catch (err: any) {
            console.warn(`⚡ [Digest] Action ${action.action} failed for ${action.id}:`, err.message);
        }
    }

    return result;
}

// ─── 主入口 ──────────────────────────────────────────

/**
 * 运行一次认知消化循环
 *
 * 触发时机：每次封盒后由 pipeline 调用（有冷却时间控制频率）
 * 也可以在记忆宫殿 App 里手动触发（用于测试）
 *
 * @param charId 角色 ID
 * @param charName 角色名
 * @param charPersona 角色核心人设（systemPrompt + worldview 片段）
 * @param llmConfig 轻量 LLM 配置
 * @param force 保留参数兼容，已无冷却限制
 */
/**
 * 向量化角色所有 embedded:false 的孤儿节点。
 *
 * digest 新建的 4 类节点（internalize / synthesize_user / self_insight / self_confuse）
 * 以及 anticipation.fulfill/disappoint 产生的卧室/阁楼记忆，都以 embedded:false 落盘，
 * 而现有管线不会再回头扫它们 —— 这步补上，保证它们能被 BM25/向量检索召回，
 * 并在配了远程向量时一并 upsert 到 Supabase。
 */
async function vectorizeOrphanedNodes(charId: string, embeddingConfig: EmbeddingConfig): Promise<void> {
    if (!embeddingConfig?.baseUrl || !embeddingConfig.apiKey) {
        console.log(`🔗 [Digest] 跳过孤儿向量化：未配置 embedding`);
        return;
    }
    try {
        const unembedded = await MemoryNodeDB.getUnembedded(charId);
        if (unembedded.length === 0) {
            console.log(`🔗 [Digest] 无孤儿节点，跳过向量化`);
            return;
        }
        console.log(`🔗 [Digest] 向量化 ${unembedded.length} 个待同步节点...`);
        const { stored, skipped } = await vectorizeAndStore(unembedded, embeddingConfig, getRemoteVectorConfig());
        console.log(`🔗 [Digest] 向量化完成：${stored} 入库，${skipped} 去重跳过`);
    } catch (err: any) {
        console.warn(`🔗 [Digest] 孤儿节点向量化失败（不影响消化结果）: ${err.message}`);
    }
}

export async function runCognitiveDigestion(
    charId: string,
    charName: string,
    charPersona: string,
    llmConfig: LightLLMConfig,
    _force: boolean = false,
    userName?: string,
    embeddingConfig?: EmbeddingConfig,
): Promise<DigestResult | null> {
    // 收集材料
    const material = await gatherDigestMaterial(charId);

    // 如果没有任何待消化的东西，仍然做一次孤儿节点向量化（历史遗留的 embedded:false 补齐）
    if (material.atticNodes.length === 0 &&
        material.anticipations.length === 0 &&
        material.studyNodes.length === 0 &&
        material.userRoomNodes.length === 0 &&
        material.selfRoomNodes.length === 0) {
        if (embeddingConfig) await vectorizeOrphanedNodes(charId, embeddingConfig);
        markDigested(charId);
        return { resolved: [], deepened: [], faded: [], fulfilled: [], disappointed: [], internalized: [], synthesizedUser: [], selfInsights: [], selfConfused: [] };
    }

    console.log(`🧠 [Digest] Starting cognitive digestion for ${charName}: ${material.atticNodes.length} attic, ${material.anticipations.length} anticipations, ${material.studyNodes.length} study, ${material.userRoomNodes.length} user, ${material.selfRoomNodes.length} self`);

    // LLM 统一消化
    const actions = await callDigestLLM(charName, charPersona, material, llmConfig, userName);

    // 执行动作
    const result = await executeActions(actions, charId, material);

    // 向量化本次新建的节点 + 任何历史遗留的孤儿节点
    if (embeddingConfig) await vectorizeOrphanedNodes(charId, embeddingConfig);

    // 重置轮数计数器 & 标记时间
    resetDigestRounds(charId);
    markDigested(charId);

    const total = result.resolved.length + result.deepened.length + result.faded.length +
        result.fulfilled.length + result.disappointed.length + result.internalized.length +
        result.synthesizedUser.length + result.selfInsights.length + result.selfConfused.length;
    if (total > 0) {
        console.log(`✅ [Digest] Complete: ${result.resolved.length} resolved, ${result.deepened.length} deepened, ${result.faded.length} faded, ${result.fulfilled.length} fulfilled, ${result.disappointed.length} disappointed, ${result.internalized.length} internalized, ${result.synthesizedUser.length} synthesized_user, ${result.selfInsights.length} self_insights, ${result.selfConfused.length} self_confused`);
    }

    return result;
}

// ─── 人格风格自动推断 ────────────────────────────────

const VALID_STYLES: PersonalityStyle[] = ['emotional', 'narrative', 'imagery', 'analytical'];

/**
 * 根据角色人设 + 已有记忆，让 LLM 判断角色的人格风格。
 * 首次启用记忆宫殿时自动调用一次，结果写入 self_room 并返回。
 *
 * @returns 推断出的 PersonalityStyle，失败时返回 'emotional' 作为默认值
 */
export async function detectPersonalityStyle(
    charId: string,
    charName: string,
    charPersona: string,
    llmConfig: LightLLMConfig,
): Promise<{ style: PersonalityStyle; ruminationTendency: number; reasoning: string }> {
    // 收集已有记忆作为参考（最多20条，按重要性排序）
    const allNodes = await MemoryNodeDB.getByCharId(charId);
    const sampleNodes = allNodes
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 20);

    const memoryContext = sampleNodes.length > 0
        ? `\n## 已有的记忆样本\n${sampleNodes.map((n, i) => `${i + 1}. [${n.room}/${n.mood}] ${n.content}`).join('\n')}`
        : '';

    const systemPrompt = `你是一个性格分析专家。根据角色的人设和记忆，判断这个角色的认知风格和反刍倾向。

## 角色：${charName}
${charPersona.slice(0, 1200)}
${memoryContext}

## 一、四种认知风格（style）

- **emotional**（情感型）：思维以情绪为主导，容易被感受牵引，联想时优先走情感链路。适合感性、共情力强、情绪丰富的角色。
- **narrative**（叙事型）：思维以时间线和因果为主导，喜欢讲故事、回顾经历。适合沉稳、重视经历和关系发展的角色。
- **imagery**（意象型）：思维以隐喻和画面为主导，喜欢用比喻理解世界。适合文艺、诗意、想象力丰富的角色。
- **analytical**（分析型）：思维以逻辑和因果为主导，喜欢分析、推理。适合理性、冷静、重视逻辑的角色。

## 二、反刍倾向（ruminationTendency）

0.0 ~ 1.0 之间的数值，表示这个角色有多容易反复纠结过去的事、翻旧账、被未解决的心结困扰。
- 0.0～0.2：洒脱、活在当下，很少纠结过去
- 0.3～0.5：正常水平，偶尔会想起旧事
- 0.6～0.8：敏感、容易纠结，经常翻旧账
- 0.9～1.0：极度执念型，无法释怀

请根据 ${charName} 的性格特征判断，给出简短理由（30字以内）。

严格 JSON 格式回复：
{"style": "emotional", "ruminationTendency": 0.3, "reasoning": "理由"}`;

    console.log(`🎭 [PersonalityDetect] ${charName} → 调用 LLM（model=${llmConfig.model}, max_tokens=8000）`);
    try {
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
                        { role: 'user', content: '请判断。' },
                    ],
                    temperature: 0.3,
                    // 8000：给 think 型模型留足思考空间，300 会被 reasoning 吃光
                    max_tokens: 8000,
                    stream: false,
                }),
            },
            2, 0, { appName: '记忆宫殿', charName, purpose: '人格审视' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const finishReason = data.choices?.[0]?.finish_reason;
        const usage = data.usage;
        console.log(`🎭 [PersonalityDetect] ${charName} LLM 原始返回 (finish=${finishReason}, usage=${JSON.stringify(usage || {})}):\n${reply}`);

        // 带引号意识的大括号栈扫描：从 reply 里提取所有顶层 {...} 候选
        // 老版本用 /\{[\s\S]*?\}/ 非贪婪匹配，遇到思考型模型 reasoning 里的
        // "{迷茫,焦虑}" 之类 stray braces 会匹配错对象，JSON.parse 恰好成功
        // 但 parsed.style / ruminationTendency 都是 undefined，然后被下面的
        // fallback 静默吞成 emotional/0.3 —— 这就是"LLM 明明说了 0.6 结果还是 0.3"的根因
        const jsonCandidates: string[] = [];
        {
            let depth = 0;
            let start = -1;
            let inString = false;
            let escape = false;
            for (let i = 0; i < reply.length; i++) {
                const c = reply[i];
                if (inString) {
                    if (escape) { escape = false; continue; }
                    if (c === '\\') { escape = true; continue; }
                    if (c === '"') { inString = false; }
                    continue;
                }
                if (c === '"') { inString = true; continue; }
                if (c === '{') {
                    if (depth === 0) start = i;
                    depth++;
                } else if (c === '}') {
                    if (depth > 0) {
                        depth--;
                        if (depth === 0 && start !== -1) {
                            jsonCandidates.push(reply.slice(start, i + 1));
                            start = -1;
                        }
                    }
                }
            }
        }

        // 在候选里挑第一个真正带 style 或 ruminationTendency 字段的
        let parsed: any = null;
        let pickedCandidate: string | null = null;
        const parseErrors: string[] = [];
        for (const cand of jsonCandidates) {
            try {
                const p = JSON.parse(cand);
                if (p && typeof p === 'object' && ('style' in p || 'ruminationTendency' in p)) {
                    parsed = p;
                    pickedCandidate = cand;
                    break;
                }
            } catch (e: any) {
                parseErrors.push(e?.message || String(e));
            }
        }

        if (parsed) {
            console.log(`🎭 [PersonalityDetect] ${charName} 从 ${jsonCandidates.length} 个 JSON 候选中命中目标：${pickedCandidate}`);
        } else {
            console.warn(`🎭 [PersonalityDetect] ${charName} 在 ${jsonCandidates.length} 个 JSON 候选里找不到含 style/ruminationTendency 的块。候选：${JSON.stringify(jsonCandidates)}，解析错误：${JSON.stringify(parseErrors)}`);
            throw new Error(`性格检测: 回复里找不到含 style/ruminationTendency 的 JSON${finishReason === 'length' ? '（疑似输出被截断 finish_reason=length）' : ''}`);
        }

        {
            const style = VALID_STYLES.includes(parsed.style) ? parsed.style : 'emotional';
            const rawRum = parseFloat(parsed.ruminationTendency);
            const ruminationTendency = isNaN(rawRum) ? 0.3 : Math.max(0, Math.min(1, Math.round(rawRum * 10) / 10));
            const reasoning = parsed.reasoning || '';

            const styleLabel = style === 'emotional' ? '情感型' : style === 'narrative' ? '叙事型' : style === 'imagery' ? '意象型' : '分析型';
            console.log(`🎭 [PersonalityDetect] ${charName} → ${styleLabel}，反刍倾向 ${ruminationTendency}（${reasoning}）`);

            // 写入 self_room 作为角色自我认知的一部分
            const selfMemory: MemoryNode = {
                id: `mn_${Date.now()}_pstyle`,
                charId,
                content: `我审视了自己，认识到自己是${styleLabel}的思维方式，反刍倾向为 ${ruminationTendency}。${reasoning}`,
                room: 'self_room',
                tags: ['人格风格', '自我认知'],
                importance: 7,
                mood: 'peaceful',
                embedded: false,
                boxId: 'system_personality_detect',
                boxTopic: '人格风格自我认知',
                createdAt: Date.now(),
                lastAccessedAt: Date.now(),
                accessCount: 0,
                origin: 'system',
            };
            await MemoryNodeDB.save(selfMemory);

            return { style, ruminationTendency, reasoning };
        }
    } catch (err: any) {
        console.warn(`🎭 [PersonalityDetect] ${charName} LLM 调用失败:`, err?.message || err, err?.stack || '');
        throw new Error(`性格检测失败: ${err?.message || err}`);
    }

    console.warn(`🎭 [PersonalityDetect] ${charName} LLM 未返回有效 JSON（回复中找不到 {...} 片段）`);
    throw new Error('性格检测: LLM 未返回有效 JSON');
}
