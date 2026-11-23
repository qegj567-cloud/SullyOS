import type {
    MountedWorldbook,
    Worldbook,
    WorldbookDepthRole,
    WorldbookPosition,
    WorldbookSelectiveLogic,
} from '../types';

export type WorldbookLike = Worldbook | MountedWorldbook;

export interface WorldbookScanMessage {
    role?: string;
    content: unknown;
}

export interface ResolvedWorldbookEntry {
    book: WorldbookLike;
    content: string;
    position: WorldbookPosition;
    order: number;
}

export interface WorldbookSystemSections {
    beforeCharacter: ResolvedWorldbookEntry[];
    afterCharacter: ResolvedWorldbookEntry[];
    authorsNoteTop: ResolvedWorldbookEntry[];
    authorsNoteBottom: ResolvedWorldbookEntry[];
    atDepth: ResolvedWorldbookEntry[];
    beforeExamples: ResolvedWorldbookEntry[];
    afterExamples: ResolvedWorldbookEntry[];
}

export const WORLDBOOK_POSITION_LABELS: Record<WorldbookPosition, string> = {
    0: '角色设定前',
    1: '角色设定后',
    2: '作者注释顶部',
    3: '作者注释底部',
    4: '聊天记录指定深度',
    5: '示例消息前',
    6: '示例消息后',
};

export const WORLDBOOK_POSITION_DESCRIPTIONS: Record<WorldbookPosition, string> = {
    0: '适合放全局规则、基础背景；会出现在角色身份与性格设定之前。',
    1: '适合一般世界观、人物与地点设定；这是旧版世界书一直使用的默认位置。',
    2: '适合放写作方向、语气或节奏要求；位于作者注释内容顶部。',
    3: '适合放作者注释后的补充与强调；比顶部内容更靠后。',
    4: '适合临时状态、近期事件或强提醒；按深度和角色插入聊天记录。',
    5: '适合放阅读示例对话前需要先知道的说明。',
    6: '适合放示例对话结束后的补充说明。',
};

export const WORLDBOOK_ROLE_LABELS: Record<WorldbookDepthRole, string> = {
    0: 'System',
    1: 'User',
    2: 'Assistant',
};

const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

const asStringArray = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item).trim()).filter(Boolean);
};

export const splitWorldbookKeywords = (value: string): string[] => (
    value.split(/[,，\n]/).map(item => item.trim()).filter(Boolean)
);

export const toMountedWorldbook = (book: Worldbook): MountedWorldbook => ({
    id: book.id,
    title: book.title,
    content: book.content,
    category: book.category,
    key: book.key ? [...book.key] : undefined,
    keysecondary: book.keysecondary ? [...book.keysecondary] : undefined,
    constant: book.constant,
    selective: book.selective,
    selectiveLogic: book.selectiveLogic,
    order: book.order,
    position: book.position,
    disable: book.disable,
    probability: book.probability,
    useProbability: book.useProbability,
    depth: book.depth,
    role: book.role,
    scanDepth: book.scanDepth,
    caseSensitive: book.caseSensitive,
    matchWholeWords: book.matchWholeWords,
    sourceUid: book.sourceUid,
});

/**
 * Install a complete worldbook group into one character cache. Existing entries
 * with the same ids are replaced, so retrying an install cannot create duplicates.
 */
export const upsertMountedWorldbooks = (
    current: MountedWorldbook[] = [],
    books: Worldbook[] = [],
): MountedWorldbook[] => {
    const incomingIds = new Set(books.map(book => book.id));
    return [
        ...current.filter(book => !incomingIds.has(book.id)),
        ...books.map(toMountedWorldbook),
    ];
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const keywordMatches = (
    text: string,
    keyword: string,
    caseSensitive: boolean,
    wholeWords: boolean,
): boolean => {
    if (!keyword) return false;
    if (!wholeWords) {
        return caseSensitive
            ? text.includes(keyword)
            : text.toLocaleLowerCase().includes(keyword.toLocaleLowerCase());
    }
    const flags = caseSensitive ? 'u' : 'iu';
    const escaped = escapeRegExp(keyword);
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, flags).test(text);
};

