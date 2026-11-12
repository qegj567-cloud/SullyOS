/**
 * 记忆日期按年 / 月 / 日局部修改工具
 *
 * 用于单条编辑与多选批量编辑：
 * - 年、月、日三个字段各自独立，留空表示保留该条记忆原有的对应字段；
 * - 仅替换填写的日历字段，保留原有的时、分、秒、毫秒，使同日多条记忆维持原有先后顺序；
 * - 批量修改先对全部选中节点做日历合法性校验，任一条产生不存在的日期（如平年 2 月 29 日）时整批拒绝，不写半份数据。
 */

import type { MemoryFragment } from '../../types';
import { MemoryNodeDB } from './db';
import type { MemoryNode, RemoteVectorConfig } from './types';

export interface PartialDateDraft {
    year: string;
    month: string;
    day: string;
}

export interface PartialDatePatch {
    year: number | null;
    month: number | null;
    day: number | null;
}

export const EMPTY_PARTIAL_DATE_DRAFT: PartialDateDraft = {
    year: '',
    month: '',
    day: '',
};

export function hasAnyPartialDateInput(draft: PartialDateDraft): boolean {
    return Boolean(draft.year.trim() || draft.month.trim() || draft.day.trim());
}

export function formatLocalDateKey(timestamp: number): string | null {
    const d = new Date(timestamp);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parsePartialDateDraft(
    draft: PartialDateDraft,
    options?: { requireAtLeastOne?: boolean },
): PartialDatePatch {
    const rawYear = draft.year.trim();
    const rawMonth = draft.month.trim();
    const rawDay = draft.day.trim();

    if (!rawYear && !rawMonth && !rawDay) {
        if (options?.requireAtLeastOne) {
            throw new Error('请至少填写年、月、日中的一项；留空的项会保留原值');
        }
        return { year: null, month: null, day: null };
    }

    let year: number | null = null;
    if (rawYear) {
        if (!/^\d{4}$/.test(rawYear)) {
            throw new Error('年份请输入 4 位数字（如 2025）');
        }
        year = Number(rawYear);
        if (year < 1900 || year > 9999) {
            throw new Error('年份范围需在 1900–9999 之间');
        }
    }

    let month: number | null = null;
    if (rawMonth) {
        if (!/^\d{1,2}$/.test(rawMonth)) {
            throw new Error('月份请输入 1–12 之间的数字');
        }
        month = Number(rawMonth);
        if (month < 1 || month > 12) {
            throw new Error('月份请输入 1–12 之间的数字');
        }
    }

    let day: number | null = null;
    if (rawDay) {
        if (!/^\d{1,2}$/.test(rawDay)) {
            throw new Error('日期请输入 1–31 之间的数字');
        }
        day = Number(rawDay);
        if (day < 1 || day > 31) {
            throw new Error('日期请输入 1–31 之间的数字');
        }
    }

    // 若同时填了月和日，先用闰年（或已填年份）拦截任何年份都不存在的月日组合（如 2 月 30 日、4 月 31 日）。
    if (month !== null && day !== null) {
        const probeYear = year ?? 2024;
        const probe = new Date(probeYear, month - 1, day, 12, 0, 0, 0);
        if (probe.getFullYear() !== probeYear || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
            throw new Error(`${year !== null ? `${year} 年 ` : ''}${month} 月没有 ${day} 日，请检查月/日输入`);
        }
    }

    return { year, month, day };
}

export function applyPartialDatePatchToTimestamp(
    createdAt: number,
    patch: PartialDatePatch,
): number {
    if (patch.year === null && patch.month === null && patch.day === null) {
        return createdAt;
    }

    const now = new Date();
    const parsedOrig = new Date(createdAt);
    const orig = Number.isNaN(parsedOrig.getTime())
        ? new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0)
        : parsedOrig;

    const targetYear = patch.year ?? orig.getFullYear();
    const targetMonth = patch.month ?? (orig.getMonth() + 1);
    const targetDay = patch.day ?? orig.getDate();

    const next = new Date(
        targetYear,
        targetMonth - 1,
        targetDay,
        orig.getHours(),
        orig.getMinutes(),
        orig.getSeconds(),
        orig.getMilliseconds(),
    );

    if (
        next.getFullYear() !== targetYear
        || next.getMonth() !== targetMonth - 1
        || next.getDate() !== targetDay
    ) {
        const origLabel = `${orig.getFullYear()}/${orig.getMonth() + 1}/${orig.getDate()}`;
        throw new Error(
            `原日期 ${origLabel} 替换后为不存在的 ${targetYear} 年 ${targetMonth} 月 ${targetDay} 日，请同时填写有效的月/日或调整选中项`,
        );
    }

    return next.getTime();
}

