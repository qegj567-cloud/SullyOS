/**
 * Memory Palace (记忆宫殿) — 类型定义
 *
 * 模拟人脑七个脑区的记忆系统。
 * 所有类型定义集中在此文件，供其他模块导入。
 */

// ─── 七个房间 ─────────────────────────────────────────

export type MemoryRoom =
    | 'living_room'   // 客厅 — 日常闲聊、近期互动（海马体）
    | 'bedroom'       // 卧室 — 亲密情感、深层羁绊（新皮层）
    | 'study'         // 书房 — 工作学习、技能成长（前额叶）
    | 'user_room'     // 用户房间 — 用户个人信息、习惯（颞顶联合区）
    | 'self_room'     // 自我房间 — 角色自我认同、演变（默认模式网络）
    | 'attic'         // 阁楼 — 未消化的困惑、潜意识（杏仁核–海马体）
    | 'windowsill';   // 窗台 — 期盼、目标、憧憬（多巴胺奖赏系统）

export interface RoomConfig {
    capacity: number | null;    // null = 无限
    decayRate: number | null;   // null = 永不遗忘，数值为每小时衰减基数
    description: string;
}

export const ROOM_CONFIGS: Record<MemoryRoom, RoomConfig> = {
    living_room: { capacity: 200,  decayRate: 0.9972, description: '日常闲聊、近期互动' },
    bedroom:     { capacity: null, decayRate: 0.9995, description: '亲密情感、深层羁绊' },
    study:       { capacity: null, decayRate: 0.9995, description: '工作学习、技能成长' },
    user_room:   { capacity: null, decayRate: 0.9995, description: '用户个人信息、习惯' },
    self_room:   { capacity: null, decayRate: null,   description: '角色自我认同、演变' },
    attic:       { capacity: null, decayRate: null,   description: '未消化的困惑、潜意识' },
    windowsill:  { capacity: null, decayRate: null,   description: '期盼、目标、憧憬' },
};

/** 检索读到旧档/远程异常房间时沿用提取入口的客厅兜底，不改写原始记录。 */
export function resolveMemoryScoringRoom(room: unknown): MemoryRoom {
    return typeof room === 'string' && Object.prototype.hasOwnProperty.call(ROOM_CONFIGS, room)
        ? room as MemoryRoom : 'living_room';
}

export const ROOM_LABELS: Record<MemoryRoom, string> = {
    living_room: '客厅',
    bedroom:     '卧室',
    study:       '书房',
    user_room:   '用户房间',
    self_room:   '自我房间',
    attic:       '阁楼',
    windowsill:  '窗台',
};

/**
 * 获取房间的动态显示标签。
 * user_room 在有用户名时显示为"【用户名】的房间"，其余房间返回静态标签。
 */
export function getRoomLabel(room: MemoryRoom, userName?: string): string {
    if (room === 'user_room' && userName) {
        return `${userName}的房间`;
    }
    return ROOM_LABELS[room];
}

// ─── 记忆节点 ─────────────────────────────────────────

export interface MemoryEntity {
    /** 记忆中明确出现的专名；不收录“他 / 朋友 / 那个项目”这类泛称。 */
    name: string;
    type?: 'person' | 'place' | 'organization' | 'project' | 'product' | 'account' | 'domain' | 'other';
    /** 第一版不自动推断别名，只消费已经明确存下来的别名。 */
    aliases?: string[];
}

