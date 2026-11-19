/**
 * 把救援页导出的 `sullyos-amsg-rescue` 文件转成一份 v1 纯 JSON 备份（FullBackupData），
 * 交给「迁入为独立用户」那条现成的路导入：新建一个用户空间，不碰现有数据。
 *
 * 云端没有结构化的角色卡：角色设定、世界书、用户人设、月度总结、最近对话都只以纯文本
 * 烤在发给模型的提示词里（fire_pack.template，或即时对话那一轮 chat.messages 里的 system）。
 * 这里按 ContextBuilder.buildCoreContext / buildFirePack 写死的小标题把它拆回字段，
 * 拆不出来的部分宁可留空也不猜。各数据源和取舍见 docs/amsg2-rescue.md「导回 SullyOS」。
 */

import type { CharacterProfile, FullBackupData, MemoryFragment, Message, UserProfile, Worldbook } from '../types';
import { AMSG2_INSTANT_STUB_TEMPLATE, AMSG_SLOT_SELF_LOG } from './amsgFirePack';
import { CONTEXT_RANGE_POLICY_VERSION, DEFAULT_MANUAL_CONTEXT_LIMIT } from './chatContextRange';
import { generateAvatar } from './defaultAvatar';
import { isAnthropicEndpoint } from './llmEndpoint';
import { wallClockToTimestamp } from './timezone';
import { toMountedWorldbook } from './worldbook';

export const AMSG_RESCUE_FORMAT = 'sullyos-amsg-rescue';

type AnyRecord = Record<string, any>;

export const isAmsgRescueExport = (value: unknown): value is AnyRecord =>
    !!value && typeof value === 'object' && (value as AnyRecord).format === AMSG_RESCUE_FORMAT
    && !!(value as AnyRecord).users && typeof (value as AnyRecord).users === 'object';

// ---------- 提示词拆分 ----------

/** buildCoreContext 里角色设定之后可能紧跟的小标题；角色设定只截到它们之前。 */
const KNOWN_HEADINGS = [
    '当前时间 (Now)',
    '内在认知 (Self Insights)',
    '世界观与设定 (World Settings)',
    '扩展设定集 (Worldbooks)',
    '世界书 · ',
    '互动对象 (User)',
    '记忆系统 (Memory Bank)',
];

const indexOfNextHeading = (text: string, from: number): number => {
    let best = text.length;
    for (const heading of KNOWN_HEADINGS) {
        const at = text.indexOf(`\n### ${heading}`, from);
        if (at !== -1 && at < best) best = at;
    }
    return best;
};

/** `### 标题\n` 后面到下一个已知小标题（或 `\n\n### ` 任意小标题）之前的正文。 */
const sectionBody = (text: string, heading: string, stopAtAnyHeading = false): string | null => {
    const marker = `### ${heading}\n`;
    const start = text.indexOf(marker);
    if (start === -1) return null;
    const bodyStart = start + marker.length;
    let end = indexOfNextHeading(text, bodyStart);
    if (stopAtAnyHeading) {
        const any = text.indexOf('\n\n### ', bodyStart);
        if (any !== -1 && any < end) end = any;
    }
    return text.slice(bodyStart, end).trim();
};

const meaningful = (value: string | null | undefined): string => {
    const text = (value ?? '').trim();
    return text === '无' ? '' : text;
};

export interface ParsedRescuePrompt {
    name: string;
    description: string;
    systemPrompt: string;
    worldview: string;
    worldbookText: string;
    userName: string;
    userBio: string;
    refinedMemories: Record<string, string>;
}

