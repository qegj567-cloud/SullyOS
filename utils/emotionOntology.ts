/**
 * 情绪本体 (Emotion Ontology)
 *
 * 30 个基础情绪 + 中文同义词表 + 模糊映射函数
 * 杏仁核自由输出 → 本地映射层保证下游一致性
 */

// ── Types ──

export interface EmotionOntologyEntry {
    id: string;
    category: 'positive' | 'negative' | 'neutral' | 'complex';
    labels: {
        zh: string[];
        en: string[];
    };
    defaultValence: number;   // -1 ~ 1
    defaultArousal: number;   // 0 ~ 1
    decayConfig: {
        rate: number;
        function: 'exponential' | 'logarithmic' | 'plateau';
        plateauHours?: number;
    };
    relatedEmotions: string[];
}

export interface OntologyMapping {
    ontologyId: string;
    nuance: string;
    confidence: number;
}

// ── Ontology Data ──

export const EMOTION_ONTOLOGY: EmotionOntologyEntry[] = [
    // ── 正面情绪 (10) ──
    {
        id: 'joy',
        category: 'positive',
        labels: {
            zh: ['开心', '高兴', '愉快', '快乐', '满足', '欣喜', '愉悦', '舒心', '畅快', '乐', '美滋滋', '喜悦', '欢喜'],
            en: ['happy', 'joyful', 'pleased', 'delighted', 'content', 'cheerful'],
        },
        defaultValence: 0.8,
        defaultArousal: 0.6,
        decayConfig: { rate: 0.15, function: 'exponential' },
        relatedEmotions: ['excitement', 'gratitude', 'love'],
    },
    {
        id: 'love',
        category: 'positive',
        labels: {
            zh: ['爱', '喜欢', '心动', '温柔', '在意', '宠溺', '深情', '爱意', '眷恋', '钟情', '疼爱', '偏爱', '情不自禁'],
            en: ['love', 'affection', 'adore', 'fond', 'devoted', 'cherish'],
        },
        defaultValence: 0.9,
        defaultArousal: 0.5,
        decayConfig: { rate: 0.05, function: 'logarithmic' },
        relatedEmotions: ['tenderness', 'trust', 'protectiveness'],
    },
    {
        id: 'gratitude',
        category: 'positive',
        labels: {
            zh: ['感激', '感动', '感恩', '暖心', '被打动', '谢谢', '感谢', '暖暖的', '感慨'],
            en: ['grateful', 'thankful', 'touched', 'moved', 'appreciative'],
        },
        defaultValence: 0.7,
        defaultArousal: 0.4,
        decayConfig: { rate: 0.08, function: 'logarithmic' },
        relatedEmotions: ['joy', 'love', 'tenderness'],
    },
    {
        id: 'pride',
        category: 'positive',
        labels: {
            zh: ['骄傲', '自豪', '得意', '有成就感', '扬眉吐气', '光荣', '志得意满'],
            en: ['proud', 'accomplished', 'triumphant'],
        },
        defaultValence: 0.7,
        defaultArousal: 0.6,
        decayConfig: { rate: 0.12, function: 'exponential' },
        relatedEmotions: ['joy', 'excitement'],
    },
    {
        id: 'excitement',
        category: 'positive',
        labels: {
            zh: ['兴奋', '激动', '期待', '跃跃欲试', '迫不及待', '热血沸腾', '按捺不住', '小激动'],
            en: ['excited', 'thrilled', 'eager', 'enthusiastic'],
        },
        defaultValence: 0.7,
        defaultArousal: 0.9,
        decayConfig: { rate: 0.2, function: 'exponential' },
        relatedEmotions: ['joy', 'anticipation', 'curiosity'],
    },
    {
        id: 'relief',
        category: 'positive',
        labels: {
            zh: ['安心', '放心', '如释重负', '松了口气', '放下心来', '终于', '心里的石头落地'],
            en: ['relieved', 'reassured', 'comforted'],
        },
        defaultValence: 0.5,
        defaultArousal: 0.2,
        decayConfig: { rate: 0.18, function: 'exponential' },
        relatedEmotions: ['calm', 'joy'],
    },
    {
        id: 'tenderness',
        category: 'positive',
        labels: {
            zh: ['心疼', '心软', '怜惜', '不舍', '舍不得', '温情', '柔软', '恻隐'],
            en: ['tender', 'gentle', 'compassionate', 'soft-hearted'],
        },
        defaultValence: 0.6,
        defaultArousal: 0.3,
        decayConfig: { rate: 0.06, function: 'logarithmic' },
        relatedEmotions: ['love', 'protectiveness', 'vulnerability'],
    },
    {
        id: 'trust',
        category: 'positive',
        labels: {
            zh: ['信任', '依赖', '安全感', '踏实', '放心', '信赖', '托付', '交给你'],
            en: ['trust', 'reliance', 'secure', 'faith'],
        },
        defaultValence: 0.6,
        defaultArousal: 0.2,
        decayConfig: { rate: 0.03, function: 'plateau', plateauHours: 24 },
        relatedEmotions: ['love', 'calm', 'relief'],
    },
    // ── 负面情绪 (12) ──
    {
        id: 'sadness',
        category: 'negative',
        labels: {
            zh: ['难过', '伤心', '低落', '失落', '沮丧', '消沉', '心酸', '委屈', '想哭', '难受', '不开心', '郁闷', '黯然'],
            en: ['sad', 'upset', 'down', 'heartbroken', 'unhappy', 'gloomy'],
        },
        defaultValence: -0.7,
        defaultArousal: 0.3,
        decayConfig: { rate: 0.06, function: 'logarithmic' },
        relatedEmotions: ['grief', 'loneliness', 'helplessness'],
    },
    {
        id: 'anxiety',
        category: 'negative',
        labels: {
            zh: ['焦虑', '不安', '担忧', '忐忑', '紧张', '慌', '心慌', '七上八下', '坐立不安', '惶恐', '忧虑', '患得患失', '提心吊胆'],
            en: ['anxious', 'worried', 'nervous', 'uneasy', 'apprehensive'],
        },
        defaultValence: -0.5,
        defaultArousal: 0.7,
        decayConfig: { rate: 0.08, function: 'logarithmic' },
        relatedEmotions: ['fear', 'worry', 'helplessness'],
    },
    {
        id: 'anger',
        category: 'negative',
        labels: {
            zh: ['愤怒', '生气', '烦躁', '恼怒', '不满', '火大', '气死了', '怒', '暴躁', '窝火', '来气', '不爽'],
            en: ['angry', 'furious', 'irritated', 'mad', 'annoyed', 'enraged'],
        },
        defaultValence: -0.8,
        defaultArousal: 0.9,
        decayConfig: { rate: 0.12, function: 'exponential' },
        relatedEmotions: ['frustration', 'resentment'],
    },
    {
        id: 'fear',
        category: 'negative',
        labels: {
            zh: ['害怕', '恐惧', '惊慌', '胆怯', '惧怕', '发抖', '心惊', '战栗', '毛骨悚然'],
            en: ['afraid', 'scared', 'terrified', 'frightened', 'fearful'],
        },
        defaultValence: -0.8,
        defaultArousal: 0.8,
        decayConfig: { rate: 0.1, function: 'exponential' },
        relatedEmotions: ['anxiety', 'helplessness'],
    },
    {
        id: 'guilt',
        category: 'negative',
        labels: {
            zh: ['内疚', '自责', '愧疚', '过意不去', '对不起', '抱歉', '惭愧', '悔恨'],
            en: ['guilty', 'remorseful', 'regretful', 'sorry'],
        },
        defaultValence: -0.6,
        defaultArousal: 0.4,
        decayConfig: { rate: 0.05, function: 'logarithmic' },
        relatedEmotions: ['shame', 'sadness', 'anxiety'],
    },
    {
        id: 'shame',
        category: 'negative',
        labels: {
            zh: ['羞耻', '丢脸', '难为情', '尴尬', '不好意思', '害臊', '无地自容', '脸红'],
            en: ['ashamed', 'embarrassed', 'humiliated', 'mortified'],
        },
        defaultValence: -0.7,
        defaultArousal: 0.5,
        decayConfig: { rate: 0.1, function: 'exponential' },
        relatedEmotions: ['guilt', 'vulnerability'],
    },
    {
        id: 'jealousy',
        category: 'negative',
        labels: {
            zh: ['嫉妒', '吃醋', '酸', '不甘心', '嫉恨', '眼红', '羡慕嫉妒恨', '酸溜溜'],
            en: ['jealous', 'envious', 'covetous'],
        },
        defaultValence: -0.6,
        defaultArousal: 0.6,
        decayConfig: { rate: 0.1, function: 'exponential' },
        relatedEmotions: ['anger', 'sadness', 'resentment'],
    },
    {
        id: 'loneliness',
        category: 'negative',
        labels: {
            zh: ['孤独', '寂寞', '落单', '被冷落', '孤单', '一个人', '没人陪', '形单影只', '被遗忘'],
            en: ['lonely', 'isolated', 'abandoned', 'forsaken'],
        },
        defaultValence: -0.6,
        defaultArousal: 0.3,
        decayConfig: { rate: 0.04, function: 'plateau', plateauHours: 12 },
        relatedEmotions: ['sadness', 'vulnerability'],
    },
    {
        id: 'grief',
        category: 'negative',
        labels: {
            zh: ['悲痛', '哀伤', '丧失感', '心碎', '痛彻心扉', '哀恸', '肝肠寸断', '泣不成声'],
            en: ['grief', 'mourning', 'devastated', 'heartbroken'],
        },
        defaultValence: -0.9,
        defaultArousal: 0.4,
        decayConfig: { rate: 0.02, function: 'plateau', plateauHours: 48 },
        relatedEmotions: ['sadness', 'loneliness', 'helplessness'],
    },
    {
        id: 'frustration',
        category: 'negative',
        labels: {
            zh: ['受挫', '无力', '沮丧', '泄气', '挫败', '白费力气', '心有余而力不足'],
            en: ['frustrated', 'defeated', 'discouraged', 'exasperated'],
        },
        defaultValence: -0.5,
        defaultArousal: 0.6,
        decayConfig: { rate: 0.12, function: 'exponential' },
        relatedEmotions: ['anger', 'helplessness', 'sadness'],
    },
    {
        id: 'resentment',
        category: 'negative',
        labels: {
            zh: ['怨恨', '不甘', '记恨', '耿耿于怀', '愤愤不平', '意难平', '咽不下这口气'],
            en: ['resentful', 'bitter', 'grudging', 'indignant'],
        },
        defaultValence: -0.7,
        defaultArousal: 0.5,
        decayConfig: { rate: 0.04, function: 'logarithmic' },
        relatedEmotions: ['anger', 'jealousy', 'sadness'],
    },
    {
        id: 'helplessness',
        category: 'negative',
        labels: {
            zh: ['无助', '无能为力', '束手无策', '绝望', '走投无路', '手足无措'],
            en: ['helpless', 'powerless', 'hopeless', 'desperate'],
        },
        defaultValence: -0.8,
        defaultArousal: 0.3,
        decayConfig: { rate: 0.05, function: 'logarithmic' },
        relatedEmotions: ['sadness', 'fear', 'frustration'],
    },
    // ── 复杂情绪 (6) ──
    {
        id: 'nostalgia',
        category: 'complex',
        labels: {
            zh: ['怀念', '想念', '留恋', '追忆', '思念', '念旧', '故人', '物是人非', '旧时光'],
            en: ['nostalgic', 'longing', 'wistful', 'yearning'],
        },
        defaultValence: 0.1,
        defaultArousal: 0.3,
        decayConfig: { rate: 0.04, function: 'logarithmic' },
        relatedEmotions: ['sadness', 'love', 'bittersweet'],
    },
    {
        id: 'bittersweet',
        category: 'complex',
        labels: {
            zh: ['苦涩', '五味杂陈', '又甜又痛', '百感交集', '悲喜交加', '哭笑不得', '又酸又甜'],
            en: ['bittersweet', 'mixed feelings', 'poignant'],
        },
        defaultValence: 0.0,
        defaultArousal: 0.4,
        decayConfig: { rate: 0.06, function: 'logarithmic' },
        relatedEmotions: ['nostalgia', 'joy', 'sadness'],
    },
    {
        id: 'ambivalence',
        category: 'complex',
        labels: {
            zh: ['纠结', '矛盾', '犹豫', '两难', '进退两难', '举棋不定', '左右为难', '拿不定主意'],
            en: ['ambivalent', 'torn', 'conflicted', 'indecisive'],
        },
        defaultValence: -0.1,
        defaultArousal: 0.5,
        decayConfig: { rate: 0.1, function: 'exponential' },
        relatedEmotions: ['anxiety', 'confusion'],
    },
    {
        id: 'protectiveness',
        category: 'complex',
        labels: {
            zh: ['保护欲', '想守护', '担心对方', '护着', '不许欺负', '放不下心', '看不得你受委屈'],
            en: ['protective', 'guarding', 'shielding', 'watchful'],
        },
        defaultValence: 0.4,
        defaultArousal: 0.5,
        decayConfig: { rate: 0.05, function: 'logarithmic' },
        relatedEmotions: ['love', 'tenderness', 'anxiety'],
    },
    {
        id: 'vulnerability',
        category: 'complex',
        labels: {
            zh: ['脆弱', '袒露', '打开心防', '柔软', '不设防', '卸下伪装', '示弱', '敞开心扉'],
            en: ['vulnerable', 'exposed', 'open', 'defenseless'],
        },
        defaultValence: -0.1,
        defaultArousal: 0.4,
        decayConfig: { rate: 0.06, function: 'logarithmic' },
        relatedEmotions: ['trust', 'fear', 'tenderness'],
    },
    {
        id: 'curiosity',
        category: 'complex',
        labels: {
            zh: ['好奇', '想了解', '追问欲', '求知', '探究', '有意思', '想知道', '感兴趣'],
            en: ['curious', 'intrigued', 'inquisitive', 'interested'],
        },
        defaultValence: 0.3,
        defaultArousal: 0.6,
        decayConfig: { rate: 0.15, function: 'exponential' },
        relatedEmotions: ['excitement', 'surprise'],
    },
    // ── 中性情绪 (4) ──
    {
        id: 'surprise',
        category: 'neutral',
        labels: {
            zh: ['惊讶', '意外', '没想到', '震惊', '吓一跳', '出乎意料', '大吃一惊', '万万没想到'],
            en: ['surprised', 'astonished', 'shocked', 'stunned'],
        },
        defaultValence: 0.0,
        defaultArousal: 0.8,
        decayConfig: { rate: 0.25, function: 'exponential' },
        relatedEmotions: ['curiosity', 'fear', 'joy'],
    },
    {
        id: 'confusion',
        category: 'neutral',
        labels: {
            zh: ['困惑', '不解', '迷茫', '搞不懂', '一头雾水', '摸不着头脑', '疑惑', '懵'],
            en: ['confused', 'puzzled', 'bewildered', 'perplexed'],
        },
        defaultValence: -0.1,
        defaultArousal: 0.4,
        decayConfig: { rate: 0.15, function: 'exponential' },
        relatedEmotions: ['curiosity', 'anxiety', 'frustration'],
    },
    {
        id: 'calm',
        category: 'neutral',
        labels: {
            zh: ['平静', '淡然', '安宁', '从容', '宁静', '波澜不惊', '心如止水', '泰然', '自在'],
            en: ['calm', 'peaceful', 'serene', 'tranquil', 'composed'],
        },
        defaultValence: 0.3,
        defaultArousal: 0.1,
        decayConfig: { rate: 0.03, function: 'plateau', plateauHours: 8 },
        relatedEmotions: ['relief', 'trust'],
    },
    {
        id: 'contemplation',
        category: 'neutral',
        labels: {
            zh: ['沉思', '思考', '回味', '反刍', '琢磨', '若有所思', '深思', '发呆', '出神'],
            en: ['contemplative', 'pensive', 'reflective', 'thoughtful'],
        },
        defaultValence: 0.0,
        defaultArousal: 0.3,
        decayConfig: { rate: 0.1, function: 'exponential' },
        relatedEmotions: ['curiosity', 'nostalgia', 'calm'],
    },
];