const messageText = (message: WorldbookScanMessage): string => {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        return message.content
            .map(part => (typeof part === 'string' ? part : (part as any)?.text || ''))
            .filter(Boolean)
            .join('\n');
    }
    return '';
};

const scanTextForBook = (book: WorldbookLike, messages: WorldbookScanMessage[]): string => {
    const depth = Math.max(0, Math.floor(book.scanDepth ?? 4));
    if (depth === 0) return '';
    return messages.slice(-depth).map(messageText).filter(Boolean).join('\n');
};

const secondaryConditionPasses = (
    book: WorldbookLike,
    text: string,
    caseSensitive: boolean,
    wholeWords: boolean,
): boolean => {
    if (!book.selective) return true;
    const secondary = book.keysecondary || [];
    if (secondary.length === 0) return true;
    const matches = secondary.map(key => keywordMatches(text, key, caseSensitive, wholeWords));
    const logic: WorldbookSelectiveLogic = book.selectiveLogic ?? 0;
    if (logic === 1) return !matches.every(Boolean);
    if (logic === 2) return !matches.some(Boolean);
    if (logic === 3) return matches.every(Boolean);
    return matches.some(Boolean);
};

export const isWorldbookEntryActive = (
    book: WorldbookLike,
    messages: WorldbookScanMessage[] = [],
): boolean => {
    if (book.disable) return false;

    const primary = book.key || [];
    const isConstant = book.constant ?? primary.length === 0;
    const text = scanTextForBook(book, messages);
    const caseSensitive = book.caseSensitive === true;
    const wholeWords = book.matchWholeWords === true;

    if (!isConstant) {
        if (primary.length === 0) return false;
        if (!primary.some(key => keywordMatches(text, key, caseSensitive, wholeWords))) return false;
        if (!secondaryConditionPasses(book, text, caseSensitive, wholeWords)) return false;
    }

    // 打包给云端的条目这一次不抽，到点由 worker 用同一个 rollWorldbookProbability 抽。
    if (book.useProbability && !deferredRollBooks.has(book)
        && !rollWorldbookProbability(clamp(book.probability, 0, 100, 100))) return false;

    return true;
};

/**
 * 按概率触发的世界书条目抽一次签（概率按 0–100）。本地每轮构建上下文时抽，云端定时类
 * 每次到点由 worker 抽（renderWorldbookRolls），两边用这同一个函数。
 * 这份文件只依赖类型，会被打进 worker bundle。
 */
export const rollWorldbookProbability = (probability: number, random: () => number = Math.random): boolean => {
    if (probability <= 0) return false;
    if (probability >= 100) return true;
    return random() * 100 < probability;
};

// ─── 云端定时类：打包时推迟抽签 ───
// fire_pack 的模板在最后一次聊天时打好、到点才渲染。概率条目要是在打包时抽一次签，到下次
// 重新打包前每次到点都是同一个结果；本地却是每轮都重抽。所以打包时概率条目一律按「抽中」
// 渲染，外面包上占位标记，概率随 fire_pack 带上（worldbookRolls），worker 到点逐条现抽，
// 没抽中的连同标记一起去掉。整段 / 同一分类都只剩没抽中的条目时，标题行跟着消失，
// 与本地那一轮没有这些条目时的渲染逐字一致。

/** 被推迟抽签的条目副本（按对象身份认，不往条目上加字段）。 */
const deferredRollBooks = new WeakSet<object>();

