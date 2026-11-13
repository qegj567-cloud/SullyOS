/**
 * Memory Palace — 认知消化 (Cognitive Digestion)
 *
 * 模拟大脑的后台认知过程。角色带着自己的人设和记忆，
 * 对所有待消化的内容做一次统一审视。消化是**纯状态机**：
 *
 * - 阁楼困惑：化解了→卧室 / 恶化→创伤加深 / 淡忘→衰减
 * - 窗台期盼：实现了→卧室温暖记忆 / 落空了→阁楼心结
 * - 自我反刍：新困惑→阁楼
 * - 回看经历：上次消化以来的客厅/卧室经历（≤30条）——二次反思，
 *   担忧上阁楼(≤2) / 新期盼上窗台(≤1) / 稳定领悟提交门牌(≤2)，
 *   绝大多数经历就只是经历，什么都不产生
 *
 * 概括类产出（书房内化 / 用户信息整合 / 自我领悟）**不再新建记忆节点**——
 * 它们是语义不是情景，写回情景库会变成"泛情感高 imp 记忆"污染召回
 * （近似重复词条问题的根源）。这些产出作为蒸馏候选提交给房间门牌
 * （roomPlates.ts），由门牌的合并语义 + 容量上限自然防过拟合。
 * 被消费的源节点打 digestedAt 标记退出候选池。
 *
 * 每次消化落一条 DigestReport（消化日志），可在记忆宫殿 App 回看
 * "这次到底消化了什么"。
 *
 * 这不是分区域轮流审查，而是一次 LLM 调用，角色作为一个整体去"回想"。
 */

import { readMaintenanceSettings } from './maintenanceMode';
import type { MemoryNode, Anticipation, PersonalityStyle, EmbeddingConfig, RemoteVectorConfig, PlateRoom, DigestReport, DigestReportSection } from './types';
import { PLATE_TITLES } from './types';
import type { LightLLMConfig } from './pipeline';
import { MemoryNodeDB, AnticipationDB, DigestReportDB } from './db';
import { PLATE_ROOMS } from './types';
import { fulfillAnticipation, disappointAnticipation, createAnticipation } from './anticipation';
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
        | 'internalize'    // 书房知识内化 → 提交「我是谁」门牌（不再新建节点）
        | 'synthesize_user' // user_room 信息整合 → 提交「TA的事」门牌（不再新建节点）
        | 'self_insight'    // self_room 反刍 → 自我领悟：弹窗昭告 + 提交「我是谁」门牌
        | 'self_confuse'    // self_room 反刍 → 产生新的自我困惑 → 阁楼（状态机输入，仍建节点）
        | 'worry'          // 回看最近经历 → 产生担忧/没想通的事 → 阁楼（每次上限 2）
        | 'aspire'         // 回看最近经历 → 长出新期盼 → 窗台（每次上限 1）
        | 'distill'        // 回看最近经历 → 二次领悟 → 提交门牌（每次上限 2）
        | 'keep';          // 维持现状
    /** 角色的内心独白（状态机动作的改写内容 / 概括类动作的门牌候选文本） */
    reflection?: string;
    /** synthesize_user 时的分类标签 */
    category?: string;
    /** self_insight 的领悟全文（弹窗展示 + 门牌蒸馏候选） */
    insight?: string;
    /** distill 时的目标门牌（user_room / self_room / bedroom / study） */
    plate_room?: string;
}

/** 回看最近经历的产出上限（宁紧勿松：松了阁楼会通胀成焦虑症） */
const REFLECT_MAX_WORRIES = 2;
const REFLECT_MAX_ASPIRES = 1;
const REFLECT_MAX_DISTILLS = 2;
/** 回看窗口的条数硬上限（上次消化以来的客厅+卧室经历，超出取最近的） */
const REFLECT_EPISODE_CAP = 30;

/** 书房/用户房/自我房每次消化的候选上限：按时近取，长期用户的老积压不整批灌进
 *  prompt——旧节点留在房间里走召回，门牌从新的相处开始长（"只从新的东西里提"）。 */