/** 拆一段 buildCoreContext 拼出来的角色设定文本。认不出「你的身份」小节就返回 null。 */
export const parseRescuePrompt = (text: string): ParsedRescuePrompt | null => {
    const identity = text.indexOf('### 你的身份 (Character)\n');
    if (identity === -1) return null;
    const name = /- 名字: (.*)\n/.exec(text.slice(identity))?.[1]?.trim() ?? '';
    const description = /- 用户备注\/爱称 \(User Note\/Nickname\): (.*)\n/.exec(text.slice(identity))?.[1] ?? '';

    const instructionMarker = '- 核心性格/指令:\n';
    const instructionAt = text.indexOf(instructionMarker, identity);
    const systemPrompt = instructionAt === -1
        ? ''
        : text.slice(instructionAt + instructionMarker.length, indexOfNextHeading(text, instructionAt)).trim();

    // 世界书按出现位置分好几节，导回来合成一条常驻条目，原样保留各节标题。
    const worldbookParts: string[] = [];
    const worldbookHeading = /### (扩展设定集 \(Worldbooks\)|世界书 · [^\n]+)\n/g;
    for (let match = worldbookHeading.exec(text); match; match = worldbookHeading.exec(text)) {
        const bodyStart = match.index + match[0].length;
        const body = text.slice(bodyStart, indexOfNextHeading(text, bodyStart)).trim();
        if (body) worldbookParts.push(`### ${match[1]}\n${body}`);
    }

    const userSection = sectionBody(text, '互动对象 (User)', true) ?? '';
    const userName = /^- 名字: (.*)$/m.exec(userSection)?.[1]?.trim() ?? '';
    const bioAt = userSection.indexOf('- 设定/备注: ');
    const userBio = bioAt === -1 ? '' : userSection.slice(bioAt + '- 设定/备注: '.length);

    return {
        name,
        description: meaningful(description),
        systemPrompt,
        worldview: meaningful(sectionBody(text, '世界观与设定 (World Settings)')),
        worldbookText: worldbookParts.join('\n\n'),
        userName,
        userBio: meaningful(userBio),
        refinedMemories: parseMonthlySummaries(text),
    };
};

/** 「长期核心记忆」逐行 `- [YYYY-MM]: 总结`；总结本身换行的，后续行接到上一条。 */
export const parseMonthlySummaries = (text: string): Record<string, string> => {
    const marker = '**长期核心记忆 (Key Memories)**:\n';
    const start = text.indexOf(marker);
    if (start === -1) return {};
    const result: Record<string, string> = {};
    let current: string | null = null;
    for (const line of text.slice(start + marker.length).split('\n')) {
        const entry = /^- \[(\d{4}-\d{2})\]: ?(.*)$/.exec(line);
        if (entry) {
            current = entry[1];
            result[current] = entry[2];
            continue;
        }
        // 空行、下一个粗体小节（详细回忆）或下一个小标题：这一段结束。
        if (!line.trim() || line.startsWith('**') || line.startsWith('### ') || line.startsWith('> ') || !current) break;
        result[current] += `\n${line}`;
    }
    return result;
};

// ---------- 对话 ----------

interface RescueTurn { role: 'user' | 'assistant'; content: string; timestamp: number | null }

const TIME_PREFIX = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\] ?/;

const splitTimePrefix = (content: string, tzId?: string): { content: string; timestamp: number | null } => {
    const match = TIME_PREFIX.exec(content);
    if (!match) return { content, timestamp: null };
    const timestamp = wallClockToTimestamp(match[1], tzId);
    return { content: content.slice(match[0].length), timestamp: Number.isFinite(timestamp) ? timestamp : null };
};

/** fire_pack 模板里【最近对话上下文】那段：`【说话人】\n正文`，条与条之间空一行。 */
export const parseTemplateTranscript = (template: string, charName: string, userName: string, tzId?: string): RescueTurn[] => {
    const marker = '【最近对话上下文】\n';
    const start = template.indexOf(marker);
    if (start === -1) return [];
    const endAt = template.indexOf(AMSG_SLOT_SELF_LOG, start);
    const body = template.slice(start + marker.length, endAt === -1 ? undefined : endAt);
    if (body.trim() === '（暂时没有最近聊天记录）') return [];

    const speakers = new Map<string, RescueTurn['role'] | 'system'>([['系统', 'system']]);
    if (userName) speakers.set(userName, 'user');
    if (charName) speakers.set(charName, 'assistant'); // 同名时按角色算：模板里角色的话多

    // 只认已知说话人开头的块；正文里恰好出现的「\n\n【xx】\n」并回上一条。
    const blocks: Array<{ role: RescueTurn['role'] | 'system'; lines: string }> = [];
    for (const chunk of body.split(/\n\n(?=【[^】\n]+】\n)/)) {
        const head = /^【([^】\n]+)】\n([\s\S]*)$/.exec(chunk);
        const role = head ? speakers.get(head[1]) : undefined;
        if (head && role) blocks.push({ role, lines: head[2] });
        else if (blocks.length) blocks[blocks.length - 1].lines += `\n\n${chunk}`;
    }
    return blocks
        .filter((block): block is { role: RescueTurn['role']; lines: string } => block.role !== 'system')
        .map((block) => ({ role: block.role, ...splitTimePrefix(block.lines.trim(), tzId) }))
        .filter((turn) => turn.content);
};