const ROLL_CLOSE = '{{/AMSG_WB_IF}}';
// 含推迟条目的段里，段标题和分类标题各打一个记号：中间的条目没抽中时，前后两个同名分类
// 标题会挨在一起，渲染时按本地「分类变了才写标题」的规则合并掉。
const ROLL_SECTION = '{{AMSG_WB_SEC}}';
const ROLL_CATEGORY = '{{AMSG_WB_CAT}}';
const ROLL_HEADER_RE = /\{\{AMSG_WB_SEC\}\}|\{\{AMSG_WB_CAT\}\}(#### \[[^\n]*\]\n)/g;
const rollOpen = (ids: string[]) => `{{AMSG_WB_IF:${ids.map(encodeURIComponent).join(',')}}}`;
const ROLL_BLOCK_RE = /\{\{AMSG_WB_IF:([^}]*)\}\}((?:(?!\{\{AMSG_WB_IF:)[\s\S])*?)\{\{\/AMSG_WB_IF\}\}/;

/** fire_pack 里随包带上的一条概率条目。 */
export interface WorldbookRoll {
    id: string;
    probability: number;
}

/** 打包用：返回一份条目副本，概率在 0–100 之间（不含两端）的条目这一次不抽签、渲染时包上标记。 */
export const deferWorldbookRolls = <T extends WorldbookLike>(books: T[] = []): T[] => books.map(book => {
    if (!book.useProbability) return book;
    const probability = clamp(book.probability, 0, 100, 100);
    if (probability <= 0 || probability >= 100) return book;
    const copy = { ...book };
    deferredRollBooks.add(copy);
    return copy;
});

/** deferWorldbookRolls 推迟过的条目及其概率，原样放进 fire_pack。 */
export const collectDeferredWorldbookRolls = (books: WorldbookLike[] = []): WorldbookRoll[] => books
    .filter(book => deferredRollBooks.has(book))
    .map(book => ({ id: String(book.id), probability: clamp(book.probability, 0, 100, 100) }));

/** 这段文本里有没有这条推迟条目的标记（打包时只把真渲染进去的那几条带上云）。 */
export const hasWorldbookRollMarker = (text: string, id: string): boolean => {
    const encoded = encodeURIComponent(id);
    return [...text.matchAll(/\{\{AMSG_WB_IF:([^}]*)\}\}/g)].some(m => m[1].split(',').includes(encoded));
};

/** 去掉全部推迟标记、推迟的条目一律按抽中保留（救援导回本地时用：内容宁留勿丢）。 */
export const keepAllWorldbookRolls = (text: string): string => renderWorldbookRolls(
    text,
    [...text.matchAll(/\{\{AMSG_WB_IF:([^}]*)\}\}/g)]
        .flatMap(m => m[1].split(',').map(decodeURIComponent))
        .map(id => ({ id, probability: 100 })),
);

/** 到点渲染：每条概率条目现抽一次，抽中的去掉标记保留原文，没抽中的整块去掉。 */
export const renderWorldbookRolls = (
    template: string,
    rolls: WorldbookRoll[],
    random: () => number = Math.random,
): string => {
    const hit = new Map(rolls.map(roll => [roll.id, rollWorldbookProbability(roll.probability, random)]));
    let out = template;
    // 由内向外：标题那一层包着里面的条目块。
    for (let m = ROLL_BLOCK_RE.exec(out); m; m = ROLL_BLOCK_RE.exec(out)) {
        const keep = m[1].split(',').some(id => hit.get(decodeURIComponent(id)) === true);
        out = out.slice(0, m.index) + (keep ? m[2] : '') + out.slice(m.index + m[0].length);
    }
    let lastCategory: string | null = null;
    return out.replace(ROLL_HEADER_RE, (_whole, categoryLine?: string) => {
        if (categoryLine === undefined) { lastCategory = null; return ''; }
        if (categoryLine === lastCategory) return '';
        lastCategory = categoryLine;
        return categoryLine;
    });
};

export const expandWorldbookMacros = (content: string, charName: string, userName: string): string => {
    let expanded = content;
    if (charName) expanded = expanded.replace(/{{\s*char\s*}}/gi, charName);
    if (userName) expanded = expanded.replace(/{{\s*user\s*}}/gi, userName);
    return expanded;
};

export const resolveWorldbookEntries = (
    books: WorldbookLike[] = [],
    messages: WorldbookScanMessage[] = [],
    charName = '',
    userName = '',
): ResolvedWorldbookEntry[] => books
    .filter(book => isWorldbookEntryActive(book, messages))
    .map(book => ({
        book,
        content: expandWorldbookMacros(book.content || '', charName, userName),
        position: book.position ?? 1,
        order: Number.isFinite(book.order) ? Number(book.order) : 100,
    }))
    .filter(entry => entry.content.trim())
    .sort((a, b) => a.order - b.order);

/**
 * 只取「聊天记录指定深度」的条目，交给 injectWorldbookDepthEntries 插进对话。
 * 兼容旧调用方；新 App 使用 ContextBuilder 的完整消息入口，不自行解析或插入世界书。
 */