export interface MemoryNode {
    /** 可选补注的固定说话日期，不是 createdAt 事件日。原文始终不含系统补注。 */
    relativeTimeAnchor?: { dateKey: string; source: 'message'; messageId?: number };
    id: string;
    charId: string;
    content: string;            // 记忆内容（提取记忆为第三人称叙事，消化衍生记忆为第一人称内心独白）
    room: MemoryRoom;
    tags: string[];
    /** 用于显式实体精确召回；旧数据没有此字段时会回退到 tags/content 精确匹配。 */
    entities?: MemoryEntity[];
    importance: number;         // 1–10
    mood: string;               // 情绪标签，如 'happy', 'sad', 'angry'
    /** Russell 环形情感模型 · 效价：-1 极痛苦 → +1 极愉悦。未填则由 emotionSpace.getEmotionVA() 查表兜底 */
    valence?: number;
    /** Russell 环形情感模型 · 唤醒度：-1 极平静 → +1 极激烈 */
    arousal?: number;
    embedded: boolean;          // 是否已向量化
    createdAt: number;          // timestamp ms
    lastAccessedAt: number;     // timestamp ms
    accessCount: number;
    pinnedUntil?: number | null; // 便利贴置顶截止时间（timestamp ms），null/undefined = 不置顶
    sourceId?: string | null;   // 消化衍生记忆的源记忆 ID，null = 非衍生记忆
    origin?: 'extraction' | 'digestion' | 'system'; // 记忆来源：extraction=聊天提取, digestion=认知消化衍生, system=系统生成
    /**
     * 消化已消费标记：synthesize_user / internalize / self_insight / self_confuse
     * 消费过的源节点打上时间戳，不再进入后续消化的候选池。
     * 历史上这个"已消费"信息靠衍生节点的 sourceId 反查——消化改道门牌后
     * 不再新建衍生节点，改用此字段显式标记（旧数据仍走 sourceId 反查兜底）。
     */
    digestedAt?: number | null;

    /**
     * 历史版本曾迁移过的第三方语义元数据。当前已不再提供对应导入能力；保留该字段仅为
     * 兼容已经落进用户本机数据库的旧记录，避免升级后读取异常。
     */
    legacyCsy?: {
        originalId: string;
        title: string;
        originalContent: string;
        emotionalJourney?: string;
        source?: 'auto' | 'manual' | 'import';
        sourceMessageIds?: number[];
        deprecated?: boolean;
        deprecatedReason?: string;
        hormoneSnapshot?: Record<string, number | undefined>;
        salienceScore?: number;
        updatedAt?: number;
        modelId?: string;
    };

    // ─── EventBox 绑定（新） ─────────────────
    eventBoxId?: string | null;  // 所属事件盒 ID，null/undefined = 独立记忆（"地上的球"）
    archived?: boolean;          // true = 已被压入 box summary，不再参与召回（可复活）
    isBoxSummary?: boolean;      // true = 此节点是某 EventBox 的压缩总结

    // ─── 群聊记忆来源（独立管线，私聊代码不感知这两个字段） ─────────────
    /** 这条记忆来自哪个群（groupPipeline 提取时打上）；undefined = 来自私聊 */
    groupId?: string;
    /** 群名快照（用于群被删除后仍能在 UI 里识别这条记忆来自哪个群） */
    groupName?: string;

    // ─── 已弃用字段（保留以兼容历史数据读取，新代码不应写入） ───
    /** @deprecated 旧话题盒 ID，已由 eventBoxId 替代 */
    boxId?: string;
    /** @deprecated 旧话题摘要，已废弃 */
    boxTopic?: string;
}

// ─── 向量存储 ─────────────────────────────────────────

export interface MemoryVector {
    memoryId: string;           // 关联 MemoryNode.id
    charId: string;             // 冗余角色 ID，用于 IndexedDB 索引直查，避免全表扫描
    // 1024 维向量。三种形态：
    //   - 在内存里检索时是 Float32Array（4 bytes / dim）
    //   - 写入 IndexedDB 时是 Uint8Array（Float32 的原始字节，4 bytes / dim）
    //   - 旧数据是 number[]（每个 number ~50 字节，惊人浪费），读取时会被透明
    //     地转换并在下次写入时持久化为 Uint8Array。
    // 出 DB 层之后调用方拿到的永远是 Float32Array。
    vector: number[] | Float32Array | Uint8Array;
    dimensions: number;
    model?: string;             // 生成此向量的 embedding 模型名（用于换模型检测）
}

