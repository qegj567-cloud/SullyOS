import { cloudApiCallLogId, type ApiCallLogEntry } from './apiCallLog';
import { modelCallPurpose, parseModelCalls, type AmsgModelCall } from './amsgApiCallRecords';

/** First request replaces the pending row; follow-ups receive deterministic IDs. No aggregate row remains. */
export async function settleInstantModelCalls(uuid: string, calls: AmsgModelCall[], identity?: { charId?: string; charName?: string }): Promise<void> {
    const { DB } = await import('./db');
    const parentId = cloudApiCallLogId(uuid);
    await DB.updateApiCallLog(entries => {
        const parent = entries.find(entry => entry.id === parentId) as ApiCallLogEntry | undefined;
        const replacements = calls.map((call): ApiCallLogEntry => ({
            id: call.index === 1 ? parentId : `${parentId}:call:${call.index}`,
            route: 'cloud-instant-chat', cloudCallIndex: call.index,
            timestamp: call.completedAt, pending: false, ok: call.ok, status: call.status,
            appId: parent?.appId ?? 'chat', appName: parent?.appName ?? '消息',
            charId: parent?.charId ?? identity?.charId, charName: parent?.charName ?? identity?.charName,
            baseUrl: parent?.baseUrl ?? '', presetName: parent?.presetName ?? '云端 API',
            model: parent?.model ?? call.backendModel ?? '未记录', backendModel: call.backendModel,
            purpose: modelCallPurpose(call.causes),
            promptTokens: call.promptTokens, completionTokens: call.completionTokens,
            totalTokens: call.totalTokens ?? (call.promptTokens != null && call.completionTokens != null ? call.promptTokens + call.completionTokens : undefined),
            cacheReadTokens: call.cacheReadTokens, cacheWriteTokens: call.cacheWriteTokens,
            // Only the first request has a locally captured input. Do not reuse it for expanded tool rounds.
            promptBreakdown: call.index === 1 ? parent?.promptBreakdown : undefined,
        }));
        const ids = new Set(replacements.map(entry => entry.id));
        return [...replacements, ...entries.filter(entry => !ids.has(entry.id))];
    });
}

/** Terminal failures/empty replies use the same durable outbox as other background results. */
export async function applyInstantApiCallResult(payload: unknown): Promise<boolean> {
    const value = payload as any;
    const calls = parseModelCalls(value?.calls);
    if (!calls || typeof value?.taskUuid !== 'string' || !value.taskUuid || typeof value?.charId !== 'string') return true;
    await settleInstantModelCalls(value.taskUuid, calls, { charId: value.charId, charName: typeof value.charName === 'string' ? value.charName : undefined });
    return true;
}