export const resolveWorldbookDepthEntries = (
    books: WorldbookLike[] = [],
    messages: WorldbookScanMessage[] = [],
    charName = '',
    userName = '',
): ResolvedWorldbookEntry[] => resolveWorldbookEntries(books, messages, charName, userName)
    .filter(entry => entry.position === 4);

export const splitWorldbookSections = (entries: ResolvedWorldbookEntry[]): WorldbookSystemSections => ({
    beforeCharacter: entries.filter(entry => entry.position === 0),
    afterCharacter: entries.filter(entry => entry.position === 1),
    authorsNoteTop: entries.filter(entry => entry.position === 2),
    authorsNoteBottom: entries.filter(entry => entry.position === 3),
    atDepth: entries.filter(entry => entry.position === 4),
    beforeExamples: entries.filter(entry => entry.position === 5),
    afterExamples: entries.filter(entry => entry.position === 6),
});

export const formatWorldbookSection = (
    entries: ResolvedWorldbookEntry[],
    heading: string,
): string => {
    if (entries.length === 0) return '';
    // 推迟抽签的条目（见 deferWorldbookRolls）各自包上标记；标题行只依赖推迟条目时也包上，
    // 条件是「其中任一条抽中」。没有推迟条目时输出与原来逐字一致。
    const rollId = (entry: ResolvedWorldbookEntry) => (deferredRollBooks.has(entry.book) ? String(entry.book.id) : null);
    const guard = (ids: Array<string | null>, text: string) =>
        (ids.length === 0 || ids.some(id => id === null) ? text : `${rollOpen(ids as string[])}${text}${ROLL_CLOSE}`);
    // 每个分类标题管到下一个分类标题之前的那几条带标题的条目。
    const categoryRuns: Array<Array<string | null>> = [];
    let lastLegacyCategory = '';
    for (const entry of entries) {
        if (entry.book.sourceUid !== undefined) continue;
        const category = entry.book.category || '通用设定 (General)';
        if (category !== lastLegacyCategory) {
            categoryRuns.push([]);
            lastLegacyCategory = category;
        }
        categoryRuns[categoryRuns.length - 1].push(rollId(entry));
    }
    const hasDeferred = entries.some(entry => rollId(entry) !== null);
    let output = `${hasDeferred ? ROLL_SECTION : ''}### ${heading}\n`;
    lastLegacyCategory = '';
    let run = -1;
    for (const entry of entries) {
        let block = '';
        // SillyTavern comments are editor-only and are not part of the prompt.
        if (entry.book.sourceUid === undefined) {
            const category = entry.book.category || '通用设定 (General)';
            if (category !== lastLegacyCategory) {
                run += 1;
                output += guard(categoryRuns[run], `${hasDeferred ? ROLL_CATEGORY : ''}#### [${category}]\n`);
                lastLegacyCategory = category;
            }
            block += `**Title: ${entry.book.title}**\n`;
        }
        output += guard([rollId(entry)], `${block}${entry.content.trim()}\n---\n`);
    }
    return guard(entries.map(rollId), `${output}\n`);
};

export const injectWorldbookDepthEntries = <T extends WorldbookScanMessage>(
    messages: T[],
    entries: ResolvedWorldbookEntry[],
): Array<T | { role: 'system' | 'user' | 'assistant'; content: string }> => {
    if (entries.length === 0) return [...messages];
    const buckets = new Map<number, ResolvedWorldbookEntry[]>();
    for (const entry of entries) {
        const depth = Math.max(0, Math.floor(entry.book.depth ?? 4));
        const index = Math.max(0, messages.length - depth);
        const bucket = buckets.get(index) || [];
        bucket.push(entry);
        buckets.set(index, bucket);
    }

    const result: Array<T | { role: 'system' | 'user' | 'assistant'; content: string }> = [];
    for (let index = 0; index <= messages.length; index += 1) {
        const bucket = buckets.get(index) || [];
        for (const entry of bucket) {
            const roleValue = entry.book.role ?? 0;
            const role = roleValue === 1 ? 'user' : roleValue === 2 ? 'assistant' : 'system';
            result.push({ role, content: entry.content.trim() });
        }
        if (index < messages.length) result.push(messages[index]);
    }
    return result;
};

