/**
 * Memory Palace — 导出
 *
 * 把某个角色（或全部角色）的记忆宫殿数据打包成可读 + 可机读的 JSON，
 * 方便用户接入自己的外置记忆库。
 *
 * 导出内容：记忆节点（content/room/importance/mood/tags/时间…）、事件盒、期盼。
 *
 * 向量（includeVectors）：可选。
 *   - 关掉：文件小，但目标侧需自行重新向量化。
 *   - 打开：连 embedding 向量一起导出。**只要继续用同一个 embedding 模型 +
 *     维度**，向量可直接复用，省掉重新向量化的钱和时间、检索结果完全一致；
 *     换了模型则向量作废（vector.model / dimensions 已随每条一起导出，便于核对）。
 */

import { MemoryNodeDB, AnticipationDB, EventBoxDB, MemoryVectorDB, RoomPlateDB, plateId } from './db';
import type { MemoryNode, Anticipation, EventBox, MemoryVector, RoomPlate, PlateRoom } from './types';
import { getRoomLabel, PLATE_ROOMS, PLATE_ENTRY_CAPS } from './types';

/** 导出时随向量一起带上的元信息（便于接入方判断能否复用） */
export interface ExportedVector {
    memoryId: string;
    /** 普通 number[]，长度 = dimensions */
    vector: number[];
    dimensions: number;
    /** 生成该向量的 embedding 模型；与目标侧模型一致才可直接复用 */
    model?: string;
}

/** 单个角色的导出结构 */
export interface CharacterMemoryPalaceExport {
    charId: string;
    charName: string;
    counts: { nodes: number; eventBoxes: number; anticipations: number; vectors: number; roomPlateEntries?: number };
    /** 该角色向量统一用的 embedding 模型/维度（多数情况下整库一致，便于接入方一眼确认） */
    embeddingModels: string[];
    nodes: MemoryNode[];
    eventBoxes: EventBox[];
    anticipations: Anticipation[];
    /** 房间门牌（常驻语义层）。旧导出文件没有此字段，导入端按可选处理 */
    roomPlates?: RoomPlate[];
    /** includeVectors=false 时为 undefined */
    vectors?: ExportedVector[];
}

/** 顶层导出文件结构 */
export interface MemoryPalaceExportFile {
    type: 'sully_memory_palace_export';
    version: 1;
    exportedAt: number;
    exportedAtISO: string;
    includeVectors: boolean;
    note: string;
    characters: CharacterMemoryPalaceExport[];
}

const NOTE_WITH_VECTORS =
    'nodes 即每一条记忆，content 为正文，room 为所属房间（含义见 roomLabel）；eventBoxes 为事件盒（summaryNodeId 指向整合回忆节点）。' +
    'vectors 为 embedding 向量，按 memoryId 与 nodes 对应：只要接入方继续用同一个 embedding 模型 + 维度即可直接复用，无需重新向量化；换模型则向量作废（每条带 model/dimensions 便于核对）。';

const NOTE_NO_VECTORS =
    'nodes 即每一条记忆，content 为正文，room 为所属房间（含义见 roomLabel）；eventBoxes 为事件盒（summaryNodeId 指向整合回忆节点）。' +
    '本次未导出向量（仅文本结构），接入方需要语义检索时请在目标侧自行重新向量化。';

/** 收集单个角色的记忆宫殿数据 */
async function collectCharacter(
    charId: string,
    charName: string,
    includeVectors: boolean,
): Promise<CharacterMemoryPalaceExport> {
    const [nodes, eventBoxes, anticipations, roomPlates] = await Promise.all([
        MemoryNodeDB.getByCharId(charId),
        EventBoxDB.getByCharId(charId),
        AnticipationDB.getByCharId(charId),
        RoomPlateDB.getByCharId(charId),
    ]);

    let vectors: ExportedVector[] | undefined;
    const modelSet = new Set<string>();
    if (includeVectors) {
        // getAllByCharId 出 DB 层后向量一律是 Float32Array，转成普通 number[] 才能进 JSON
        const raw = await MemoryVectorDB.getAllByCharId(charId);
        vectors = raw.map(v => {
            if (v.model) modelSet.add(`${v.model}@${v.dimensions}d`);
            return {
                memoryId: v.memoryId,
                vector: Array.from(v.vector as Float32Array),
                dimensions: v.dimensions,
                model: v.model,
            };
        });
    }

    // 给每条记忆补一个人类可读的房间名，外置库无需自己映射枚举
    const enrichedNodes = nodes.map(n => ({ ...n, roomLabel: getRoomLabel(n.room) }));
    return {
        charId,
        charName,
        counts: {
            nodes: nodes.length,
            eventBoxes: eventBoxes.length,
            anticipations: anticipations.length,
            vectors: vectors?.length ?? 0,
            roomPlateEntries: roomPlates.reduce((s, p) => s + p.entries.length, 0),
        },
        embeddingModels: [...modelSet],
        nodes: enrichedNodes as MemoryNode[],
        eventBoxes,
        anticipations,
        roomPlates,
        vectors,
    };
}