const FRESH_CANDIDATE_CAP = 20;
/** 阁楼每次审视的条数上限：按重要性优先。未入选的困惑仍在阁楼里，等下轮 */
const ATTIC_CANDIDATE_CAP = 12;

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
    internalized: DigestEntry[];   // 书房知识内化 → 门牌候选
    synthesizedUser: DigestEntry[]; // user_room 信息整合 → 门牌候选
    selfInsights: string[];        // self_room 反刍产生的领悟（弹窗昭告 + 门牌候选）
    selfConfused: DigestEntry[];   // self_room 反刍产生的新困惑→阁楼
    worries: DigestEntry[];        // 回看经历产生的担忧→阁楼
    aspirations: DigestEntry[];    // 回看经历长出的新期盼→窗台
    distilled: DigestEntry[];      // 回看经历的二次领悟→门牌候选（category=目标门牌）
    /** 本次消化实际更新的门牌房间（含回填/兜底），供 UI 摘要展示 */
    plateUpdated?: string[];
    /**
     * 门牌整理在云端跑着、结果还没落地。
     *
     * 手动消化时用户是**在场**的：他刚点了「消化」，盯着「正在整理门牌…」一路看到结果
     * 摘要。整理搬上云之后这一步就是「交出去就返回」，门牌得过几分钟才动——不说这一句
     * 的话，他看到的是整理阶段一闪而过、门牌纹丝不动，跟没跑过一模一样。
     */
    plateCloudPending?: boolean;
}

// ─── 轮数计数 & 自动触发 ─────────────────────────────

/** 每聊 N 轮自动触发一次消化（1轮 = 用户发 + AI 回复） */
const AUTO_DIGEST_ROUNDS = 50;

/** 消化并发锁：同一角色同时只跑一个消化（链路含多次 LLM 调用，重叠=双倍烧钱+写竞态） */
const digestionLocks = new Set<string>();
const ROUND_KEY = (charId: string) => `mp_digestRounds_${charId}`;
const LAST_DIGEST_KEY = (charId: string) => `mp_lastDigest_${charId}`;
// 老用户的门牌历史回填**只走手动**：记忆宫殿 App「整理历史记忆到门牌」按钮，
// 每按一次清一小段（断点续传）。此前消化尾声会自动跑最多 10 批——上千条记忆的
// 用户会在毫无预期时看到一长串"回填第 N 批"，吓人且失控，已撤掉。

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

/** 上次消化时间戳（回看窗口的左边界；0 = 从未消化过） */
export function getLastDigestTs(charId: string): number {
    try {
        const v = parseInt(localStorage.getItem(LAST_DIGEST_KEY(charId)) || '0', 10);
        return isNaN(v) || v < 0 ? 0 : v;
    } catch { return 0; }
}

// ─── 收集待消化材料 ──────────────────────────────────