// ─── 关联网络 ─────────────────────────────────────────

export type LinkType =
    | 'temporal'    // 时间关联 — 24h 内创建的记忆
    | 'emotional'   // 情感关联 — 相同情绪标签
    | 'causal'      // 因果关联
    | 'person'      // 人物关联 — 提到同一人
    | 'metaphor';   // 隐喻关联

export interface MemoryLink {
    id: string;
    sourceId: string;           // MemoryNode.id
    targetId: string;           // MemoryNode.id
    type: LinkType;
    strength: number;           // 0–1，共同激活时 +0.05
}

// ─── 事件盒 (EventBox) ─────────────────────────────────

/**
 * EventBox —— 把同一件事的多条记忆绑在一起。
 *
 * 创建方式：
 * - LLM 在提取新记忆时，通过 relatedTo 指向旧记忆 → 自动建盒/加盒/合并
 * - 用户在 UI 里手动"+ 添加关联"
 *
 * 召回方式：命中盒内任一"活"节点 → 整盒（summary + 所有活节点）一起出，算 1 个名额
 *
 * 压缩：活节点达到 COMPRESSION_THRESHOLD (4) 条 →
 * LLM 把"旧 summary? + 新活节点"整合成一个新 summary MemoryNode，
 * 原活节点全部 archived=true 不再参与召回，box.compressionCount++
 */
export interface EventBox {
    id: string;                     // eb_xxx
    charId: string;
    name: string;                   // 盒名（LLM 生成，首次创建时给）
    tags: string[];                 // 详细 tag，便于搜索（LLM 生成）
    summaryNodeId: string | null;   // 压缩总结节点的 MemoryNode.id；null = 未压缩过
    liveMemoryIds: string[];        // 活节点：参与召回的原始记忆
    archivedMemoryIds: string[];    // 灰节点：已被压入 summary，不参与召回（可复活）
    compressionCount: number;       // 压缩过几次
    createdAt: number;
    updatedAt: number;
    lastCompressedAt: number | null;
    /** 是否已封盒。封盒后不再接收新成员，新相关记忆会另建一个盒。召回仍正常。 */
    sealed?: boolean;
    /** 封盒后若有新相关记忆，新建盒会把旧盒 id 记在这里供追溯（非召回路径使用）。 */
    predecessorBoxId?: string | null;
}

/** 活节点达到此条数时触发压缩 */
export const EVENT_BOX_COMPRESSION_THRESHOLD = 4;

/** 活节点数硬上限：binding 时如果当前开盒已达此数，视作满员，另开新盒
 *  （带 predecessorBoxId）。防御屏障：LLM 压缩连续失败不会让单盒无限膨胀
 *  到 40+ 条活节点，后果是整盒再也压不动（token 爆、UI 卡）。
 *  比 COMPRESSION_THRESHOLD 大很多是为了给正常的"多批次待压缩"留出缓冲。 */
export const EVENT_BOX_LIVE_HARD_CAP = 15;

/** 盒内事件总数（archived + live）达到此值后封盒，之后的相关记忆另开新盒 */
export const EVENT_BOX_SEAL_THRESHOLD = 12;

/** summary 目标字数区间 + 二次精简触发线。HARD_MAX 名称为兼容现有引用保留，
 *  不再是截断线：精简失败或仍超长时完整保存，召回读取全文。 */
export const EVENT_BOX_SUMMARY_TARGET_MIN_CHARS = 400;
export const EVENT_BOX_SUMMARY_TARGET_MAX_CHARS = 700;
export const EVENT_BOX_SUMMARY_HARD_MAX_CHARS = 900;

// ─── 旧话题盒（已废弃，代码路径已摘除，类型保留以兼容残留数据读取） ──

/** @deprecated */
export type BoxStatus = 'open' | 'sealed';