/** 导出一个或多个角色的记忆宫殿数据为 JSON 文件结构 */
export async function exportMemoryPalace(
    chars: { id: string; name: string }[],
    options: { includeVectors?: boolean } = {},
): Promise<MemoryPalaceExportFile> {
    const includeVectors = options.includeVectors ?? false;
    const characters: CharacterMemoryPalaceExport[] = [];
    for (const c of chars) {
        characters.push(await collectCharacter(c.id, c.name, includeVectors));
    }
    const now = Date.now();
    return {
        type: 'sully_memory_palace_export',
        version: 1,
        exportedAt: now,
        exportedAtISO: new Date(now).toISOString(),
        includeVectors,
        note: includeVectors ? NOTE_WITH_VECTORS : NOTE_NO_VECTORS,
        characters,
    };
}

// ─── 导入 ─────────────────────────────────────────────
//
// 把一份导出 JSON 灌回某个目标角色的记忆宫殿（合并，不清空已有数据）。
// 所有节点/事件盒/期盼都会重新生成 ID 并改挂到目标角色，内部引用
// （事件盒↔节点、summary、predecessor、sourceId）按 ID 映射表同步重写，
// 因此同一份文件导入两次会得到两份独立副本，不会互相覆盖。

/** 导入结果统计 */
export interface ImportResult {
    nodes: number;
    eventBoxes: number;
    anticipations: number;
    vectors: number;
    /** 并入目标角色门牌的条目数（受各门牌容量上限约束，同文本去重） */
    roomPlateEntries: number;
    /** 文件里带了向量但本次因模型不符等原因未启用语义检索时的提示（保留字段，当前恒空） */
    warning?: string;
}

