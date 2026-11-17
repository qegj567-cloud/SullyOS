// Wire data shared by the Worker and browser. Never include request text, arguments or credentials.
export const INSTANT_API_CALLS_RESULT_KIND = 'instant-api-calls';
const CAUSES = ['recall', 'schedule', 'search', 'diary', 'notes', 'xhs', 'mcp', 'tools'] as const;
export type AmsgCallCause = typeof CAUSES[number];
export interface AmsgModelCall {
    index: number;
    completedAt: number;
    causes: AmsgCallCause[];
    ok: boolean;
    status?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    backendModel?: string;
}

const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

export function modelCallCauses(names: string[]): AmsgCallCause[] {
    return [...new Set(names.map((name): AmsgCallCause => {
        if (name === 'recall') return 'recall';
        if (['schedule_active_message', 'cancel_active_message', 'renew_active_message', 'list_active_messages'].includes(name)) return 'schedule';
        if (name === 'web_search') return 'search';
        if (['notion_read_diary', 'feishu_read_diary'].includes(name)) return 'diary';
        if (name === 'read_note') return 'notes';
        if (name.startsWith('xhs_')) return 'xhs';
        if (name.startsWith('mcp__')) return 'mcp';
        return 'tools';
    }))];
}

export function modelCallPurpose(causes: AmsgCallCause[]): string {
    if (!causes.length) return '聊天回复';
    const labels: Record<AmsgCallCause, string> = {
        recall: '查记忆', schedule: '主动消息排程', search: '搜索', diary: '读日记',
        notes: '读笔记', xhs: '查小红书', mcp: 'MCP 工具', tools: '其他工具',
    };
    return `${causes.map(cause => labels[cause]).join('、')}后回复`;
}

export function makeModelCall(input: Pick<AmsgModelCall, 'index' | 'completedAt' | 'causes' | 'ok'> & {
    usage?: unknown; response?: unknown; status?: number;
}): AmsgModelCall {
    const response = input.response as any;
    const usage = (input.usage ?? response?.usage ?? response?.usageMetadata) as any;
    const promptTokens = count(usage?.prompt_tokens ?? usage?.input_tokens ?? usage?.promptTokenCount);
    const completionTokens = count(usage?.completion_tokens ?? usage?.output_tokens ?? usage?.candidatesTokenCount);
    return {
        index: input.index, completedAt: input.completedAt, causes: input.causes, ok: input.ok,
        ...(input.status !== undefined ? { status: input.status } : {}),
        promptTokens, completionTokens,
        totalTokens: count(usage?.total_tokens ?? usage?.totalTokenCount)
            ?? (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined),
        cacheReadTokens: count(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? usage?.cachedContentTokenCount),
        cacheWriteTokens: count(usage?.cache_creation_input_tokens ?? usage?.prompt_tokens_details?.cache_write_tokens),
        ...(typeof response?.model === 'string' && response.model ? { backendModel: response.model.slice(0, 200) } : {}),
    };
}

/** Invalid/incomplete envelopes fall back to legacy accounting; never invent per-call usage. */
export function parseModelCalls(value: unknown): AmsgModelCall[] | null {
    if (!Array.isArray(value) || !value.length || value.length > 32) return null;
    const result: AmsgModelCall[] = [];
    for (let i = 0; i < value.length; i++) {
        const row = value[i];
        if (!row || row.index !== i + 1 || !count(row.completedAt) || typeof row.ok !== 'boolean'
            || !Array.isArray(row.causes) || row.causes.length > CAUSES.length
            || row.causes.some((cause: unknown) => !CAUSES.includes(cause as AmsgCallCause))) return null;
        const clean: AmsgModelCall = { index: row.index, completedAt: row.completedAt, ok: row.ok, causes: [...new Set<AmsgCallCause>(row.causes)] };
        for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'status'] as const) {
            if (row[key] !== undefined) {
                if (count(row[key]) === undefined) return null;
                clean[key] = row[key];
            }
        }
        if (typeof row.backendModel === 'string' && row.backendModel) clean.backendModel = row.backendModel.slice(0, 200);
        result.push(clean);
    }
    return result;
}