/** @deprecated 旧 TopicLoom 话题盒，已由 EventBox 替代 */
export interface TopicBox {
    id: string;
    charId: string;
    messageIds: number[];
    status: BoxStatus;
    topic: string;
    events: string[];
    keywords: string[];
    createdAt: number;
    sealedAt: number | null;
}

/** @deprecated */
export type TopicContinuity = 'continuous' | 'partial_shift' | 'discontinuous';

// ─── 房间门牌（Room Plate — 情景→语义的固化终点） ──────

/**
 * 门牌：每个房间头上那层常驻的"蒸馏物"。
 *
 * 房间装的是情景记忆（一条条带时间戳的事件），门牌写的是这些经历沉淀出的
 * 认知——不走向量召回、不衰减、每轮常驻注入 System Prompt。
 * 对应人脑里"海马体情景记忆固化为新皮质语义知识"的那一步。
 *
 * 四个房间有门牌：
 * - user_room「TA的事」  — 用户的稳定事实（家庭、居住、重要他人、雷区）
 * - self_room「我是谁」  — 角色对自己的稳定认知
 * - bedroom  「我们之间」— 关系的质地。硬规则：只描述现象，禁止给关系命名
 * - study    「我的领域」— 会什么、在学什么
 *
 * 客厅天生短暂不配门牌；阁楼/窗台已有各自的生命周期机制（本质上就是它们的门牌）。
 *
 * 更新时机：
 * - EventBox 压缩/封盒时 → 本盒所属房间的门牌做一次增量合并
 * - 认知消化（50轮）时  → 四块门牌做一次全量整理
 *
 * 条目是"合并语义"而非"追加语义"：事实会变（搬家、换工作、和某人和好），
 * 每次 LLM 整理输出的是完整的新条目列表，旧条目不被重新输出即被淘汰——
 * 硬容量上限让不重要/过时的条目在合并时被自然挤出（gist 记忆的容量压力）。
 */

export type PlateRoom = 'user_room' | 'self_room' | 'bedroom' | 'study';

export const PLATE_ROOMS: PlateRoom[] = ['user_room', 'self_room', 'bedroom', 'study'];

export interface PlateEntry {
    id: string;             // pe_xxx
    text: string;           // 梗概条目，目标 ≤ PLATE_ENTRY_TARGET_CHARS 字
    firstLearnedAt: number; // 首次蒸馏出这条认知的时间（"你是第三个月才跟我说家里的事"）
    updatedAt: number;      // 最近一次被合并/改写的时间
    sourceCount: number;    // 被印证的次数（提过一次 vs 反复出现）
    /** 2-4 字分类标签（家庭/居住/重要他人/工作/雷区/习惯…），LLM 整理时给出，UI 渲染 chip 与图标 */
    tag?: string;
}

export interface RoomPlate {
    id: string;             // `${charId}:${room}`
    charId: string;
    room: PlateRoom;
    entries: PlateEntry[];
    updatedAt: number;
    version: number;        // 每次合并 +1
}

/** 每块门牌的条目硬上限（容量压力 = 天然的边界纠错器） */
export const PLATE_ENTRY_CAPS: Record<PlateRoom, number> = {
    user_room: 12,
    self_room: 10,
    bedroom:   10,
    study:     8,
};

/** 单条目标字数（prompt 引导）与硬上限（超出截断兜底） */
export const PLATE_ENTRY_TARGET_CHARS = 50;
export const PLATE_ENTRY_HARD_MAX_CHARS = 90;

export const PLATE_TITLES: Record<PlateRoom, string> = {
    user_room: 'TA的事',
    self_room: '我是谁',
    bedroom:   '我们之间',
    study:     '我的领域',
};

// ─── 消化日志（DigestReport — 认知消化的可回看记录） ───