const flattenContent = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part: AnyRecord) => (part?.type === 'text' ? part.text || '' : part?.type === 'image_url' ? '[图片]' : ''))
        .filter(Boolean)
        .join('\n');
};

/** 即时对话那一轮的 chat.messages：只取 user / assistant，system（设定、实时状态）不算对话。 */
const parseChatMessages = (messages: unknown[], tzId?: string): RescueTurn[] =>
    messages
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant'))
        .map((m: any) => ({ role: m.role as RescueTurn['role'], ...splitTimePrefix(flattenContent(m.content).trim(), tzId) }))
        .filter((turn) => turn.content);

/**
 * 没带时间的消息按顺序补一个：接在上一条后一分钟，且永远不早于上一条。开头就没时间的，
 * 从第一条有时间的消息（都没有就从快照时刻）往前倒推。
 */
const assignTimestamps = (turns: RescueTurn[], snapshotAt: number): Array<RescueTurn & { timestamp: number }> => {
    const firstKnown = turns.findIndex((turn) => turn.timestamp !== null);
    const anchor = firstKnown === -1 ? snapshotAt - turns.length * 60_000 : turns[firstKnown].timestamp! - firstKnown * 60_000;
    let previous = anchor - 60_000;
    return turns.map((turn) => {
        const timestamp = Math.max(turn.timestamp ?? previous + 60_000, previous + 1);
        previous = timestamp;
        return { ...turn, timestamp };
    });
};

// ---------- 凭据 ----------

/** 云端存的是完整终点地址（OpenAI 兼容会补 /chat/completions），还原成用户填的 baseUrl。 */
const credToApi = (value: AnyRecord | undefined) => {
    if (!value || typeof value.apiUrl !== 'string' || typeof value.apiKey !== 'string') return null;
    const anthropic = isAnthropicEndpoint(value.apiUrl);
    return {
        baseUrl: anthropic ? value.apiUrl : value.apiUrl.replace(/\/chat\/completions\/?$/, ''),
        apiKey: value.apiKey,
        model: String(value.primaryModel ?? ''),
        ...(anthropic ? { apiType: 'anthropic' as const } : {}),
    };
};

// ---------- 主转换 ----------

interface CharSources {
    firePack?: AnyRecord;
    toolPack?: AnyRecord;
    instantPacks: AnyRecord[];
    creds: Record<string, AnyRecord>;
    outbox: AnyRecord[];
    avatarUrl?: string;
    labels: string[];
}

const isHttpUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\//i.test(value);

const decodedValue = (row: AnyRecord, column: string): AnyRecord | undefined => {
    const cell = row?.decoded?.[column];
    return cell && (cell.status === 'decrypted' || cell.status === 'plain') && cell.value && typeof cell.value === 'object'
        ? cell.value
        : undefined;
};