// ── Index for fast lookup ──

const _ontologyById = new Map<string, EmotionOntologyEntry>();
const _keywordIndex: { keyword: string; ontologyId: string; weight: number }[] = [];

function _buildIndices() {
    if (_ontologyById.size > 0) return; // already built

    for (const entry of EMOTION_ONTOLOGY) {
        _ontologyById.set(entry.id, entry);

        // Index all zh labels with decreasing weight by position
        for (let i = 0; i < entry.labels.zh.length; i++) {
            const label = entry.labels.zh[i];
            _keywordIndex.push({
                keyword: label,
                ontologyId: entry.id,
                weight: 1.0 - i * 0.02, // first label = strongest match
            });
        }
        // Index en labels at lower weight
        for (const label of entry.labels.en) {
            _keywordIndex.push({
                keyword: label.toLowerCase(),
                ontologyId: entry.id,
                weight: 0.7,
            });
        }
    }

    // Sort keywords by length descending so longer matches are tried first
    _keywordIndex.sort((a, b) => b.keyword.length - a.keyword.length);
}

// ── Public API ──

/**
 * 将自由文本情绪描述映射到 ontology ID
 *
 * 示例：
 *   mapToOntology('隐隐的焦虑') → { ontologyId: 'anxiety', nuance: '隐隐的', confidence: 0.9 }
 *   mapToOntology('说不清的不舒服') → { ontologyId: 'anxiety', nuance: '说不清的不舒服', confidence: 0.5 }
 */