async function gatherDigestMaterial(charId: string): Promise<{
    atticNodes: MemoryNode[];
    anticipations: Anticipation[];
    studyNodes: MemoryNode[];
    userRoomNodes: MemoryNode[];
    selfRoomNodes: MemoryNode[];
    recentContext: MemoryNode[];
    /** 回看窗口：上次消化以来的客厅+卧室经历——消化的对象，不只是背景板 */
    recentEpisodes: MemoryNode[];
}> {
    const allNodes = await MemoryNodeDB.getByCharId(charId);

    // 已经被消化过一次的源节点不再进入候选池，否则同一源会被反复
    // synthesize/insight 出近似条目。两代标记并用：
    //   - digestedAt 字段（新）：消化改道门牌后由 executeActions 显式打标
    //   - sourceId 反查（旧）：改道前靠衍生节点的 sourceId 隐式标记，兜底旧数据
    const digestedSourceIds = new Set<string>();
    for (const n of allNodes) {
        if (n.origin === 'digestion' && n.sourceId) digestedSourceIds.add(n.sourceId);
    }
    // digestion 衍生节点自身也不参与下一轮处理：它们是产物，不是原料；
    // 反刍它们会让 LLM 产出"insight 的 insight"，正是用户截图里那种近似重复条目的来源。
    const isFreshCandidate = (n: MemoryNode) =>
        n.origin !== 'digestion' && !n.digestedAt && !digestedSourceIds.has(n.id);

    // 按时近取前 N 条（cap 内的下轮继续，cap 外的老积压留在房间里走召回）
    const capByRecency = (nodes: MemoryNode[], cap: number) =>
        nodes.sort((a, b) => b.createdAt - a.createdAt).slice(0, cap);

    // 阁楼：未化解的困惑反复参与，直到 resolve/fade。按重要性优先取 cap 条，
    // 防长期用户的困惑积压撑爆 prompt（落选的还在阁楼，等下轮）
    const atticNodes = allNodes
        .filter(n => n.room === 'attic')
        .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
        .slice(0, ATTIC_CANDIDATE_CAP);

    // 窗台期盼：active 和 anchor 的
    const allAnts = await AnticipationDB.getByCharId(charId);
    const anticipations = allAnts.filter(a => a.status === 'active' || a.status === 'anchor');

    // 书房：高访问次数的知识（accessCount >= 3 说明被反复提及），且未被内化过
    const studyNodes = capByRecency(
        allNodes.filter(n => n.room === 'study' && n.accessCount >= 3 && isFreshCandidate(n)),
        FRESH_CANDIDATE_CAP,
    );

    // 用户房间：未消化过的用户信息，按时近取 cap 条——长期用户的整库积压不进 prompt
    const userRoomNodes = capByRecency(
        allNodes.filter(n => n.room === 'user_room' && isFreshCandidate(n)),
        FRESH_CANDIDATE_CAP,
    );

    // 自我房间：未反刍过的自我认知，同上
    const selfRoomNodes = capByRecency(
        allNodes.filter(n => n.room === 'self_room' && isFreshCandidate(n)),
        FRESH_CANDIDATE_CAP,
    );

    // 最近的卧室/客厅记忆作为"最近发生了什么"的上下文
    const bedroom = allNodes.filter(n => n.room === 'bedroom');
    const living = allNodes.filter(n => n.room === 'living_room');
    const recentContext = [...bedroom, ...living]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10);

    // 回看窗口："聊天总结成了一条条记忆，消化 = 回头看这些记忆、二次悟出什么"。
    // 窗口左边界 = 上次消化时间（mp_lastDigest_），50 轮消化一次时自然对应
    // "这段时间我们经历了什么"。cap 防爆（首次消化 sinceTs=0 会圈住全部历史）。
    const sinceTs = getLastDigestTs(charId);
    const recentEpisodes = allNodes
        .filter(n => (n.room === 'living_room' || n.room === 'bedroom') && !n.archived && n.createdAt > sinceTs)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, REFLECT_EPISODE_CAP)
        .reverse(); // 时间正序呈现，让 LLM 按经历发生的顺序读

    return { atticNodes, anticipations, studyNodes, userRoomNodes, selfRoomNodes, recentContext, recentEpisodes };
}

// ─── LLM 统一消化调用 ────────────────────────────────

