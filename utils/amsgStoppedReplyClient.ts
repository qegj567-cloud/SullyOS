import { STOPPED_REPLY_KEY_PREFIX, stoppedReplyKey } from './amsgStoppedReply';

const KEY = 'amsg_stopped_reply_receipts_v1';

/** 单角色最多保留的待上传停止回执数（对齐云端 self_log.entries 的 8 条上限，绝不逼近 PUT /client-state 的 200 条硬限）。 */
export const MAX_STOPPED_REPLY_RECEIPTS_PER_CHAR = 8;

/** 全局最多保留的待上传停止回执总数。 */
export const MAX_STOPPED_REPLY_RECEIPTS_TOTAL = 64;

/** 本地停止回执过期时间（7 天）。 */
export const STOPPED_REPLY_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Receipt = { charId: string; uuid: string; text: string; updatedAt?: number };
const memory = new Map<string, Receipt>();
const pending = new Map<string, { charId: string; promise: Promise<string> }>();

function writeStore(receipts: Record<string, Receipt>): void {
    memory.clear();
    for (const [uuid, receipt] of Object.entries(receipts)) {
        memory.set(uuid, receipt);
    }
    try {
        if (Object.keys(receipts).length === 0) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, JSON.stringify(receipts));
    } catch (error) {
        console.warn('[instant-stop] 停止回执未能持久化', error);
    }
}

function pruneReceipts(raw: Record<string, Receipt>, now = Date.now()): { kept: Record<string, Receipt>; pruned: boolean } {
    const cutoff = now - STOPPED_REPLY_RECEIPT_TTL_MS;
    const entries = Object.entries(raw).map(([keyUuid, r], index) => ({
        uuid: r?.uuid || keyUuid,
        charId: r?.charId,
        text: typeof r?.text === 'string' ? r.text : '',
        updatedAt: typeof r?.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : undefined,
        index,
    })).filter((r): r is typeof r & { charId: string; uuid: string } =>
        Boolean(r.charId && r.uuid)
        && (pending.has(r.uuid) || r.updatedAt === undefined || r.updatedAt >= cutoff),
    );

    // 按更新时间升序（旧 → 新；无时间戳的旧数据按原顺序排在前面优先淘汰）
    entries.sort((a, b) => {
        const ta = a.updatedAt ?? 0;
        const tb = b.updatedAt ?? 0;
        return ta !== tb ? ta - tb : a.index - b.index;
    });

    // 每个角色只留最新 MAX_STOPPED_REPLY_RECEIPTS_PER_CHAR 条
    const byChar = new Map<string, typeof entries>();
    for (const entry of entries) {
        const list = byChar.get(entry.charId) ?? [];
        list.push(entry);
        byChar.set(entry.charId, list);
    }
    const perCharKept: typeof entries = [];
    for (const list of byChar.values()) {
        perCharKept.push(...list.slice(-MAX_STOPPED_REPLY_RECEIPTS_PER_CHAR));
    }

    // 全局只留最新 MAX_STOPPED_REPLY_RECEIPTS_TOTAL 条
    perCharKept.sort((a, b) => {
        const ta = a.updatedAt ?? 0;
        const tb = b.updatedAt ?? 0;
        return ta !== tb ? ta - tb : a.index - b.index;
    });
    const finalEntries = perCharKept.slice(-MAX_STOPPED_REPLY_RECEIPTS_TOTAL);

    const kept: Record<string, Receipt> = {};
    for (const entry of finalEntries) {
        kept[entry.uuid] = {
            charId: entry.charId,
            uuid: entry.uuid,
            text: entry.text,
            ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
        };
    }
    const pruned = Object.keys(kept).length !== Object.keys(raw).length;
    return { kept, pruned };
}

function read(): Record<string, Receipt> {
    let raw: Record<string, Receipt>;
    try {
        const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
        raw = {
            ...(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}),
            ...Object.fromEntries(memory),
        };
    } catch {
        raw = Object.fromEntries(memory);
    }
    const { kept, pruned } = pruneReceipts(raw);
    if (pruned) writeStore(kept);
    return kept;
}

function save(receipt: Receipt): void {
    const receipts = read();
    receipts[receipt.uuid] = { ...receipt, updatedAt: receipt.updatedAt ?? Date.now() };
    const { kept } = pruneReceipts(receipts);
    writeStore(kept);
}

/** The next turn waits only for local DB reconciliation, never for the cancellation network request. */
export function stageStoppedReplyReceipt(charId: string, uuid: string, text: Promise<string>): Promise<string> {
    save({ charId, uuid, text: '', updatedAt: Date.now() });
    const promise = text.then(value => {
        save({ charId, uuid, text: value, updatedAt: Date.now() });
        return value;
    }).finally(() => { pending.delete(uuid); });
    pending.set(uuid, { charId, promise });
    return promise;
}

export async function stoppedReplyStateEntries(charId: string): Promise<Array<{ key: string; value: string }>> {
    await Promise.all([...pending.values()].filter(entry => entry.charId === charId).map(entry => entry.promise));
    return Object.values(read()).filter(receipt => receipt.charId === charId)
        .map(receipt => ({ key: stoppedReplyKey(receipt.uuid), value: JSON.stringify({ text: receipt.text }) }));
}

/**
 * 状态包成功写上云端后销账：已随 fire_pack 落地的停止回执不再随后续每一轮重复上传。
 * 仍在等待本地落库对账（pending）或上传期间文本发生变更的回执保留到下一轮。
 */
export function ackStoppedReplyReceipts(
    entries: ReadonlyArray<{ namespace?: string; key?: string; value?: string | null }>,
    charId?: string,
): void {
    const receipts = read();
    let changed = false;
    for (const entry of entries) {
        if (typeof entry?.key !== 'string' || !entry.key.startsWith(STOPPED_REPLY_KEY_PREFIX)) continue;
        const uuid = entry.key.slice(STOPPED_REPLY_KEY_PREFIX.length);
        if (!uuid || pending.has(uuid)) continue;
        const current = receipts[uuid];
        if (!current) continue;
        if (charId && current.charId !== charId) continue;
        if (entry.namespace && entry.namespace !== `amsg:char:${current.charId}`) continue;
        if (typeof entry.value === 'string' && entry.value !== JSON.stringify({ text: current.text })) continue;
        delete receipts[uuid];
        changed = true;
    }
    if (changed) writeStore(receipts);
}

/** 清理指定角色（或全部）的本地停止回执（删角色 / 重置时调用）。 */
export function clearStoppedReplyReceipts(charId?: string): void {
    if (!charId) {
        writeStore({});
        return;
    }
    const receipts = read();
    let changed = false;
    for (const [uuid, receipt] of Object.entries(receipts)) {
        if (receipt.charId === charId) {
            delete receipts[uuid];
            changed = true;
        }
    }
    if (changed) writeStore(receipts);
}