/**
 * 每次认知消化落一条报告，回答"这次到底消化了什么"：
 * 审视了哪些材料 → 状态机改了什么 → 往门牌提交了什么 → 门牌实际更新了哪几块。
 * 通用 section 结构让 UI 保持傻瓜渲染；每角色只保留最近 DIGEST_REPORT_KEEP 条。
 */
export interface DigestReportSection {
    label: string;      // 如「阁楼困惑」「化解」「提交给门牌·TA的事」
    items: string[];    // 内容预览（已截断）
}

export interface DigestReport {
    id: string;                         // dr_xxx
    charId: string;
    createdAt: number;
    trigger: 'auto' | 'manual';
    examined: DigestReportSection[];    // 本次审视的材料
    outcomes: DigestReportSection[];    // 状态机结果（化解/加深/淡忘/实现/落空/新困惑）
    plateSubmissions: DigestReportSection[]; // 提交给门牌的蒸馏候选
    plateUpdated: string[];             // 门牌实际更新的房间（PlateRoom）
    /**
     * 这次的门牌整理交给云端跑了，结果还在路上（几分钟后落地）。
     * 缺字段 = 这条日志是这个标记出现之前记的，当 false 看。
     */
    plateCloudPending?: boolean;
}

/** 每角色保留的消化报告条数上限 */
export const DIGEST_REPORT_KEEP = 30;

// ─── 期盼（窗台） ─────────────────────────────────────

export type AnticipationStatus = 'active' | 'anchor' | 'fulfilled' | 'disappointed';

export interface Anticipation {
    id: string;
    charId: string;
    content: string;
    status: AnticipationStatus;
    createdAt: number;
    anchoredAt: number | null;  // active → anchor 的时间
    resolvedAt: number | null;  // fulfilled / disappointed 的时间
}

// ─── 处理批次日志 ─────────────────────────────────────

export interface MemoryBatch {
    id: string;
    charId: string;
    boxId: string;
    status: 'pending' | 'processing' | 'done' | 'error';
    nodesCreated: number;
    error: string | null;
    createdAt: number;
    completedAt: number | null;
}

// ─── 人格风格（影响扩散激活权重） ─────────────────────

export type PersonalityStyle = 'emotional' | 'narrative' | 'imagery' | 'analytical';

/** 每种人格风格对五种关联类型的权重 */
export const PERSONALITY_WEIGHTS: Record<PersonalityStyle, Record<LinkType, number>> = {
    emotional:  { emotional: 1.0, person: 0.6, metaphor: 0.5, temporal: 0.3, causal: 0.2 },
    narrative:  { temporal: 1.0, person: 0.8, causal: 0.4, emotional: 0.3, metaphor: 0.2 },
    imagery:    { metaphor: 1.0, emotional: 0.5, temporal: 0.3, person: 0.3, causal: 0.2 },
    analytical: { causal: 1.0, temporal: 0.4, person: 0.3, emotional: 0.2, metaphor: 0.2 },
};

// ─── Embedding 配置（独立于聊天 API） ─────────────────

export interface EmbeddingConfig {
    baseUrl: string;            // OpenAI 兼容端点，如 https://api.siliconflow.cn/v1
    apiKey: string;
    model: string;              // 默认 text-embedding-3-small
    dimensions: number;         // 默认 1024
}

// ─── 远程向量存储配置 (Supabase pgvector) ────────────

export interface RemoteVectorConfig {
    enabled: boolean;
    supabaseUrl: string;        // e.g. https://xxxxx.supabase.co
    supabaseAnonKey: string;    // anon / public key
    initialized: boolean;       // 是否已建表
}

// ─── 检索结果 ─────────────────────────────────────────

export interface ScoredMemory {
    node: MemoryNode;
    finalScore: number;
    similarity: number;         // 向量余弦相似度
    bm25Score: number;          // BM25 分数
    roomScore: number;          // 房间评分后的最终分
    /** 精确信号的硬保底；formatter 会在普通分数排序前优先保留。 */
    recallGuarantee?: 'explicit_entity';
}