export function mapToOntology(freeText: string): OntologyMapping | null {
    _buildIndices();

    const text = freeText.trim().toLowerCase();
    if (!text) return null;

    let bestMatch: { ontologyId: string; keyword: string; weight: number } | null = null;

    for (const entry of _keywordIndex) {
        if (text.includes(entry.keyword)) {
            if (!bestMatch || entry.weight > bestMatch.weight ||
                (entry.weight === bestMatch.weight && entry.keyword.length > bestMatch.keyword.length)) {
                bestMatch = entry;
            }
        }
    }

    if (!bestMatch) return null;

    // Extract nuance: the part of the text that isn't the matched keyword
    const nuance = text.replace(bestMatch.keyword, '').trim()
        .replace(/^[的地得了着过]/, '').trim();

    // Confidence: full match = high, substring match = moderate
    const ratio = bestMatch.keyword.length / text.length;
    const confidence = Math.min(0.95, bestMatch.weight * (0.5 + 0.5 * ratio));

    return {
        ontologyId: bestMatch.ontologyId,
        nuance: nuance || '',
        confidence: Math.round(confidence * 100) / 100,
    };
}

/**
 * 批量扫描文本中的情绪关键词，返回命中列表
 * 用于感知层的快速情绪预检
 */
export function scanEmotionKeywords(text: string): { ontologyId: string; keyword: string }[] {
    _buildIndices();

    const hits: { ontologyId: string; keyword: string }[] = [];
    const seen = new Set<string>();

    for (const entry of _keywordIndex) {
        if (text.includes(entry.keyword) && !seen.has(entry.ontologyId)) {
            hits.push({ ontologyId: entry.ontologyId, keyword: entry.keyword });
            seen.add(entry.ontologyId);
        }
    }

    return hits;
}

/**
 * 根据 ontology ID 获取完整条目
 */
export function getOntologyEntry(id: string): EmotionOntologyEntry | undefined {
    _buildIndices();
    return _ontologyById.get(id);
}

/**
 * 获取所有 ontology 条目（用于 UI 展示）
 */
export function getAllOntologyEntries(): EmotionOntologyEntry[] {
    return EMOTION_ONTOLOGY;
}

/**
 * 获取某个情绪的主中文标签（第一个）
 */
export function getPrimaryLabel(ontologyId: string): string {
    const entry = getOntologyEntry(ontologyId);
    return entry?.labels.zh[0] ?? ontologyId;
}