const collectSources = (file: AnyRecord): Map<string, CharSources> => {
    const byChar = new Map<string, CharSources>();
    const get = (charId: string) => {
        let entry = byChar.get(charId);
        if (!entry) byChar.set(charId, entry = { instantPacks: [], creds: {}, outbox: [], labels: [] });
        return entry;
    };
    for (const user of Object.values<AnyRecord>(file.users ?? {})) {
        const clientState: AnyRecord = user?.clientState ?? {};
        for (const [namespace, entries] of Object.entries<AnyRecord>(clientState)) {
            if (namespace.startsWith('amsg:char:') && entries) {
                const sources = get(namespace.slice('amsg:char:'.length));
                if (entries.fire_pack && typeof entries.fire_pack === 'object') sources.firePack = entries.fire_pack;
                if (entries.tool_pack && typeof entries.tool_pack === 'object') sources.toolPack = entries.tool_pack;
            }
            if (namespace === 'amsg:instant-input' && entries) {
                for (const value of Object.values<AnyRecord>(entries)) {
                    if (value?.charId && value.packedFirePack && typeof value.packedFirePack === 'object') {
                        get(String(value.charId)).instantPacks.push(value.packedFirePack);
                    }
                }
            }
        }
        const tables: AnyRecord = user?.tables ?? {};
        for (const row of tables.llm_credentials ?? []) {
            const match = /^char:(.+)\/(chat|instant|emotion|memory)$/.exec(String(row?.cred_id ?? ''));
            const value = decodedValue(row, 'encrypted_value');
            if (match && value) get(match[1]).creds[match[2]] = value;
        }
        for (const row of tables.message_outbox ?? []) {
            const value = decodedValue(row, 'payload');
            const charId = value?.metadata?.charId;
            if (!charId) continue;
            const sources = get(String(charId));
            if (isHttpUrl(value.avatarUrl)) sources.avatarUrl = value.avatarUrl;
            if (value.contactName) sources.labels.push(String(value.contactName));
            if ((value.messageKind ?? 'content') === 'content' && typeof value.message === 'string') sources.outbox.push(value);
        }
        for (const row of tables.scheduled_messages ?? []) {
            const value = decodedValue(row, 'encrypted_payload');
            const charId = value?.metadata?.charId;
            if (!charId) continue;
            const sources = get(String(charId));
            if (isHttpUrl(value.avatarUrl)) sources.avatarUrl = value.avatarUrl;
            if (value.contactName) sources.labels.push(String(value.contactName));
        }
    }
    return byChar;
};

const usableTemplate = (pack: AnyRecord | undefined): string | null =>
    pack && typeof pack.template === 'string' && pack.template !== AMSG2_INSTANT_STUB_TEMPLATE ? pack.template : null;

export interface RescueImportSummary {
    characters: number;
    messages: number;
    /** 只救回名字、日记、凭据或推送消息，没有角色设定的角色名。 */
    withoutPrompt: string[];
}

/** 统计属性只取固定枚举：有设定可拆的角色是全部、部分还是一个都没有。 */
export const buildRescueImportAnalytics = (summary: RescueImportSummary): { 救回角色设定: '全部' | '部分' | '没有' } => ({
    救回角色设定: summary.withoutPrompt.length === 0 ? '全部'
        : summary.withoutPrompt.length < summary.characters ? '部分' : '没有',
});