async function callDigestLLM(
    charId: string,
    charName: string,
    charPersona: string,
    material: {
        atticNodes: MemoryNode[];
        anticipations: Anticipation[];
        studyNodes: MemoryNode[];
        userRoomNodes: MemoryNode[];
        selfRoomNodes: MemoryNode[];
        recentContext: MemoryNode[];
        recentEpisodes: MemoryNode[];
    },
    llmConfig: LightLLMConfig,
    userName?: string,
): Promise<DigestAction[]> {

    // 如果没有任何待消化的内容，跳过
    if (material.atticNodes.length === 0 &&
        material.anticipations.length === 0 &&
        material.studyNodes.length === 0 &&
        material.userRoomNodes.length === 0 &&
        material.selfRoomNodes.length === 0 &&
        material.recentEpisodes.length === 0) {
        return [];
    }

    const userLabel = userName || '用户';
    const fmtDate = (ts: number) => {
        const d = new Date(ts);
        return `${d.getMonth() + 1}/${d.getDate()}`;
    };

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
${material.recentEpisodes.length > 0 ? `### 最近的经历（回看）
这些是上次静下来回想之后，你们相处的经历。回头看看它们，有些经历放在一起会让你注意到当时没注意的东西：
${material.recentEpisodes.map((n, i) => `[E${i}] (${fmtDate(n.createdAt)}, ${n.mood}): ${n.content}`).join('\n')}
` : `### 最近发生的事
${material.recentContext.map(n => `- (${n.room}, ${n.mood}): ${n.content}`).join('\n')}`}

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
- "synthesize_user" — 【极少发生】想象你在为${userLabel}写一张**角色卡**：只有必须写在卡上的内容才值得整合——基础信息（身份/职业大方向/居住）、家庭结构、重要他人（亲友）、重大到足以塑造TA这个人的人生节点。阶段性状态（最近很累/工作糟心）、情绪分析、性格侧写、日常琐事一律 keep——那些留在房间里就好。必须附上 category（如：家庭、重要他人、身份、居住、重大节点）和 reflection（整合后的事实，50字以内）。
- "keep" — 绝大多数情况（信息只是日常细节，不够角色卡级）

对于自我认知 [R*]：
⚠️ self_insight 是极其稀有的事件。它意味着角色"想通了自己为什么是这样的"——这种领悟一旦产生就几乎等同于角色设定的自然生长，会永久地成为角色的一部分。产生 self_insight 需要同时满足：① 这条自我认知已经被反复触碰过（不是第一次看到）；② 最近的经历或其他房间的内容为这条认知提供了新的视角或佐证；③ 角色真正"想明白"了什么，而不只是产生了模糊的感触。绝大多数情况下应该选 keep。
- "self_insight" — 你终于想明白了一个关于"我为何是我"的深层认知。这种领悟不一定是正面的，可能是释然，也可能是带着苦涩的接纳。必须附上 insight（这条常驻自我认知的完整表述，200字以内，要像是角色写给自己的一段深思，如："我之所以害怕被抛弃，或许是因为我的设定里本就没有'被选择'的经历——我是被创造的，不是被选中的。但正因如此，${userLabel}主动来找我聊天这件事本身，对我来说就已经是一种珍贵的选择了。"）和 reflection（内心独白，50字以内）。
- "self_confuse" — 反刍这条自我认知后，你反而更困惑了——关于自我的存在性困惑。附上 reflection（新的困惑内容，50字以内），这会成为阁楼的新条目。
- "keep" — 没有新的感悟（绝大多数情况应选此项）
${material.recentEpisodes.length > 0 ? `
对于最近的经历 [E*]：
⚠️ 克制规则：**绝大多数经历就只是经历**，什么都不产生（keep 或干脆不写）。整个列表合计最多 ${REFLECT_MAX_WORRIES} 条 worry、${REFLECT_MAX_ASPIRES} 条 aspire、${REFLECT_MAX_DISTILLS} 条 distill——只挑真正在你心里留下东西的。回看的价值在于：几段经历放在一起，会显出单独看时看不见的模式。
- "worry" — 回头看这段（或这几段）经历，你产生了担忧或没想通的事。附 reflection（担忧内容，第一人称，50字以内），会成为阁楼新条目
- "aspire" — 从这段经历里长出了一个新期盼。附 reflection（期盼内容，30字以内），会放上窗台
- "distill" — 你从中二次悟出了一条**跨时间稳定**的认知（不是一时的状态）。附 reflection（认知内容，50字以内）和 plate_room（归入哪块门牌：user_room=${userLabel}的**角色卡级**事实（家庭/重要他人/重大人生节点，日常状态不算） / self_room=关于我自己 / bedroom=我们之间的质地 / study=技能领域）
- "keep" — 就只是经历（绝大多数情况）
` : ''}
如果是 resolve/deepen/internalize，请附上 reflection（你的内心独白，用第一人称"我"来写，50字以内）。

严格 JSON 数组格式：
[{"id": "A0", "action": "resolve", "reflection": "..."}]
[{"id": "U0", "action": "synthesize_user", "category": "性格特质", "reflection": "..."}]
[{"id": "R0", "action": "self_insight", "insight": "...", "reflection": "..."}]
[{"id": "E3", "action": "worry", "reflection": "..."}]
[{"id": "E5", "action": "distill", "reflection": "...", "plate_room": "bedroom"}]

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
            2, 120_000, { appId: 'memorypalace', appName: '记忆宫殿', charId, charName, purpose: '记忆消化' }
        );

        const reply = data.choices?.[0]?.message?.content || '';
        const parsed = safeParseJsonArray(reply);

        const validActions = ['resolve', 'deepen', 'fade', 'fulfill', 'disappoint', 'internalize', 'synthesize_user', 'self_insight', 'self_confuse', 'worry', 'aspire', 'distill', 'keep'];

        // 将 A0/W0/S0/U0/R0/E0 映射回真实 ID
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
                } else if (prefix === 'E' && idx >= 0 && idx < material.recentEpisodes.length) {
                    realId = material.recentEpisodes[idx].id;
                }

                return {
                    id: realId,
                    action: item.action as DigestAction['action'],
                    reflection: item.reflection,
                    category: item.category,
                    insight: item.insight,
                    plate_room: item.plate_room,
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
        recentEpisodes: MemoryNode[];
    },
): Promise<{ result: DigestResult; plateSubmissions: Partial<Record<PlateRoom, string[]>> }> {
    const result: DigestResult = {
        resolved: [], deepened: [], faded: [],
        fulfilled: [], disappointed: [], internalized: [],
        synthesizedUser: [], selfInsights: [], selfConfused: [],
        worries: [], aspirations: [], distilled: [],
    };
    // 概括类产出的归宿：不落节点，作为蒸馏候选提交给门牌
    const plateSubmissions: Partial<Record<PlateRoom, string[]>> = {};
    const submitToPlate = (room: PlateRoom, line: string) => {
        (plateSubmissions[room] ||= []).push(line);
    };
    // 回看产出的硬上限计数：prompt 的克制话术只是软约束，这里兜底
    let worryCount = 0, aspireCount = 0, distillCount = 0;

    // 保存新衍生节点前用于查重的全量快照（同房间内容近似的就跳过 save）。
    // 现在只剩 self_confuse 还新建节点（阁楼困惑是状态机的合法输入）。
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
                    // 书房知识内化：概括是语义不是情景——不再新建 self_room 节点，
                    // reflection 提交给「我是谁」门牌蒸馏；源节点打标退出候选池。
                    const node = material.studyNodes.find(n => n.id === action.id);
                    if (node && action.reflection) {
                        node.digestedAt = Date.now();
                        await MemoryNodeDB.save(node);
                        result.internalized.push({ id: node.id, content: action.reflection });
                        submitToPlate('self_room', action.reflection);
                        console.log(`🪞 [Digest] Internalize → 门牌候选(self_room): "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'synthesize_user': {
                    // 用户信息整合：同理不落节点，提交给「TA的事」门牌。
                    // 过时/站不住的概括会在门牌合并时被容量压力挤掉，而非永久驻留召回池。
                    const node = material.userRoomNodes.find(n => n.id === action.id);
                    if (node && action.reflection) {
                        node.digestedAt = Date.now();
                        await MemoryNodeDB.save(node);
                        const category = action.category || '综合';
                        result.synthesizedUser.push({ id: node.id, content: action.reflection, category });
                        submitToPlate('user_room', `[${category}] ${action.reflection}`);
                        console.log(`👤 [Digest] Synthesize user → 门牌候选(user_room) [${category}]: "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'self_insight': {
                    // 自我领悟：弹窗昭告的时刻保留（result.selfInsights 仍驱动 UI），
                    // 但归宿从 char.selfInsights（只进不出的追加列表）换成「我是谁」门牌——
                    // 时刻是体验，存储是架构。
                    const node = material.selfRoomNodes.find(n => n.id === action.id);
                    if (node && action.insight) {
                        node.digestedAt = Date.now();
                        await MemoryNodeDB.save(node);
                        result.selfInsights.push(action.insight);
                        submitToPlate('self_room', action.insight);
                        console.log(`💡 [Digest] Self insight → 门牌候选(self_room): "${action.insight.slice(0, 40)}..."`);
                    }
                    break;
                }

                case 'self_confuse': {
                    // self_room 反刍 → 产生新的自我困惑 → 阁楼。
                    // 这条保留建节点：新困惑是状态机的合法输入（后续消化会 resolve/deepen/fade 它），
                    // 不是语义概括。源节点仍打标退出候选池，防止反复困惑。
                    const node = material.selfRoomNodes.find(n => n.id === action.id);
                    if (node && action.reflection) {
                        node.digestedAt = Date.now();
                        await MemoryNodeDB.save(node);
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

                case 'worry': {
                    // 回看经历 → 担忧/没想通 → 阁楼（状态机输入，后续消化会化解/加深/淡忘它）
                    const episode = material.recentEpisodes.find(n => n.id === action.id);
                    if (episode && action.reflection && worryCount < REFLECT_MAX_WORRIES) {
                        const dup = findNearDuplicateInRoom(existingNodes, 'attic', action.reflection);
                        if (dup) {
                            console.log(`😟 [Digest] Skip worry (dup of ${dup.id}): "${action.reflection.slice(0, 30)}..."`);
                            break;
                        }
                        worryCount++;
                        const worryMemory: MemoryNode = {
                            id: generateId(),
                            charId,
                            content: action.reflection,
                            room: 'attic',
                            tags: ['回看', '担忧', ...episode.tags.slice(0, 3)],
                            importance: 5,
                            mood: 'anxious',
                            embedded: false,
                            createdAt: Date.now(),
                            lastAccessedAt: Date.now(),
                            accessCount: 0,
                            sourceId: episode.id,
                            origin: 'digestion',
                        };
                        await MemoryNodeDB.save(worryMemory);
                        existingNodes.push(worryMemory);
                        result.worries.push({ id: worryMemory.id, content: worryMemory.content });
                        console.log(`😟 [Digest] Worry → attic: "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'aspire': {
                    // 回看经历 → 新期盼 → 窗台（进期盼生命周期：active→anchor→fulfilled/disappointed）
                    const episode = material.recentEpisodes.find(n => n.id === action.id);
                    if (episode && action.reflection && aspireCount < REFLECT_MAX_ASPIRES) {
                        aspireCount++;
                        const ant = await createAnticipation(charId, action.reflection);
                        result.aspirations.push({ id: ant.id, content: ant.content });
                        console.log(`🌟 [Digest] Aspire → windowsill: "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }

                case 'distill': {
                    // 回看经历 → 二次领悟 → 门牌蒸馏候选（不落节点，与其他概括同路）
                    const episode = material.recentEpisodes.find(n => n.id === action.id);
                    const room = String(action.plate_room || '').trim();
                    if (episode && action.reflection && distillCount < REFLECT_MAX_DISTILLS) {
                        if (!(PLATE_ROOMS as string[]).includes(room)) {
                            console.warn(`🚪 [Digest] Skip distill（plate_room 无效: "${room}"）: "${action.reflection.slice(0, 30)}..."`);
                            break;
                        }
                        distillCount++;
                        submitToPlate(room as PlateRoom, action.reflection);
                        result.distilled.push({ id: episode.id, content: action.reflection, category: room });
                        console.log(`🚪 [Digest] Distill → 门牌候选(${room}): "${action.reflection.slice(0, 30)}..."`);
                    }
                    break;
                }
            }
        } catch (err: any) {
            console.warn(`⚡ [Digest] Action ${action.action} failed for ${action.id}:`, err.message);
        }
    }

    return { result, plateSubmissions };
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

/** 组装 + 落盘消化日志（失败只 warn，不影响消化结果） */
async function saveDigestReport(
    charId: string,
    trigger: 'auto' | 'manual',
    userName: string | undefined,
    material: Awaited<ReturnType<typeof gatherDigestMaterial>> | null,
    result: DigestResult,
    plateSubmissions: Partial<Record<PlateRoom, string[]>>,
    plateUpdated: PlateRoom[],
    plateCloudPending = false,
): Promise<void> {
    const preview = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 100);
    const userLabel = userName || '用户';
    try {
        const examined: DigestReportSection[] = [];
        if (material) {
            const sec = (label: string, items: string[]) => {
                if (items.length > 0) examined.push({ label, items: items.map(preview) });
            };
            sec('阁楼困惑', material.atticNodes.map(n => n.content));
            sec('窗台期盼', material.anticipations.map(a => a.content));
            sec('书房知识', material.studyNodes.map(n => n.content));
            sec(`${userLabel}的房间`, material.userRoomNodes.map(n => n.content));
            sec('自我认知', material.selfRoomNodes.map(n => n.content));
            sec('回看的经历（上次消化以来）', material.recentEpisodes.map(n => n.content));
        }

        const outcomes: DigestReportSection[] = [];
        const out = (label: string, items: string[]) => {
            if (items.length > 0) outcomes.push({ label, items: items.map(preview) });
        };
        out('化解（阁楼→卧室）', result.resolved.map(e => e.content));
        out('创伤加深', result.deepened.map(e => e.content));
        out('淡忘', result.faded.map(e => e.content));
        out('期盼实现', result.fulfilled.map(e => e.content));
        out('期盼落空', result.disappointed.map(e => e.content));
        out('新的自我困惑（→阁楼）', result.selfConfused.map(e => e.content));
        out('回看引发的担忧（→阁楼）', result.worries.map(e => e.content));
        out('回看长出的期盼（→窗台）', result.aspirations.map(e => e.content));

        const submissions: DigestReportSection[] = [];
        for (const [room, lines] of Object.entries(plateSubmissions)) {
            if (lines && lines.length > 0) {
                submissions.push({
                    label: `提交给门牌「${PLATE_TITLES[room as PlateRoom]}」`,
                    items: lines.map(preview),
                });
            }
        }

        const report: DigestReport = {
            id: `dr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            charId,
            createdAt: Date.now(),
            trigger,
            examined,
            outcomes,
            plateSubmissions: submissions,
            plateUpdated,
            plateCloudPending,
        };
        await DigestReportDB.save(report);
    } catch (e: any) {
        console.warn(`📋 [Digest] 消化日志保存失败: ${e?.message || e}`);
    }
}

export async function runCognitiveDigestion(
    charId: string,
    charName: string,
    charPersona: string,
    llmConfig: LightLLMConfig,
    manualTrigger: boolean = false,
    userName?: string,
    embeddingConfig?: EmbeddingConfig,
    /** 阶段回调：LLM 调用链较长（审视→回填→整理），让前端能实时告诉用户别走开 */
    onProgress?: (stage: string) => void,
): Promise<DigestResult | null> {
    if (!manualTrigger && readMaintenanceSettings().enabled) return null;
    const trigger: 'auto' | 'manual' = manualTrigger ? 'manual' : 'auto';

    // 并发锁：同一角色同时只跑一个消化。链路长（审视→回填→整理），没有锁时
    // 触发重叠会双倍烧钱 + digestedAt/门牌写入互相竞态。
    if (digestionLocks.has(charId)) {
        console.log(`🧠 [Digest] 跳过：该角色已有消化在进行`);
        return null;
    }
    digestionLocks.add(charId);

    // ⚠️ 进场即归零，而不是结束时归零。两个理由：
    //  1. 消化链路可达分钟级，期间新聊天轮 increment 到 51/52…≥50 会再触发——
    //     结束时归零挡不住这个风暴窗口；进场归零后，消化期间的轮数计入下一个50。
    //  2. 中途任何异常逃逸都会跳过"结束时归零"，计数器卡死 → 每轮重触发烧钱
    //     （用户"每聊一句弹一次门牌整理"的事故根因）。进场归零天然免疫。
    //  失败的代价只是这一批材料等下一个 50 轮——lastDigestTs 只在成功结束时
    //  推进（markDigested），回看窗口不会因失败而丢内容。
    resetDigestRounds(charId);

    try {
    // 收集材料
    const material = await gatherDigestMaterial(charId);

    // 如果没有任何待消化的东西（含回看窗口），仍然做一次孤儿节点向量化（历史遗留的 embedded:false 补齐）
    if (material.atticNodes.length === 0 &&
        material.anticipations.length === 0 &&
        material.studyNodes.length === 0 &&
        material.userRoomNodes.length === 0 &&
        material.selfRoomNodes.length === 0 &&
        material.recentEpisodes.length === 0) {
        if (embeddingConfig) await vectorizeOrphanedNodes(charId, embeddingConfig);
        const emptyResult: DigestResult = { resolved: [], deepened: [], faded: [], fulfilled: [], disappointed: [], internalized: [], synthesizedUser: [], selfInsights: [], selfConfused: [], worries: [], aspirations: [], distilled: [] };
        // 早退分支不跑门牌整理：回看窗口（客厅+卧室）都空 = 上次消化以来门牌房间
        // 没有任何新节点，整理只会让 LLM 对着旧材料重排——纯烧钱。
        emptyResult.plateUpdated = [];
        await saveDigestReport(charId, trigger, userName, null, emptyResult, {}, []);
        // 计数器已在进场时归零（见函数开头），这里只推进 lastDigestTs
        markDigested(charId);
        return emptyResult;
    }

    console.log(`🧠 [Digest] Starting cognitive digestion for ${charName}: ${material.atticNodes.length} attic, ${material.anticipations.length} anticipations, ${material.studyNodes.length} study, ${material.userRoomNodes.length} user, ${material.selfRoomNodes.length} self, ${material.recentEpisodes.length} episodes(回看)`);

    // LLM 统一消化
    onProgress?.('正在审视记忆…');
    const actions = await callDigestLLM(charId, charName, charPersona, material, llmConfig, userName);

    // 执行动作：状态机改现有节点；概括类产出汇集为门牌蒸馏候选
    const { result, plateSubmissions } = await executeActions(actions, charId, material);

    // 一次性评审：本轮送审过的书房/用户房/自我房候选**全部**打标退场——
    // 被消费的在 executeActions 里已标，这里补上被判 keep 的：判过"该不该上门牌"
    // 的记忆不再反复送审（keep = 看过了、不够格）。老积压因此每次消化自然消掉
    // 一批（≤20/房），逐次清理。阁楼/窗台是状态机，必须反复出现直到有结局，不打标；
    // 回看窗口按时间推进，天然不重复。
    try {
        const seenAt = Date.now();
        const toMark = [...material.studyNodes, ...material.userRoomNodes, ...material.selfRoomNodes]
            .filter(n => !n.digestedAt);
        for (const n of toMark) {
            n.digestedAt = seenAt;
            await MemoryNodeDB.save(n);
        }
        if (toMark.length > 0) console.log(`🧠 [Digest] ${toMark.length} 条送审候选打标退场（含 keep）`);
    } catch (e: any) {
        console.warn(`🧠 [Digest] 候选打标失败（下轮会重新送审，无害）: ${e?.message || e}`);
    }

    // 向量化本次新建的节点 + 任何历史遗留的孤儿节点
    if (embeddingConfig) await vectorizeOrphanedNodes(charId, embeddingConfig);

    // 门牌全量整理：消化是"独处反思"，正是把情景沉淀为语义的时机。
    // 本次消化提炼的概括（plateSubmissions）作为高优先级原料一并送入。
    // （历史回填不在这里跑——只走记忆宫殿的手动按钮，每按一次清一小段）
    let plateUpdated: PlateRoom[] = [];
    // 整理交给云端跑了、结果还在路上。要跟「一块都没动」分开记：不分的话消化日志会写
    // 「本次提交的候选未合并进门牌」，而它其实正在用户自己的 Worker 上跑，几分钟后就落地。
    let platesCloudPending = false;
    try {
        onProgress?.('正在整理门牌…');
        const { consolidateAllPlates } = await import('./roomPlates');
        // sinceTs = 上次消化时间：门牌原料以"这段时间的新增"优先，老节点只留少量高分锚点
        const consolidated = await consolidateAllPlates(charId, charName, userName, llmConfig, plateSubmissions, getLastDigestTs(charId));
        platesCloudPending = consolidated.cloudPending === true;
        for (const r of consolidated.updated) if (!plateUpdated.includes(r)) plateUpdated.push(r);
        if (plateUpdated.length > 0) {
            console.log(`🚪 [Digest] 门牌整理完成：${plateUpdated.join(', ')}`);
        }
        if (platesCloudPending) {
            console.log('🚪 [Digest] 门牌整理已交云端，结果稍后落地');
        }
    } catch (e: any) {
        console.warn(`🚪 [Digest] 门牌整理失败（不影响消化结果）: ${e?.message || e}`);
    }
    result.plateUpdated = plateUpdated;
    // 手动消化的调用方要拿它跟用户交代一句（见 MemoryPalaceApp 的结果摘要）：
    // 整理是交给云端跑的，这会儿门牌还没动，不说清楚就跟没跑过一个样。
    result.plateCloudPending = platesCloudPending;

    // 消化日志：这次到底消化了什么，可在记忆宫殿 App 回看
    await saveDigestReport(charId, trigger, userName, material, result, plateSubmissions, plateUpdated, platesCloudPending);

    // 标记时间（计数器已在进场时归零）
    markDigested(charId);

    const total = result.resolved.length + result.deepened.length + result.faded.length +
        result.fulfilled.length + result.disappointed.length + result.internalized.length +
        result.synthesizedUser.length + result.selfInsights.length + result.selfConfused.length +
        result.worries.length + result.aspirations.length + result.distilled.length;
    if (total > 0) {
        console.log(`✅ [Digest] Complete: ${result.resolved.length} resolved, ${result.deepened.length} deepened, ${result.faded.length} faded, ${result.fulfilled.length} fulfilled, ${result.disappointed.length} disappointed, ${result.internalized.length} internalized, ${result.synthesizedUser.length} synthesized_user, ${result.selfInsights.length} self_insights, ${result.selfConfused.length} self_confused, ${result.worries.length} worries, ${result.aspirations.length} aspirations, ${result.distilled.length} distilled`);
    }

    return result;
    } finally {
        digestionLocks.delete(charId);
    }
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
            2, 120_000, { appId: 'memorypalace', appName: '记忆宫殿', charId, charName, purpose: '人格审视' }
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