function genNodeId(): string {
    return `mn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function genBoxId(): string {
    return `eb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
function genAntId(): string {
    return `ant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 运行时校验：是不是一份记忆宫殿导出文件 */
export function isMemoryPalaceExportFile(data: any): data is MemoryPalaceExportFile {
    return !!data
        && data.type === 'sully_memory_palace_export'
        && Array.isArray(data.characters);
}

/**
 * 把导出文件导入到目标角色（合并）。文件里可能含多个角色，全部并入同一个
 * 目标角色。已有数据不动，新数据以全新 ID 追加。
 */
export async function importMemoryPalace(
    file: MemoryPalaceExportFile,
    targetCharId: string,
): Promise<ImportResult> {
    if (!isMemoryPalaceExportFile(file)) {
        throw new Error('文件格式不对：不是 SullyOS·糯米机 记忆宫殿导出文件');
    }

    // 跨全部角色收集老 ID → 新 ID 映射（节点 / 事件盒）
    const nodeIdMap = new Map<string, string>();
    const boxIdMap = new Map<string, string>();
    // 老 memoryId → 导出的向量，用于判断节点是否带向量
    const vectorByOldId = new Map<string, ExportedVector>();

    for (const c of file.characters) {
        for (const n of c.nodes || []) {
            if (!nodeIdMap.has(n.id)) nodeIdMap.set(n.id, genNodeId());
        }
        for (const b of c.eventBoxes || []) {
            if (!boxIdMap.has(b.id)) boxIdMap.set(b.id, genBoxId());
        }
        for (const v of c.vectors || []) {
            vectorByOldId.set(v.memoryId, v);
        }
    }

    const nodesToSave: MemoryNode[] = [];
    const vectorsToSave: MemoryVector[] = [];
    const boxesToSave: EventBox[] = [];
    const antsToSave: Anticipation[] = [];

    const remapId = (map: Map<string, string>, old?: string | null): string | undefined =>
        (old && map.has(old)) ? map.get(old)! : undefined;

    for (const c of file.characters) {
        // 节点
        for (const n of c.nodes || []) {
            const newId = nodeIdMap.get(n.id)!;
            const hasVector = vectorByOldId.has(n.id);
            // 去掉导出时附加的 roomLabel 字段，只保留 MemoryNode 自身的字段
            const { roomLabel, ...rest } = n as MemoryNode & { roomLabel?: string };
            nodesToSave.push({
                ...rest,
                id: newId,
                charId: targetCharId,
                eventBoxId: remapId(boxIdMap, n.eventBoxId),
                sourceId: remapId(nodeIdMap, n.sourceId),
                // 带向量才算已嵌入；不带向量的节点标记未嵌入，等后续重建向量
                embedded: hasVector,
            });

            if (hasVector) {
                const v = vectorByOldId.get(n.id)!;
                vectorsToSave.push({
                    memoryId: newId,
                    charId: targetCharId,
                    vector: Float32Array.from(v.vector),
                    dimensions: v.dimensions,
                    model: v.model,
                });
            }
        }

        // 事件盒
        for (const b of c.eventBoxes || []) {
            const newBoxId = boxIdMap.get(b.id)!;
            boxesToSave.push({
                ...b,
                id: newBoxId,
                charId: targetCharId,
                summaryNodeId: remapId(nodeIdMap, b.summaryNodeId) ?? null,
                liveMemoryIds: (b.liveMemoryIds || []).map(id => nodeIdMap.get(id)).filter(Boolean) as string[],
                archivedMemoryIds: (b.archivedMemoryIds || []).map(id => nodeIdMap.get(id)).filter(Boolean) as string[],
                predecessorBoxId: remapId(boxIdMap, b.predecessorBoxId),
            });
        }

        // 期盼
        for (const a of c.anticipations || []) {
            antsToSave.push({ ...a, id: genAntId(), charId: targetCharId });
        }
    }

    // 批量写入（MemoryNodeDB.saveMany 会顺带建 BM25 倒排索引）
    if (nodesToSave.length) await MemoryNodeDB.saveMany(nodesToSave);
    if (vectorsToSave.length) await MemoryVectorDB.saveMany(vectorsToSave);
    if (boxesToSave.length) await EventBoxDB.saveMany(boxesToSave);
    for (const a of antsToSave) await AnticipationDB.save(a);

    // 房间门牌：并入目标角色对应房间的门牌（合并语义——同文本去重、
    // 尊重各门牌容量上限、条目重新生成 ID；firstLearnedAt/sourceCount 原样保留）
    let plateEntriesImported = 0;
    for (const c of file.characters) {
        for (const p of c.roomPlates || []) {
            if (!(PLATE_ROOMS as string[]).includes(p.room)) continue;
            const room = p.room as PlateRoom;
            const target: RoomPlate = (await RoomPlateDB.get(targetCharId, room)) || {
                id: plateId(targetCharId, room),
                charId: targetCharId,
                room,
                entries: [],
                updatedAt: Date.now(),
                version: 0,
            };
            const seenTexts = new Set(target.entries.map(e => e.text));
            const cap = PLATE_ENTRY_CAPS[room];
            let added = 0;
            for (const entry of p.entries || []) {
                if (target.entries.length >= cap) break;
                const text = (entry.text || '').trim();
                if (!text || seenTexts.has(text)) continue;
                seenTexts.add(text);
                target.entries.push({
                    ...entry,
                    text,
                    id: `pe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                });
                added++;
            }
            if (added > 0) {
                target.updatedAt = Date.now();
                target.version += 1;
                await RoomPlateDB.save(target);
                plateEntriesImported += added;
            }
        }
    }

    return {
        nodes: nodesToSave.length,
        eventBoxes: boxesToSave.length,
        anticipations: antsToSave.length,
        vectors: vectorsToSave.length,
        roomPlateEntries: plateEntriesImported,
    };
}
