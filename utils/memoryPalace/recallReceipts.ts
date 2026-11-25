/**
 * Memory Palace — 召回回执 (Recall Receipts)
 *
 * 记录"路径①召回"每次实际注入到主聊天 prompt 的 memoryId 列表。
 * 用途：路径②extraction 处理 buffer 时，用回执反查"这段对话期间角色被
 * 喂过哪些记忆"，作为高优先级 relatedMemories 喂给 extraction LLM，
 * 让它能稳定识别"用户纠正的是哪条旧记忆"。
 *
 * 为什么需要这玩意：
 *   纠正语句和被纠正的记忆之间常常隔几十条消息（buffer 满 100 才处理），
 *   单纯靠"对最近消息做向量召回"经常漏 — 但召回时我们 100% 知道 prompt
 *   里塞了哪些记忆，把这个事实记下来就不必猜。
 *
 * 存储：localStorage，按 char 分键，环形保留最近 RECEIPT_MAX 条。
 * 体积：~600B/条 × 100 ≈ 60KB/角色，可接受。
 */

const RECEIPT_MAX = 100;
const STORAGE_KEY_PREFIX = 'os_mp_recall_receipts_';

export interface RecallReceipt {
    /** 召回发生的时间戳（ms） */
    ts: number;
    /** 当次注入到 prompt 的所有 memoryId（含事件盒展开的 summary + 活节点） */
    ids: string[];
}

function storageKey(charId: string): string {
    return `${STORAGE_KEY_PREFIX}${charId}`;
}

function readAll(charId: string): RecallReceipt[] {
    try {
        const raw = localStorage.getItem(storageKey(charId));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (r): r is RecallReceipt =>
                r && typeof r.ts === 'number' && Array.isArray(r.ids)
        );
    } catch {
        return [];
    }
}

/**
 * 读取某个时间点之后最近一次真实注入回执。
 *
 * “记忆链接”用它锁定当前回复实际经过的那一批记忆。若当前轮没有回执，
 * 必须返回 null，而不是退回更早的一轮，避免用户误改无关记忆。
 */
export function getLatestRecallReceipt(
    charId: string,
    sinceTs: number = 0,
): RecallReceipt | null {
    const list = readAll(charId);
    for (let i = list.length - 1; i >= 0; i--) {
        const receipt = list[i];
        if (receipt.ts >= sinceTs) {
            return receipt.ids.length ? { ts: receipt.ts, ids: [...receipt.ids] } : null;
        }
    }
    return null;
}

function writeAll(charId: string, receipts: RecallReceipt[]): void {
    try {
        localStorage.setItem(storageKey(charId), JSON.stringify(receipts));
    } catch (e) {
        // localStorage 写满或无权限：无声降级，回执只是辅助手段
        console.warn(`[RecallReceipts] write failed for ${charId}:`, e);
    }
}

/**
 * 记录一次召回回执。
 * 空数组直接跳过，避免回执表里塞满"召回到 0 条"的噪声。
 */
export function recordRecallReceipt(charId: string, ids: string[], options?: { replaceEmpty?: boolean }): void {
    // An accepted reroll with no recall supersedes the original turn's receipt.
    if (!charId || (!ids.length && !options?.replaceEmpty)) return;
    const list = readAll(charId);
    list.push({ ts: Date.now(), ids: [...new Set(ids)] });
    // 环形截断，保留最近 RECEIPT_MAX 条
    const trimmed = list.length > RECEIPT_MAX ? list.slice(-RECEIPT_MAX) : list;
    writeAll(charId, trimmed);
}

/**
 * 取一段时间窗口内被注入过的 memoryId，按"最后一次注入时间"倒序去重。
 *
 * 用法：extraction 处理 buffer 前，传入 buffer 首末消息的时间戳，拿到
 * 这段对话里角色实际看到过的所有记忆 id。
 *
 * @param fromTs 含端
 * @param toTs   含端；可比当前时间稍晚一点（消息时间戳和 receipt 时间戳
 *               不一定严格对齐，建议调用方加 ~10 分钟容差）
 * @param limit  返回上限（默认 50）
 */
export function getReceiptIdsInRange(
    charId: string,
    fromTs: number,
    toTs: number,
    limit: number = 50,
): string[] {
    const list = readAll(charId);
    // 按 ts 倒序遍历，保证同一 id 取的是"最后一次出现的位次"
    const seen = new Set<string>();
    const result: string[] = [];
    for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i];
        if (r.ts < fromTs || r.ts > toTs) continue;
        for (const id of r.ids) {
            if (seen.has(id)) continue;
            seen.add(id);
            result.push(id);
            if (result.length >= limit) return result;
        }
    }
    return result;
}

/** 测试/调试用：清空某角色的回执表 */
export function clearReceipts(charId: string): void {
    try {
        localStorage.removeItem(storageKey(charId));
    } catch {}
}