export const rescueExportToBackup = (file: AnyRecord, nowMs = Date.now()): { backup: FullBackupData; summary: RescueImportSummary } => {
    const characters: CharacterProfile[] = [];
    const messages: Message[] = [];
    const worldbooks: Worldbook[] = [];
    const withoutPrompt: string[] = [];
    let userName = '';
    let userBio = '';
    let nextMessageId = 1;

    for (const [charId, src] of collectSources(file)) {
        const templatePack = usableTemplate(src.firePack) ? src.firePack : undefined;
        // 即时对话那一轮通常比定时快照新，有就用最新的那一份。
        const instant = src.instantPacks
            .filter((pack) => Array.isArray(pack?.chat?.messages))
            .sort((a, b) => (b.chat.builtAt ?? b.builtAt ?? 0) - (a.chat.builtAt ?? a.builtAt ?? 0))[0];
        const tzId: string | undefined = src.firePack?.tzId ?? instant?.tzId;
        const targetName: string = src.firePack?.targetName ?? instant?.targetName ?? '';

        const instantSystem = instant
            ? instant.chat.messages.map((m: AnyRecord) => (m?.role === 'system' ? flattenContent(m.content) : '')).find((text: string) => text.includes('### 你的身份 (Character)'))
            : undefined;
        const promptText = usableTemplate(templatePack) ?? usableTemplate(instant) ?? instantSystem ?? '';
        const parsed = promptText ? parseRescuePrompt(promptText) : null;

        const name = src.toolPack?.charName || parsed?.name || src.labels[0] || '救回的角色';
        if (!parsed) withoutPrompt.push(name);
        if (parsed?.userName && !userName) userName = parsed.userName;
        if (parsed?.userBio && !userBio) userBio = parsed.userBio;

        // ---- 对话：快照里的上下文 + 快照之后角色发出的推送 ----
        const instantAt = instant ? Number(instant.chat.builtAt ?? instant.builtAt ?? 0) : 0;
        const templateAt = templatePack ? Number(templatePack.builtAt ?? 0) : 0;
        const useInstant = !!instant && instantAt >= templateAt;
        const turns = useInstant
            ? parseChatMessages(instant!.chat.messages, tzId)
            : templatePack ? parseTemplateTranscript(templatePack.template, name, targetName, tzId) : [];
        const snapshotAt = (useInstant ? instantAt : templateAt) || nowMs;
        const charMessages: Array<Omit<Message, 'id'>> = assignTimestamps(turns, snapshotAt)
            .map((turn) => ({ charId, role: turn.role, type: 'text', content: turn.content, timestamp: turn.timestamp }));

        const lastSnapshotTs = charMessages.length ? Math.max(snapshotAt, charMessages[charMessages.length - 1].timestamp) : 0;
        const seenOutbox = new Set<string>();
        const outbox = src.outbox
            .map((value) => ({ value, ts: Date.parse(value.timestamp) }))
            .filter(({ value, ts }) => Number.isFinite(ts) && ts > lastSnapshotTs && !seenOutbox.has(String(value.messageId ?? ts)) && seenOutbox.add(String(value.messageId ?? ts)))
            .sort((a, b) => a.ts - b.ts || (a.value.messageIndex ?? 0) - (b.value.messageIndex ?? 0));
        for (const { value, ts } of outbox) {
            charMessages.push({ charId, role: 'assistant', type: 'text', content: value.message, timestamp: ts });
        }
        for (const message of charMessages) messages.push({ ...message, id: nextMessageId++ } as Message);

        // ---- 世界书：合成一条常驻条目挂到角色身上 ----
        const mountedWorldbooks: CharacterProfile['mountedWorldbooks'] = [];
        if (parsed?.worldbookText) {
            const book: Worldbook = {
                id: `rescue-wb-${charId}`,
                title: `${name} · 救回的世界书`,
                content: parsed.worldbookText,
                category: '救援恢复',
                constant: true,
                createdAt: nowMs,
                updatedAt: nowMs,
            };
            worldbooks.push(book);
            mountedWorldbooks.push(toMountedWorldbook(book));
        }

        const memories: MemoryFragment[] = (Array.isArray(src.toolPack?.memories) ? src.toolPack!.memories : [])
            .filter((m: AnyRecord) => m && typeof m.summary === 'string')
            .map((m: AnyRecord, index: number) => ({
                id: `rescue-${charId}-${index}`,
                date: String(m.date ?? ''),
                summary: m.summary,
                ...(m.mood ? { mood: String(m.mood) } : {}),
            }));

        const chatApi = credToApi(src.creds.chat);
        const emotionApi = credToApi(src.creds.emotion);
        const userTzId = src.firePack?.userTzId ?? instant?.userTzId;

        characters.push({
            id: charId,
            name,
            avatar: src.avatarUrl ?? generateAvatar(name),
            description: parsed?.description ?? '',
            systemPrompt: parsed?.systemPrompt ?? '',
            worldview: parsed?.worldview || undefined,
            memories,
            refinedMemories: parsed?.refinedMemories ?? {},
            activeMemoryMonths: Array.isArray(src.toolPack?.activeMemoryMonths) ? src.toolPack!.activeMemoryMonths : undefined,
            monthlyRecallEnabled: src.toolPack?.monthlyRecallEnabled,
            timeAwarenessEnabled: src.toolPack?.timeAwarenessEnabled,
            // 角色时区跟打包设备不同，才说明当初单独设过。
            ...(tzId && userTzId && tzId !== userTzId ? { customTimezoneEnabled: true, customTimezone: tzId } : {}),
            ...(mountedWorldbooks.length ? { mountedWorldbooks } : {}),
            ...(chatApi ? { dialogueApi: chatApi } : {}),
            emotionConfig: emotionApi ? { enabled: true, api: emotionApi } : { enabled: true },
            contextLimit: DEFAULT_MANUAL_CONTEXT_LIMIT,
            contextRangeMode: 'manual',
            contextRangePolicyVersion: CONTEXT_RANGE_POLICY_VERSION,
        } as CharacterProfile);
    }

    const userProfile: UserProfile = {
        name: userName || '我',
        avatar: generateAvatar(userName || '我'),
        bio: userBio,
    };
    return {
        backup: { timestamp: nowMs, version: 1, characters, messages, worldbooks, userProfile } as FullBackupData,
        summary: { characters: characters.length, messages: messages.length, withoutPrompt },
    };
};