export const SULLY_WORLDBOOK_FORMAT = 'sullyos-worldbook';

export function readWorldbookEntries(parsed: Record<string, any>) {
    const marked = parsed?.format === SULLY_WORLDBOOK_FORMAT;
    if (marked && parsed.version !== 1) throw new Error('暂不支持此糯米机世界书版本，请更新后重试');
    const native = marked && 'worldbook' in parsed;
    return { native, entries: native ? parsed.worldbook?.entries : parsed?.entries };
}

export const serializeSullyWorldbook = (books: WorldbookLike[]): string => {
    const entries: Record<string, Record<string, unknown>> = {};

    books.forEach((book, index) => {
        const primary = book.key || [];
        const secondary = book.keysecondary || [];
        const position = book.position ?? 1;
        entries[String(index)] = {
            uid: book.sourceUid,
            key: [...primary],
            keysecondary: [...secondary],
            comment: book.title,
            content: book.content,
            constant: book.constant ?? primary.length === 0,
            selective: book.selective ?? secondary.length > 0,
            selectiveLogic: book.selectiveLogic ?? 0,
            order: book.order ?? 100,
            position,
            disable: book.disable === true,
            probability: book.probability ?? 100,
            useProbability: book.useProbability === true,
            depth: book.depth ?? 4,
            role: position === 4 ? (book.role ?? 0) : null,
            scanDepth: book.scanDepth ?? null,
            caseSensitive: book.caseSensitive ?? null,
            matchWholeWords: book.matchWholeWords ?? null,
            displayIndex: index,
        };
    });

    return JSON.stringify({ format: SULLY_WORLDBOOK_FORMAT, version: 1, worldbook: { entries } }, null, 2);
};

export const parseStandardWorldbook = (
    rawText: string,
    category: string,
    now = Date.now(),
): Worldbook[] => {
    const parsed = JSON.parse(rawText);
    const { native, entries } = readWorldbookEntries(parsed);
    if (!entries || typeof entries !== 'object') {
        throw new Error('找不到世界书条目，请选择糯米机或酒馆导出的世界书文件');
    }
    const rawEntries = Object.values(entries);

    const books = rawEntries.flatMap((value: any, index: number): Worldbook[] => {
        if (!value || typeof value !== 'object' || typeof value.content !== 'string') return [];
        const uid = Number.isFinite(Number(value.uid)) ? Number(value.uid) : index;
        const position = clamp(value.position, 0, 6, 1) as WorldbookPosition;
        const rawRole = value.role == null ? null : clamp(value.role, 0, 2, 0) as WorldbookDepthRole;
        return [{
            id: `wb-${now}-${index}-${Math.random().toString(36).slice(2, 8)}`,
            title: String(value.comment || value.name || `条目 ${uid + 1}`),
            content: value.content,
            category,
            createdAt: now,
            updatedAt: now,
            key: asStringArray(value.key),
            keysecondary: asStringArray(value.keysecondary),
            constant: value.constant === true,
            selective: value.selective === true,
            selectiveLogic: clamp(value.selectiveLogic, 0, 3, 0) as WorldbookSelectiveLogic,
            order: Number.isFinite(Number(value.order)) ? Number(value.order) : 100,
            position,
            disable: value.disable === true,
            probability: clamp(value.probability, 0, 100, 100),
            useProbability: value.useProbability === true,
            depth: Math.max(0, Math.floor(clamp(value.depth, 0, 999, 4))),
            role: rawRole,
            scanDepth: value.scanDepth == null ? null : Math.max(0, Math.floor(clamp(value.scanDepth, 0, 999, 4))),
            caseSensitive: value.caseSensitive == null ? null : value.caseSensitive === true,
            matchWholeWords: value.matchWholeWords == null ? null : value.matchWholeWords === true,
            // Imported editor comments and native entry titles have different prompt semantics.
            sourceUid: native && !Number.isFinite(value.uid) ? undefined : uid,
        }];
    });

    if (books.length === 0) throw new Error('世界书里没有可导入的有效条目');
    return books;
};