export function applyPartialDatePatchToNode(
    node: MemoryNode,
    patch: PartialDatePatch,
): MemoryNode {
    const nextCreatedAt = applyPartialDatePatchToTimestamp(node.createdAt, patch);
    if (nextCreatedAt === node.createdAt) return node;

    // 尚未被检索命中过的记忆（例如刚从外部导入的记录）lastAccessedAt 等于初始 createdAt；
    // 改回真实历史日期时同步调整 lastAccessedAt，让时近性衰减与真实日期一致。
    const syncLastAccessed = (node.accessCount || 0) === 0 || node.lastAccessedAt === node.createdAt;
    return {
        ...node,
        createdAt: nextCreatedAt,
        lastAccessedAt: syncLastAccessed ? nextCreatedAt : node.lastAccessedAt,
    };
}

/** 根据当前选中的节点集合推算年/月/日输入框的占位提示（全一致时展示共同值，否则展示字段名）。 */
export function getSharedDatePlaceholders(nodes: MemoryNode[]): { year: string; month: string; day: string } {
    if (nodes.length === 0) {
        return { year: '年 (YYYY)', month: '月 (1-12)', day: '日 (1-31)' };
    }
    const years = new Set<number>();
    const months = new Set<number>();
    const days = new Set<number>();
    for (const node of nodes) {
        const d = new Date(node.createdAt);
        if (Number.isNaN(d.getTime())) continue;
        years.add(d.getFullYear());
        months.add(d.getMonth() + 1);
        days.add(d.getDate());
    }
    return {
        year: years.size === 1 ? String([...years][0]) : '保留原年份',
        month: months.size === 1 ? String([...months][0]) : '保留原月份',
        day: days.size === 1 ? String([...days][0]) : '保留原日期',
    };
}

/** 将宫殿节点的日期更新同步到显式绑定了 palaceMemoryId 的神经链接档案，不触碰无绑定的历史记录。 */
export function syncLinkedArchiveFragmentDates(
    memories: MemoryFragment[] | undefined,
    updatedNodes: MemoryNode[],
): MemoryFragment[] | null {
    if (!memories || memories.length === 0 || updatedNodes.length === 0) return null;
    const dateByNodeId = new Map<string, string>();
    for (const node of updatedNodes) {
        const dateKey = formatLocalDateKey(node.createdAt);
        if (dateKey) dateByNodeId.set(node.id, dateKey);
    }
    if (dateByNodeId.size === 0) return null;

    let changed = false;
    const next = memories.map(frag => {
        if (!frag.palaceMemoryId) return frag;
        const targetDate = dateByNodeId.get(frag.palaceMemoryId);
        if (!targetDate || targetDate === frag.date) return frag;
        changed = true;
        return { ...frag, date: targetDate };
    });
    return changed ? next : null;
}

export async function batchUpdateMemoryDates(
    nodeIds: Iterable<string>,
    patch: PartialDatePatch,
    remoteVectorConfig?: RemoteVectorConfig,
): Promise<MemoryNode[]> {
    const ids = [...new Set(nodeIds)];
    if (ids.length === 0) return [];
    if (patch.year === null && patch.month === null && patch.day === null) return [];

    const loaded = await Promise.all(ids.map(id => MemoryNodeDB.getById(id)));
    const existingNodes = loaded.filter((n): n is MemoryNode => Boolean(n));
    if (existingNodes.length === 0) return [];

    // 先在内存中完成全部节点的日期校验与计算，确保任一节点日期非法时整批不写入。
    const updatedNodes = existingNodes.map(node => applyPartialDatePatchToNode(node, patch));
    const actuallyChanged = updatedNodes.filter((node, i) => (
        node.createdAt !== existingNodes[i].createdAt
        || node.lastAccessedAt !== existingNodes[i].lastAccessedAt
    ));

    if (actuallyChanged.length > 0) {
        await MemoryNodeDB.saveMany(actuallyChanged);
        MemoryNodeDB.syncRemoteMetadataMany(actuallyChanged, remoteVectorConfig);
    }

    return updatedNodes;
}
